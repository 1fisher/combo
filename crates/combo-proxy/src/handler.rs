use crate::AppState;
use axum::body::Body;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::Response;
use http_body_util::BodyExt;

/// 反向代理 handler:将请求转发到后端 backend,
/// 响应体流式透传(SSE 不缓冲)。
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
    match state
        .backend
        .forward(parts.method, path_query, &parts.headers, body_bytes)
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
    use crate::{CrushBackend, MetaStore, Upstream};
    use axum::http::header::ACCEPT;
    use axum::http::Request;
    use std::sync::Arc;

    #[tokio::test]
    async fn proxy_returns_502_for_unreachable_upstream() {
        let state = AppState {
            backend: Arc::new(CrushBackend::new(Upstream::Tcp(
                "127.0.0.1:1".parse().unwrap(),
            ))),
            meta: Arc::new(MetaStore::new()),
        };
        let req = Request::builder()
            .uri("/v1/health")
            .header(ACCEPT, "application/json")
            .body(Body::empty())
            .unwrap();
        let resp = proxy(State(state), req).await;
        assert_eq!(resp.status(), StatusCode::BAD_GATEWAY);
    }
}
