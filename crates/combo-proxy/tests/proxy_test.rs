use axum::body::Body;
use axum::extract::Request;
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::Response;
use axum::routing::{get, post};
use axum::Router;
use combo_proxy::{serve, AppState, BackendRegistry, CrushBackend, MetaStore, Upstream};
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::net::TcpListener;

/// In-memory stub upstream echoing request method + path.
async fn stub_upstream() -> (SocketAddr, tokio::task::JoinHandle<()>) {
    let app = Router::new()
        .route(
            "/v1/health",
            get(|| async { (StatusCode::OK, "upstream-ok") }),
        )
        .route(
            "/v1/echo",
            post(|req: Request<Body>| async move {
                let path = req.uri().path().to_string();
                (StatusCode::OK, format!("echo:{path}"))
            }),
        )
        .route(
            "/v1/stream",
            get(|| async {
                use futures_util::stream;
                use std::convert::Infallible;
                let s = stream::iter([
                    Ok::<_, Infallible>(bytes::Bytes::from_static(b"data: {\"a\":1}\n\n")),
                    Ok::<_, Infallible>(bytes::Bytes::from_static(b"data: {\"a\":2}\n\n")),
                ]);
                Response::builder()
                    .header(header::CONTENT_TYPE, "text/event-stream")
                    .body(Body::from_stream(s))
                    .unwrap()
            }),
        )
        .route(
            "/v1/err",
            get(|| async {
                (
                    StatusCode::BAD_REQUEST,
                    axum::Json(serde_json::json!({ "message": "bad" })),
                )
            }),
        );
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let handle = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (addr, handle)
}

async fn start_proxy(upstream_addr: SocketAddr, origins: Vec<String>) -> SocketAddr {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let proxy_addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let state = AppState {
            meta: Arc::new(MetaStore::new()),
            registry: Arc::new(BackendRegistry::new(Arc::new(CrushBackend::new(
                Upstream::Tcp(upstream_addr),
            )))),
            crush_supervisor: None,
            browse_root: None,
        };
        serve(listener, state, origins).await.unwrap();
    });
    proxy_addr
}

#[tokio::test]
async fn forwards_path_and_method() {
    let (upstream, _h) = stub_upstream().await;
    let proxy = start_proxy(upstream, vec![]).await;

    let resp = reqwest::Client::new()
        .get(format!("http://{proxy}/v1/health"))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    assert_eq!(resp.text().await.unwrap(), "upstream-ok");

    let resp = reqwest::Client::new()
        .post(format!("http://{proxy}/v1/echo"))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.text().await.unwrap(), "echo:/v1/echo");
}

#[tokio::test]
async fn upstream_unreachable_returns_502() {
    let dead: SocketAddr = "127.0.0.1:1".parse().unwrap();
    let proxy = start_proxy(dead, vec![]).await;
    let resp = reqwest::Client::new()
        .get(format!("http://{proxy}/v1/health"))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::BAD_GATEWAY);
}

#[tokio::test]
async fn sse_passthrough_streams_both_chunks() {
    let (upstream, _h) = stub_upstream().await;
    let proxy = start_proxy(upstream, vec![]).await;

    let resp = reqwest::Client::new()
        .get(format!("http://{proxy}/v1/stream"))
        .header(header::ACCEPT, "text/event-stream")
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let ct = resp
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    assert!(ct.starts_with("text/event-stream"));
    let body = resp.text().await.unwrap();
    assert!(body.contains("data: {\"a\":1}"));
    assert!(body.contains("data: {\"a\":2}"));
}

#[tokio::test]
async fn upstream_4xx_passes_through() {
    let (upstream, _h) = stub_upstream().await;
    let proxy = start_proxy(upstream, vec![]).await;
    let resp = reqwest::Client::new()
        .get(format!("http://{proxy}/v1/err"))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    let j: serde_json::Value = resp.json().await.unwrap();
    assert_eq!(j["message"], "bad");
}

