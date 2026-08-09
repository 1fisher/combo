use crate::backend::BackendType;
use crate::AppState;
use axum::body::Body;
use axum::extract::State;
use axum::http::{Method, StatusCode};
use axum::response::Response;
use http_body_util::BodyExt;
use serde_json::{Value, json};

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

/// 判断路径是否为 `POST /v1/workspaces/{id}/agent`(发起一次 agent 运行)。
fn is_agent_run_path(path: &str) -> bool {
    let p = path.split('?').next().unwrap_or(path);
    let segs: Vec<&str> = p.trim_start_matches('/').split('/').collect();
    segs.len() == 4 && segs[0] == "v1" && segs[1] == "workspaces" && segs[3] == "agent"
}

/// 判断路径是否为会话只读端点(messages 等)。
/// history 已由 session::history 显式路由接管,不经过此 fallback。
/// crush 离线时对这些端点返回空数组,避免前端报错。
fn is_session_read_path(path: &str) -> bool {
    let p = path.split('?').next().unwrap_or(path);
    p.contains("/sessions/") && p.ends_with("/messages")
}

/// 给 combo-cli 的 /agent 请求注入 workspace 根目录与会话历史。
/// combo-cli serve 是无状态后端:workspace_dir 供 read/write/search 工具使用,
/// history 供多轮上下文(combo sqlite 镜像中已持久化的消息)。
fn inject_history(state: &AppState, ws_id: &str, body: &[u8]) -> Vec<u8> {
    let mut v: Value = serde_json::from_slice(body).unwrap_or(Value::Object(Default::default()));

    // 注入 workspace 根目录(combo-cli 的 read/write/search 工具需要)
    if let Some(meta) = state.meta.get(ws_id) {
        v["workspace_dir"] = json!(meta.path.to_string_lossy());
    }

    // 注入会话历史
    let session_id = v.get("session_id").and_then(Value::as_str).unwrap_or("");
    if !session_id.is_empty() {
        if let Ok(msgs) = state.meta.db().list_messages(ws_id, session_id) {
            let history: Vec<Value> = msgs
                .iter()
                .map(|m| {
                    let parts: Value =
                        serde_json::from_str(&m.parts).unwrap_or(Value::Array(vec![]));
                    json!({ "role": m.role, "parts": parts })
                })
                .collect();
            v["history"] = Value::Array(history);
        }
    }
    serde_json::to_vec(&v).unwrap_or_else(|_| body.to_vec())
}

/// 反向代理 handler:按 workspace 的后端类型路由。
pub async fn proxy(State(state): State<AppState>, req: axum::extract::Request) -> Response {
    let (parts, body) = req.into_parts();
    let mut body_bytes = match body.collect().await {
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

    // combo-cli 无状态后端:POST /agent 时注入该会话的历史消息,支撑多轮上下文。
    if backend.backend_type() == BackendType::ComboCli
        && parts.method == Method::POST
        && is_agent_run_path(path_query)
    {
        body_bytes = inject_history(&state, ws_id, &body_bytes);
    }

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
            browse_root: None,
            relay: crate::RelayManager::new(),
            local_port: 0,
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

    #[test]
    fn agent_run_path_detection() {
        assert!(is_agent_run_path("/v1/workspaces/ws1/agent"));
        assert!(is_agent_run_path("/v1/workspaces/ws1/agent?client_id=x"));
        assert!(!is_agent_run_path("/v1/workspaces/ws1/agent/sessions/s1/cancel"));
        assert!(!is_agent_run_path("/v1/workspaces/ws1/sessions"));
        assert!(!is_agent_run_path("/v1/health"));
    }

    #[test]
    fn inject_history_reads_sqlite_mirror() {
        let state = AppState {
            meta: Arc::new(MetaStore::new()),
            registry: Arc::new(BackendRegistry::new(Arc::new(CrushBackend::new(
                Upstream::Tcp("127.0.0.1:1".parse().unwrap()),
            )))),
            crush_supervisor: None,
            browse_root: None,
            relay: crate::RelayManager::new(),
            local_port: 0,
        };
        state
            .meta
            .db()
            .upsert_message(
                "w1",
                "s1",
                "m1",
                "assistant",
                r#"[{"type":"text","data":{"text":"历史回答"}}]"#,
                1000,
                1000,
            )
            .unwrap();

        let body = br#"{"session_id":"s1","run_id":"r1","prompt":"continue"}"#;
        let out = inject_history(&state, "w1", body);
        let v: Value = serde_json::from_slice(&out).unwrap();
        let history = v["history"].as_array().unwrap();
        assert_eq!(history.len(), 1);
        assert_eq!(history[0]["role"], "assistant");
        assert_eq!(history[0]["parts"][0]["data"]["text"], "历史回答");
        // 本轮 prompt 不进 history
        assert_eq!(v["prompt"], "continue");
    }

    #[test]
    fn inject_history_passthrough_without_session() {
        let state = AppState {
            meta: Arc::new(MetaStore::new()),
            registry: Arc::new(BackendRegistry::new(Arc::new(CrushBackend::new(
                Upstream::Tcp("127.0.0.1:1".parse().unwrap()),
            )))),
            crush_supervisor: None,
            browse_root: None,
            relay: crate::RelayManager::new(),
            local_port: 0,
        };
        let body = br#"{"run_id":"r1","prompt":"hi"}"#;
        let out = inject_history(&state, "w1", body);
        let v: Value = serde_json::from_slice(&out).unwrap();
        assert!(v.get("history").is_none());
        assert_eq!(v["prompt"], "hi");
    }
}
