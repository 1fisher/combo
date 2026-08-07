use crate::AppState;
use axum::body::Body;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::Response;
use http_body_util::BodyExt;

/// 从 URL path 中提取 workspace_id。
/// 路径格式:/v1/workspaces/{id}/...  →  返回 {id}
fn extract_workspace_id(path: &str) -> Option<&str> {
    let segments: Vec<&str> = path.trim_start_matches('/').split('/').collect();
    if segments.len() >= 3 && segments[0] == "v1" && segments[1] == "workspaces" {
        Some(segments[2])
    } else {
        None
    }
}

/// 判断路径是否为会话只读端点(messages 等)。
/// history 已由 session::history 显式路由接管,不经过此 fallback。
/// crush 离线时对这些端点返回空数组,避免前端报错。
fn is_session_read_path(path: &str) -> bool {
    let p = path.split('?').next().unwrap_or(path);
    p.contains("/sessions/") && p.ends_with("/messages")
}

/// 反向代理 handler:按 workspace 的后端类型路由。
pub async fn proxy(State(state): State<AppState>, req: axum::extract::Request) -> Response {
    let (parts, body) = req.into_parts();
    let body_bytes = match body.collect().await {
        Ok(c) => c.to_bytes().to_vec(),
        Err(e) => {
            return Response::builder()
                .status(StatusCode::BAD_REQUEST)
                .body(Body::from(format!("invalid body: {e}")))
                .unwrap();
        }
    };
    let path_query = parts
        .uri
        .path_and_query()
        .map(|x| x.as_str())
        .unwrap_or("/");

    let ws_id = extract_workspace_id(path_query).unwrap_or("");

    // crush 为内存态,重启后会遗忘 workspace:先确保已注册(必要时重建),
    // 若 id 发生变化则把 path_query 中的旧 id 替换为新 id。
    let effective_path_query = if !ws_id.is_empty() {
        match crate::workspace::ensure_ws(&state, ws_id).await {
            Some(eid) if eid != ws_id => path_query.replacen(ws_id, &eid, 1),
            Some(_) => path_query.to_string(),
            None => {
                // crush 不可用/workspace 元数据丢失时,对会话历史等只读端点
                // 返回空数据而非 404,避免前端报"workspace 不存在或已被删除"
                if is_session_read_path(path_query) {
                    return Response::builder()
                        .status(StatusCode::OK)
                        .header(axum::http::header::CONTENT_TYPE, "application/json")
                        .body(Body::from("[]"))
                        .unwrap();
                }
                return Response::builder()
                    .status(StatusCode::NOT_FOUND)
                    .header(axum::http::header::CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        r#"{"message":"workspace 不存在或已被删除"}"#,
                    ))
                    .unwrap();
            }
        }
    } else {
        path_query.to_string()
    };

    let backend = state.registry.for_workspace(ws_id, &state.meta);

    match backend
        .forward(parts.method, &effective_path_query, &parts.headers, body_bytes)
        .await
    {
        Ok(resp) => resp,
        Err(_err) => Response::builder()
            .status(StatusCode::BAD_GATEWAY)
            .header(axum::http::header::CONTENT_TYPE, "application/json")
            .body(Body::from(r#"{"message":"upstream unreachable"}"#))
            .unwrap(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{BackendRegistry, CrushBackend, MetaStore, Upstream};
    use axum::http::header::ACCEPT;
    use axum::http::Request;
    use std::sync::Arc;

    #[tokio::test]
    async fn proxy_returns_502_for_unreachable_upstream() {
        let state = AppState {
            meta: Arc::new(MetaStore::new()),
            registry: Arc::new(BackendRegistry::new(Arc::new(CrushBackend::new(
                Upstream::Tcp("127.0.0.1:1".parse().unwrap()),
            )))),
            crush_supervisor: None,
        };
        let req = Request::builder()
            .uri("/v1/health")
            .header(ACCEPT, "application/json")
            .body(Body::empty())
            .unwrap();
        let resp = proxy(State(state), req).await;
        assert_eq!(resp.status(), StatusCode::BAD_GATEWAY);
    }

    #[test]
    fn extract_workspace_id_parses_valid_path() {
        assert_eq!(
            extract_workspace_id("/v1/workspaces/ws1/sessions"),
            Some("ws1")
        );
        assert_eq!(extract_workspace_id("/v1/workspaces/ws1"), Some("ws1"));
        assert_eq!(extract_workspace_id("/v1/health"), None);
    }
}