#[tokio::test]
async fn cors_echoes_allowed_origin_and_rejects_others() {
    let (upstream, _h) = stub_upstream().await;
    let origins = vec!["http://localhost:5173".to_string()];
    let proxy = start_proxy(upstream, origins).await;

    let resp = reqwest::Client::new()
        .get(format!("http://{proxy}/v1/health"))
        .header(header::ORIGIN, HeaderValue::from_static("http://localhost:5173"))
        .send()
        .await
        .unwrap();
    let acao = resp
        .headers()
        .get(header::ACCESS_CONTROL_ALLOW_ORIGIN)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    assert_eq!(acao, "http://localhost:5173");

    let resp = reqwest::Client::new()
        .get(format!("http://{proxy}/v1/health"))
        .header(header::ORIGIN, HeaderValue::from_static("http://evil.example"))
        .send()
        .await
        .unwrap();
    // tower-http CORS passes the request through but omits the
    // allow-origin header, which is what makes browsers block it.
    assert_eq!(resp.status(), StatusCode::OK);
    assert!(
        resp.headers()
            .get(header::ACCESS_CONTROL_ALLOW_ORIGIN)
            .is_none(),
        "disallowed origin must not receive access-control-allow-origin"
    );
}

#[tokio::test]
async fn file_service_lists_reads_writes_and_blocks_traversal() {
    // 准备一个临时 workspace 目录
    let ws = std::env::temp_dir().join(format!("combo-fs-test-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&ws);
    std::fs::create_dir_all(ws.join("sub")).unwrap();
    std::fs::write(ws.join("hello.txt"), "hi there").unwrap();
    std::fs::write(ws.join("sub").join("nested.txt"), "nested").unwrap();

    // stub upstream:fs 服务与 workspace 元数据分离,不再需要回 workspace 元信息
    let (upstream, handle) = stub_upstream().await;
    let proxy = start_proxy(upstream, vec![]).await;
    let client = reqwest::Client::new();

    // 通过 combo 元数据接口注册 workspace 路径(fs 服务依赖 MetaStore 解析目录)
    let ws_path = ws.to_string_lossy().to_string();
    let resp = client
        .post(format!("http://{proxy}/v1/workspaces"))
        .json(&serde_json::json!({ "path": ws_path }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let ws_json: serde_json::Value = resp.json().await.unwrap();
    let wid = ws_json["id"].as_str().unwrap().to_string();
    let base = format!("http://{proxy}/v1/workspaces/{wid}/files");

    // 列目录:文件与目录都在,目录排前
    let resp = client.get(format!("{base}/list")).send().await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let entries: serde_json::Value = resp.json().await.unwrap();
    let names: Vec<&str> = entries
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["name"].as_str().unwrap())
        .collect();
    assert!(names.contains(&"hello.txt"));
    assert!(names.contains(&"sub"));
    assert_eq!(entries[0]["type"].as_str().unwrap(), "dir");
    assert_eq!(entries[0]["path"].as_str().unwrap(), "sub");

    // 读文件
    let resp = client
        .get(format!("{base}/content"))
        .query(&[("path", "hello.txt")])
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let body: serde_json::Value = resp.json().await.unwrap();
    assert_eq!(body["content"].as_str().unwrap(), "hi there");

    // 写文件(覆盖)
    let resp = client
        .put(format!("{base}/content"))
        .query(&[("path", "hello.txt")])
        .json(&serde_json::json!({ "content": "updated" }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    assert_eq!(std::fs::read_to_string(ws.join("hello.txt")).unwrap(), "updated");

    // 目录穿越与绝对路径被拒
    let resp = client
        .get(format!("{base}/content"))
        .query(&[("path", "../evil.txt")])
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);

    let resp = client
        .get(format!("{base}/list"))
        .query(&[("path", "/etc")])
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);

    // 不存在文件
    let resp = client
        .get(format!("{base}/content"))
        .query(&[("path", "missing.txt")])
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);

    std::fs::remove_dir_all(&ws).unwrap();
    handle.abort();
}

