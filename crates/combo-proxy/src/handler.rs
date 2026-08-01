use axum::body::Body;
use axum::extract::State;
use axum::http::header::{CONNECTION, CONTENT_LENGTH, HOST, TRANSFER_ENCODING};
use axum::http::StatusCode;
use axum::response::Response;
use futures_util::StreamExt;
use http_body_util::{BodyExt, Full};
use hyper_util::client::legacy::connect::HttpConnector;
use hyper_util::client::legacy::Client;
use hyper_util::rt::TokioExecutor;
use std::sync::Arc;

use crate::upstream::Upstream;

/// Reverse proxy handler: forwards every request to `upstream`,
/// streaming the response body through unchanged (SSE included).
pub async fn proxy(State(upstream): State<Arc<Upstream>>, req: axum::extract::Request) -> Response {
    match forward(upstream.as_ref(), req).await {
        Ok(resp) => resp,
        Err(err) => {
            tracing_like_error(&err);
            Response::builder()
                .status(StatusCode::BAD_GATEWAY)
                .header(axum::http::header::CONTENT_TYPE, "application/json")
                .body(Body::from(r#"{"message":"upstream unreachable"}"#))
                .unwrap()
        }
    }
}

fn tracing_like_error(_err: &anyhow::Error) {
    // The proxy is a thin pass-through; connection failures surface to the
    // client as 502. Debug logging is optional and deliberately quiet here.
}

async fn forward(upstream: &Upstream, req: axum::extract::Request) -> anyhow::Result<Response> {
    let (parts, body) = req.into_parts();
    let body_bytes = body.collect().await?.to_bytes();

    let path_query = parts
        .uri
        .path_and_query()
        .map(|x| x.as_str())
        .unwrap_or("/");
    let (uri, _scheme) = match upstream {
        // hyperlocal requires unix://<hex-encoded socket path>/<api path>
        Upstream::Unix(path) => {
            let hex_host = hex::encode(path.to_string_lossy().as_bytes());
            (format!("unix://{hex_host}{path_query}"), "unix")
        }
        Upstream::Tcp(addr) => (format!("http://{addr}{path_query}"), "http"),
    };
    let uri: axum::http::Uri = uri.parse()?;

    let mut builder = axum::http::Request::builder().method(parts.method).uri(uri);
    for (k, v) in parts.headers.iter() {
        if k == HOST || k == CONNECTION || k == CONTENT_LENGTH || k == TRANSFER_ENCODING {
            continue;
        }
        builder = builder.header(k, v.clone());
    }
    builder = builder.header("X-Forwarded-Proto", "http");
    let up_req = builder.body(Full::from(body_bytes.to_vec()))?;

    let resp: hyper::Response<hyper::body::Incoming> = match upstream {
        Upstream::Unix(_) => {
            let connector = hyperlocal::UnixConnector;
            let client: Client<_, Full<bytes::Bytes>> =
                Client::builder(TokioExecutor::new()).build(connector);
            client.request(up_req).await?
        }
        Upstream::Tcp(_) => {
            let connector = HttpConnector::new();
            let client: Client<_, Full<bytes::Bytes>> =
                Client::builder(TokioExecutor::new()).build(connector);
            client.request(up_req).await?
        }
    };

    let (rparts, rbody) = resp.into_parts();
    let mut rb = Response::builder().status(rparts.status);
    for (k, v) in rparts.headers.iter() {
        if k == CONNECTION || k == TRANSFER_ENCODING {
            continue;
        }
        rb = rb.header(k, v.clone());
    }
    let stream = rbody.into_data_stream().map(|chunk| {
        chunk.map_err(axum::Error::new)
    });
    Ok(rb.body(Body::from_stream(stream))?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::header::ACCEPT;
    use axum::http::Request;

    #[tokio::test]
    async fn proxy_returns_502_for_unreachable_upstream() {
        let upstream = Upstream::Tcp("127.0.0.1:1".parse().unwrap());
        let req = Request::builder()
            .uri("/v1/health")
            .header(ACCEPT, "application/json")
            .body(Body::empty())
            .unwrap();
        let resp = proxy(State(Arc::new(upstream)), req).await;
        assert_eq!(resp.status(), StatusCode::BAD_GATEWAY);
    }
}
