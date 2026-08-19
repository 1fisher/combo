//! 会话管理:combo 自己接管 `/v1/workspaces/{id}/sessions` 的
//! 列表/创建/删除,数据持久化在本地 sqlite(conversations 表)。

use crate::serve::AppState;
use crate::store::ConversationMeta;
use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::Response;
use serde_json::{json, Value};

/// GET /v1/workspaces/{id}/sessions — 从 sqlite 读会话列表。
/// 同一 path 可能有多个别名 ID,会话可能挂在任一别名下,
/// 因此按 path 解析全部别名 ID 后合并查询。
pub async fn list(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    let ws_ids: Vec<String> = match state.meta.get(&id) {
        Some(meta) => {
            let target_path = meta.path.to_string_lossy().to_string();
            state
                .meta
                .list()
                .into_iter()
                .filter(|w| w.path.to_string_lossy() == target_path)
                .map(|w| w.id)
                .collect()
        }
        None => vec![id.clone()],
    };
    match state.meta.db().list_conversations_multi(&ws_ids) {
        Ok(convs) => {
            let arr: Vec<Value> = convs
                .iter()
                .map(|c| session_json(c, state.runs.is_busy(&c.id)))
                .collect();
            json_ok(&json!(arr))
        }
        Err(e) => json_err(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("读取会话列表失败: {e}"),
        ),
    }
}

/// POST /v1/workspaces/{id}/sessions — 本地 sqlite 直接创建会话。
pub async fn create(
    State(state): State<AppState>,
    Path(id): Path<String>,
    axum::extract::Json(body): axum::extract::Json<Value>,
) -> Response {
    // 确保 workspace 存在
    if state.meta.get(&id).is_none() {
        return json_err(StatusCode::NOT_FOUND, "workspace 不存在");
    }

    let title = body
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or("会话")
        .to_string();
    let now = now_secs();
    let conv = ConversationMeta {
        id: crate::workspace::uuid_like(),
        workspace_id: id.clone(),
        title,
        message_count: 0,
        created_at: now,
        updated_at: now,
        prompt_tokens: 0,
        completion_tokens: 0,
        cost: 0.0,
        context_tokens: 0,
        context_window: 0,
        api_calls: 0,
    };
    match state.meta.db().upsert_conversation(&conv) {
        Ok(_) => json_ok(&session_json(&conv, false)),
        Err(e) => json_err(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("创建会话失败: {e}"),
        ),
    }
}

/// DELETE /v1/workspaces/{id}/sessions/{sid} — 删除本地 sqlite 镜像 + 该会话的消息。
pub async fn delete(
    State(state): State<AppState>,
    Path((id, sid)): Path<(String, String)>,
) -> Response {
    let _ = state.meta.db().delete_conversation(&sid);
    let _ = state.meta.db().delete_messages_by_session(&id, &sid);
    // 回收该会话的服务端内存态:任务清单与未被回答的问题条目
    // (否则会随会话增删无限累积)。
    state.todos.clear(&sid);
    state.questions.cancel_pending(&sid);
    json_ok(&json!({ "deleted": true }))
}

/// PATCH /v1/workspaces/{id}/sessions/{sid} — 重命名会话标题(仅更新 sqlite)。
pub async fn rename(
    State(state): State<AppState>,
    Path((id, sid)): Path<(String, String)>,
    axum::extract::Json(body): axum::extract::Json<Value>,
) -> Response {
    let title = body.get("title").and_then(|v| v.as_str()).map(|s| s.trim());
    let Some(title) = title.filter(|s| !s.is_empty()) else {
        return json_err(StatusCode::BAD_REQUEST, "title 不能为空");
    };
    match state.meta.db().rename_conversation(&sid, title) {
        Ok(()) => match state.meta.db().list_conversations(&id) {
            Ok(convs) => {
                if let Some(c) = convs.iter().find(|c| c.id == sid) {
                    json_ok(&session_json(c, state.runs.is_busy(&sid)))
                } else {
                    json_err(StatusCode::NOT_FOUND, "会话不存在")
                }
            }
            Err(e) => json_err(
                StatusCode::INTERNAL_SERVER_ERROR,
                &format!("读取会话失败: {e}"),
            ),
        },
        Err(e) => json_err(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("重命名会话失败: {e}"),
        ),
    }
}

fn session_json(c: &ConversationMeta, is_busy: bool) -> Value {
    json!({
        "id": c.id,
        "title": c.title,
        "message_count": c.message_count,
        "prompt_tokens": c.prompt_tokens,
        "completion_tokens": c.completion_tokens,
        "cost": c.cost,
        "context_tokens": c.context_tokens,
        "context_window": c.context_window,
        "api_calls": c.api_calls,
        "created_at": c.created_at,
        "updated_at": c.updated_at,
        "is_busy": is_busy,
    })
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// GET /v1/workspaces/{id}/sessions/{sid}/history — 从 sqlite 读消息历史。
pub async fn history(
    State(state): State<AppState>,
    Path((id, sid)): Path<(String, String)>,
) -> Response {
    match state.meta.db().list_messages(&id, &sid) {
        Ok(msgs) => {
            let arr: Vec<Value> = msgs
                .iter()
                .map(|m| {
                    let parts: Value =
                        serde_json::from_str(&m.parts).unwrap_or(Value::Array(vec![]));
                    json!({
                        "id": m.id,
                        "session_id": sid,
                        "role": m.role,
                        "parts": parts,
                        "model": "",
                        "provider": "",
                        "created_at": m.created_at,
                        "updated_at": m.updated_at,
                    })
                })
                .collect();
            json_ok(&json!(arr))
        }
        Err(e) => json_err(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("读取消息历史失败: {e}"),
        ),
    }
}

/// POST /v1/workspaces/{id}/sessions/{sid}/messages — 写入/更新单条消息到 sqlite。
/// 前端在收到 SSE message 事件后 fire-and-forget 调用此端点做持久化。
pub async fn upsert_msg(
    State(state): State<AppState>,
    Path((id, sid)): Path<(String, String)>,
    axum::extract::Json(msg): axum::extract::Json<Value>,
) -> Response {
    let mid = msg.get("id").and_then(|x| x.as_str()).unwrap_or_default().to_string();
    if mid.is_empty() {
        return json_err(StatusCode::BAD_REQUEST, "消息缺少 id");
    }
    let role = msg
        .get("role")
        .and_then(|x| x.as_str())
        .unwrap_or("assistant")
        .to_string();
    let parts = msg.get("parts").unwrap_or(&Value::Array(vec![])).to_string();
    let created_at = msg.get("created_at").and_then(|x| x.as_i64()).unwrap_or_else(now_secs);
    let updated_at = msg.get("updated_at").and_then(|x| x.as_i64()).unwrap_or_else(now_secs);

    match state
        .meta
        .db()
        .upsert_message(&id, &sid, &mid, &role, &parts, created_at, updated_at)
    {
        Ok(_) => json_ok(&json!({ "ok": true })),
        Err(e) => json_err(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("保存消息失败: {e}"),
        ),
    }
}

fn json_ok(v: &Value) -> Response {
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "application/json")
        .body(Body::from(v.to_string()))
        .unwrap()
}

fn json_err(status: StatusCode, msg: &str) -> Response {
    Response::builder()
        .status(status)
        .header("content-type", "application/json")
        .body(Body::from(json!({ "message": msg }).to_string()))
        .unwrap()
}
