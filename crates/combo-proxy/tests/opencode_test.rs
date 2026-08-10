use axum::body::Body;
use axum::routing::{get, post};
use axum::Router;
use combo_proxy::*;
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::net::TcpListener;

/// Stub OpenCode server for testing.
async fn stub_opencode() -> std::net::SocketAddr {
    let app = Router::new()
        .route(
            "/global/health",
            get(|| async { axum::Json(json!({ "healthy": true, "version": "test" })) }),
        )
        .route(
            "/session",
            get(|| async {
                axum::Json(vec![json!({
                    "id": "ses_1",
                    "title": "Test Session",
                    "time": { "created": 1700000000000_u64, "updated": 1700000001000_u64 },
                })])
            }),
        )
        .route(
            "/session",
            post(|| async {
                axum::Json(json!({
                    "id": "ses_new",
                    "title": "New",
                    "time": { "created": 1700000000000_u64, "updated": 1700000000000_u64 },
                }))
            }),
        )
        .route(
            "/session/:id/message",
            get(|| async {
                axum::Json(vec![json!({
                    "info": {
                        "id": "msg_1",
                        "role": "assistant",
                        "sessionID": "ses_1",
                        "modelID": "claude-sonnet-4",
                        "providerID": "anthropic",
                        "time": { "created": 1700000000000_u64, "completed": 1700000001000_u64 },
                    },
                    "parts": [
                        { "type": "text", "text": "Hello!" },
                        { "type": "reasoning", "text": "thinking..." },
                    ]
                })])
            }),
        )
        .route(
            "/session/:id/prompt_async",
            post(|| async { (axum::http::StatusCode::NO_CONTENT, "") }),
        )
        .route(
            "/session/:id/abort",
            post(|| async { (axum::http::StatusCode::OK, "true") }),
        );
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    addr
}

fn make_state(oc_addr: std::net::SocketAddr) -> AppState {
    let mut registry = BackendRegistry::new();
    registry.set_opencode(Arc::new(OpenCodeBackend::new(format!("http://{}", oc_addr))));
    let meta = MetaStore::new();
    meta.insert(WorkspaceMeta {
        id: "ws_oc".into(),
        path: "/tmp/test".into(),
        name: "ws_oc".into(),
        backend_type: BackendType::OpenCode,
    });
    AppState {
        meta: Arc::new(meta),
        registry: Arc::new(registry),
        browse_root: None,
        relay: combo_proxy::RelayManager::new(),
        local_port: 0,
    }
}

#[tokio::test]
async fn opencode_health_works() {
    let addr = stub_opencode().await;
    let state = make_state(addr);
    let backend = state.registry.for_workspace("ws_oc", &state.meta).unwrap();
    assert!(backend.health().await);
}

#[tokio::test]
async fn opencode_session_list_maps_fields() {
    let addr = stub_opencode().await;
    let state = make_state(addr);
    let backend = state.registry.for_workspace("ws_oc", &state.meta).unwrap();
    let resp = backend
        .forward(
            axum::http::Method::GET,
            "/v1/workspaces/ws_oc/sessions",
            &Default::default(),
            vec![],
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), axum::http::StatusCode::OK);
    let body: Value =
        serde_json::from_slice(&axum::body::to_bytes(resp.into_body(), 65536).await.unwrap())
            .unwrap();
    let sessions = body.as_array().unwrap();
    assert_eq!(sessions[0]["id"], "ses_1");
    assert_eq!(sessions[0]["title"], "Test Session");
    assert_eq!(sessions[0]["created_at"], 1700000000);
}

#[tokio::test]
async fn opencode_history_maps_messages_and_parts() {
    let addr = stub_opencode().await;
    let state = make_state(addr);
    let backend = state.registry.for_workspace("ws_oc", &state.meta).unwrap();
    let resp = backend
        .forward(
            axum::http::Method::GET,
            "/v1/workspaces/ws_oc/sessions/ses_1/history",
            &Default::default(),
            vec![],
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), axum::http::StatusCode::OK);
    let body: Value =
        serde_json::from_slice(&axum::body::to_bytes(resp.into_body(), 65536).await.unwrap())
            .unwrap();
    let messages = body["messages"].as_array().unwrap();
    assert_eq!(messages[0]["id"], "msg_1");
    assert_eq!(messages[0]["role"], "assistant");
    let parts = messages[0]["parts"].as_array().unwrap();
    assert_eq!(parts[0]["type"], "text");
    assert_eq!(parts[0]["data"]["text"], "Hello!");
    assert_eq!(parts[1]["type"], "reasoning");
    assert_eq!(parts[1]["data"]["thinking"], "thinking...");
}

#[tokio::test]
async fn opencode_send_message_calls_prompt_async() {
    let addr = stub_opencode().await;
    let state = make_state(addr);
    let backend = state.registry.for_workspace("ws_oc", &state.meta).unwrap();
    let body = serde_json::to_vec(&json!({
        "session_id": "ses_1",
        "run_id": "run_1",
        "prompt": "hello",
    }))
    .unwrap();
    let resp = backend
        .forward(
            axum::http::Method::POST,
            "/v1/workspaces/ws_oc/agent",
            &Default::default(),
            body,
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), axum::http::StatusCode::OK);
}

#[tokio::test]
async fn opencode_cancel_calls_abort() {
    let addr = stub_opencode().await;
    let state = make_state(addr);
    let backend = state.registry.for_workspace("ws_oc", &state.meta).unwrap();
    let resp = backend
        .forward(
            axum::http::Method::POST,
            "/v1/workspaces/ws_oc/agent/sessions/ses_1/cancel",
            &Default::default(),
            vec![],
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), axum::http::StatusCode::OK);
}

#[tokio::test]
async fn opencode_sse_translates_text_delta_and_idle() {
    let sse_body = concat!(
        r#"data: {"id":"evt_1","type":"server.connected","properties":{}}"#, "\n\n",
        r#"data: {"id":"evt_2","type":"session.next.text.delta","properties":{"sessionID":"ses_1","assistantMessageID":"msg_1","textID":"txt_1","delta":"Hello "}}"#, "\n\n",
        r#"data: {"id":"evt_3","type":"session.next.text.delta","properties":{"sessionID":"ses_1","assistantMessageID":"msg_1","textID":"txt_1","delta":"World"}}"#, "\n\n",
        r#"data: {"id":"evt_4","type":"session.idle","properties":{"sessionID":"ses_1"}}"#, "\n\n",
    ).to_string();
    let app = Router::new().route(
        "/event",
        get(move || {
            let b = sse_body.clone();
            async move {
                axum::response::Response::builder()
                    .header("content-type", "text/event-stream")
                    .body(Body::from(b))
                    .unwrap()
            }
        }),
    );
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

    let state = make_state(addr);
    let backend = state.registry.for_workspace("ws_oc", &state.meta).unwrap();
    let resp = backend
        .forward(
            axum::http::Method::GET,
            "/v1/workspaces/ws_oc/events",
            &Default::default(),
            vec![],
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), axum::http::StatusCode::OK);
    let body_bytes = axum::body::to_bytes(resp.into_body(), 65536).await.unwrap();
    let body_str = String::from_utf8_lossy(&body_bytes);

    assert!(body_str.contains(r#""type":"message""#));
    assert!(body_str.contains("Hello World"));
    assert!(body_str.contains(r#""type":"run_complete""#));
}
