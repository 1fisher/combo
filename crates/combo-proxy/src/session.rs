//! 会话镜像:combo 自己接管 `/v1/workspaces/{id}/sessions` 的
//! 列表/创建/删除,把 rune 的 session 镜像到本地 sqlite(conversations)。
//! 列表直接从 sqlite 读,不依赖 rune 在线;创建/删除仍转发给 rune,
//! 成功后双写本地镜像。

use crate::backend::BackendType;
use crate::db::ConversationMeta;
use crate::AppState;
use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::{Method, StatusCode};
use axum::response::Response;
use serde_json::{json, Value};

/// GET /v1/workspaces/{id}/sessions — 从 sqlite 读镜像列表。
pub async fn list(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    match state.meta.db().list_conversations(&id) {
        Ok(convs) => {
            let arr: Vec<Value> = convs.iter().map(session_json).collect();
            json_ok(&json!(arr))
        }
        Err(e) => json_err(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("读取会话列表失败: {e}"),
        ),
    }
}

/// POST /v1/workspaces/{id}/sessions — 转发 rune,成功后写入 sqlite 镜像。
pub async fn create(
    State(state): State<AppState>,
    Path(id): Path<String>,
    axum::extract::Json(body): axum::extract::Json<Value>,
) -> Response {
    let Some(backend) = state.registry.by_type(BackendType::Crush) else {
        return json_err(StatusCode::BAD_GATEWAY, "crush 后端不可用");
    };
    // crush 为内存态,重启后会遗忘 workspace:先确保已注册(必要时重建)
    let Some(effective_id) = crate::workspace::ensure_ws(&state, &id).await else {
        return json_err(
            StatusCode::NOT_FOUND,
            "workspace 在 crush 中不存在且注册失败",
        );
    };
    let body_bytes = serde_json::to_vec(&body).unwrap_or_default();
    let resp = match backend
        .forward(
            Method::POST,
            &format!("/v1/workspaces/{effective_id}/sessions"),
            &axum::http::HeaderMap::new(),
            body_bytes,
        )
        .await
    {
        Ok(r) => r,
        Err(e) => {
            return json_err(
                StatusCode::BAD_GATEWAY,
                &format!("转发创建会话失败: {e}"),
            );
        }
    };
    let status = resp.status();
    let bytes = match axum::body::to_bytes(resp.into_body(), 65536).await {
        Ok(b) => b.to_vec(),
        Err(_) => Vec::new(),
    };
    if status.is_success() {
        // rune 返回创建后的 session,镜像到 sqlite
        if let Ok(v) = serde_json::from_slice::<Value>(&bytes) {
            mirror_session(&state, &effective_id, &v);
        }
    }
    Response::builder()
        .status(status)
        .header("content-type", "application/json")
        .body(Body::from(bytes))
        .unwrap_or_else(|_| json_err(StatusCode::INTERNAL_SERVER_ERROR, "响应构造失败"))
}

/// DELETE /v1/workspaces/{id}/sessions/{sid} — 先删本地 sqlite 镜像,
/// 再尽力转发 rune。会话列表以 sqlite 为准,确保 rune 离线时也能删除。
pub async fn delete(
    State(state): State<AppState>,
    Path((id, sid)): Path<(String, String)>,
) -> Response {
    // 先删除本地 sqlite 镜像(会话列表的真正数据源)+ 该会话的消息
    let _ = state.meta.db().delete_conversation(&sid);
    let _ = state.meta.db().delete_messages_by_session(&id, &sid);

    // 尽力转发给 rune(rune 可能已不持有该会话,忽略其返回)
    if let Some(backend) = state.registry.by_type(BackendType::Crush) {
        if let Some(effective_id) = crate::workspace::ensure_ws(&state, &id).await {
            let _ = backend
                .forward(
                    Method::DELETE,
                    &format!("/v1/workspaces/{effective_id}/sessions/{sid}"),
                    &axum::http::HeaderMap::new(),
                    Vec::new(),
                )
                .await;
        }
    }

    json_ok(&json!({ "deleted": true }))
}

/// 把 rune 返回的 session JSON 镜像进 sqlite。字段缺失时用默认值兜底。
fn mirror_session(state: &AppState, workspace_id: &str, v: &Value) {
    let meta = ConversationMeta {
        id: v.get("id").and_then(|x| x.as_str()).unwrap_or_default().into(),
        workspace_id: workspace_id.into(),
        title: v.get("title").and_then(|x| x.as_str()).unwrap_or("会话").into(),
        message_count: v.get("message_count").and_then(|x| x.as_i64()).unwrap_or(0),
        created_at: v.get("created_at").and_then(|x| x.as_i64()).unwrap_or_else(now_secs),
        updated_at: v.get("updated_at").and_then(|x| x.as_i64()).unwrap_or_else(now_secs),
    };
    if meta.id.is_empty() {
        return;
    }
    let _ = state.meta.db().upsert_conversation(&meta);
}

/// 序列化为与 rune `proto.Session` 兼容的 JSON(前端类型依赖这些字段)。
fn session_json(c: &ConversationMeta) -> Value {
    json!({
        "id": c.id,
        "title": c.title,
        "message_count": c.message_count,
        "prompt_tokens": 0,
        "completion_tokens": 0,
        "cost": 0,
        "created_at": c.created_at,
        "updated_at": c.updated_at,
    })
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// GET /v1/workspaces/{id}/sessions/{sid}/history — 从 sqlite 读消息历史。
/// 不再依赖 crush 在线,消息持久化在 combo 本地。
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
