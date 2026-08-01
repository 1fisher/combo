use axum::body::Body;
use axum::extract::Request;
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::Response;
use axum::routing::{get, post};
use axum::Router;
use combo_proxy::{serve, Upstream};
use std::net::SocketAddr;
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
        serve(listener, Upstream::Tcp(upstream_addr), origins)
            .await
            .unwrap();
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
