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

/// DELETE /v1/workspaces/{id}/sessions/{sid} — 转发 rune,成功后删镜像。
pub async fn delete(
    State(state): State<AppState>,
    Path((id, sid)): Path<(String, String)>,
) -> Response {
    let Some(backend) = state.registry.by_type(BackendType::Crush) else {
        return json_err(StatusCode::BAD_GATEWAY, "crush 后端不可用");
    };
    let Some(effective_id) = crate::workspace::ensure_ws(&state, &id).await else {
        return json_err(
            StatusCode::NOT_FOUND,
            "workspace 在 crush 中不存在且注册失败",
        );
    };
    let resp = match backend
        .forward(
            Method::DELETE,
            &format!("/v1/workspaces/{effective_id}/sessions/{sid}"),
            &axum::http::HeaderMap::new(),
            Vec::new(),
        )
        .await
    {
        Ok(r) => r,
        Err(e) => {
            return json_err(
                StatusCode::BAD_GATEWAY,
                &format!("转发删除会话失败: {e}"),
            );
        }
    };
    let status = resp.status();
    if status.is_success() {
        let _ = state.meta.db().delete_conversation(&sid);
    }
    let bytes = match axum::body::to_bytes(resp.into_body(), 65536).await {
        Ok(b) => b.to_vec(),
        Err(_) => Vec::new(),
    };
    Response::builder()
        .status(status)
        .header("content-type", "application/json")
        .body(Body::from(bytes))
        .unwrap_or_else(|_| json_err(StatusCode::INTERNAL_SERVER_ERROR, "响应构造失败"))
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
