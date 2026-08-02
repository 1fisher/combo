//! Workspace CRUD handlers。combo 自己拥有 workspace 元数据。
//! 对于 crush 后端,同时转发给 crush 创建(双写)。

use crate::backend::BackendType;
use crate::AppState;
use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::Response;
use serde_json::{json, Value};

/// GET /v1/workspaces — 列出 combo 的所有 workspace。
pub async fn list(State(state): State<AppState>) -> Response {
    let workspaces = state.meta.list();
    let arr: Vec<Value> = workspaces
        .iter()
        .map(|w| {
            json!({
                "id": w.id,
                "path": w.path,
                "backend": backend_str(w.backend_type),
            })
        })
        .collect();
    json_ok(&json!(arr))
}

/// POST /v1/workspaces — 创建 workspace。
pub async fn create(
    State(state): State<AppState>,
    axum::extract::Json(body): axum::extract::Json<Value>,
) -> Response {
    let path = body.get("path").and_then(|v| v.as_str()).unwrap_or("");
    if path.is_empty() {
        return json_err(StatusCode::BAD_REQUEST, "缺少 path");
    }
    let backend = body
        .get("backend")
        .and_then(|v| v.as_str())
        .map(|s| match s {
            "opencode" => BackendType::OpenCode,
            _ => BackendType::Crush,
        })
        .unwrap_or(BackendType::Crush);

    let (ws_id, ws_path) = if backend == BackendType::Crush {
        match state.registry.by_type(BackendType::Crush) {
            Some(crush) => {
                let crush_body = serde_json::to_vec(&json!({
                    "path": path,
                    "client_id": body.get("client_id").cloned().unwrap_or_default()
                }))
                .unwrap_or_default();
                match crush
                    .forward(
                        axum::http::Method::POST,
                        "/v1/workspaces",
                        &Default::default(),
                        crush_body,
                    )
                    .await
                {
                    Ok(resp) if resp.status().is_success() => {
                        let bytes = axum::body::to_bytes(resp.into_body(), 65536)
                            .await
                            .unwrap_or_default();
                        let v: Value = serde_json::from_slice(&bytes).unwrap_or_default();
                        let id = v.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                        let p = v.get("path").and_then(|v| v.as_str()).unwrap_or(path).to_string();
                        (id, p)
                    }
                    _ => (format!("ws_{}", uuid_like()), path.to_string()),
                }
            }
            None => (format!("ws_{}", uuid_like()), path.to_string()),
        }
    } else {
        (format!("ws_{}", uuid_like()), path.to_string())
    };

    let meta = crate::WorkspaceMeta {
        id: ws_id.clone(),
        path: ws_path.clone().into(),
        backend_type: backend,
    };
    state.meta.insert(meta);

    json_ok(&json!({
        "id": ws_id,
        "path": ws_path,
        "backend": backend_str(backend),
    }))
}

/// GET /v1/workspaces/{id} — 从 MetaStore 返回。
pub async fn get(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    match state.meta.get(&id) {
        Some(w) => json_ok(&json!({
            "id": w.id,
            "path": w.path,
            "backend": backend_str(w.backend_type),
        })),
        None => json_err(StatusCode::NOT_FOUND, "workspace 不存在"),
    }
}

fn backend_str(bt: BackendType) -> &'static str {
    match bt {
        BackendType::Crush => "crush",
        BackendType::OpenCode => "opencode",
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

fn uuid_like() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{:x}", nanos)
}
