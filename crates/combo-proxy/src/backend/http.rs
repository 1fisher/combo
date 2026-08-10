//! 后端共用的上游 HTTP 转发机制(TCP 与 Unix socket)。
//! 供 ComboCliBackend 等透明转发后端复用。

use crate::upstream::Upstream;
use anyhow::Result;
use axum::body::Body;
use axum::http::header::{CONNECTION, CONTENT_LENGTH, HOST, TRANSFER_ENCODING};
use axum::http::{HeaderMap, Method};
use axum::response::Response;
use futures_util::StreamExt;
use http_body_util::{BodyExt, Full};
use hyper_util::client::legacy::connect::HttpConnector;
use hyper_util::client::legacy::Client;
use hyper_util::rt::TokioExecutor;

/// 长生命周期的 HTTP 客户端,持有连接池。
/// 每次 forward 调用 clone 它(仅 Arc 引用计数递增,开销极低),
/// 确保连接池在 SSE 响应体完整消费前不被 drop。
pub enum ProxyClient {
    Unix(Client<hyperlocal::UnixConnector, Full<bytes::Bytes>>),
    Tcp(Client<HttpConnector, Full<bytes::Bytes>>),
}

impl ProxyClient {
    pub fn for_upstream(upstream: &Upstream) -> Self {
        match upstream {
            Upstream::Unix(_) => {
                let connector = hyperlocal::UnixConnector;
                let c = Client::builder(TokioExecutor::new())
                    .pool_idle_timeout(Some(std::time::Duration::from_secs(120)))
                    .build(connector);
                ProxyClient::Unix(c)
            }
            Upstream::Tcp(_) => {
                let mut connector = HttpConnector::new();
                connector.set_keepalive(Some(std::time::Duration::from_secs(60)));
                connector.set_nodelay(true);
                let c = Client::builder(TokioExecutor::new())
                    .pool_idle_timeout(Some(std::time::Duration::from_secs(120)))
                    .build(connector);
                ProxyClient::Tcp(c)
            }
        }
    }

    /// 向 upstream 发送请求并原样透传响应(SSE 流式不缓冲)。
    pub async fn forward(
        &self,
        upstream: &Upstream,
        method: Method,
        path_query: &str,
        headers: &HeaderMap,
        body_bytes: Vec<u8>,
    ) -> Result<Response> {
        let (uri, _scheme) = match upstream {
            Upstream::Unix(path) => {
                let hex_host = hex::encode(path.to_string_lossy().as_bytes());
                (format!("unix://{hex_host}{path_query}"), "unix")
            }
            Upstream::Tcp(addr) => (format!("http://{addr}{path_query}"), "http"),
        };
        let uri: axum::http::Uri = uri.parse()?;

        let mut builder = axum::http::Request::builder().method(method).uri(uri);
        for (k, v) in headers.iter() {
            if k == HOST || k == CONNECTION || k == CONTENT_LENGTH || k == TRANSFER_ENCODING {
                continue;
            }
            builder = builder.header(k, v.clone());
        }
        builder = builder.header("X-Forwarded-Proto", "http");
        let up_req = builder.body(Full::from(body_bytes))?;

        // 使用长生命周期的 Client(clone 仅 Arc 引用计数递增),
        // 确保连接池在响应体流式消费期间不被回收。
        let resp: hyper::Response<hyper::body::Incoming> = match self {
            ProxyClient::Unix(c) => c.request(up_req).await?,
            ProxyClient::Tcp(c) => c.request(up_req).await?,
        };

        let (rparts, rbody) = resp.into_parts();
        let mut rb = Response::builder().status(rparts.status);
        for (k, v) in rparts.headers.iter() {
            if k == CONNECTION || k == TRANSFER_ENCODING {
                continue;
            }
            rb = rb.header(k, v.clone());
        }
        let stream = rbody.into_data_stream().map(|chunk| chunk.map_err(axum::Error::new));
        Ok(rb.body(Body::from_stream(stream))?)
    }

    /// GET /v1/health 健康探测。
    pub async fn check_health(&self, upstream: &Upstream) -> bool {
        let uri = match upstream {
            Upstream::Unix(path) => {
                let hex_host = hex::encode(path.to_string_lossy().as_bytes());
                format!("unix://{hex_host}/v1/health")
            }
            Upstream::Tcp(addr) => format!("http://{addr}/v1/health"),
        };
        let uri: hyper::Uri = match uri.parse() {
            Ok(u) => u,
            Err(_) => return false,
        };
        let req = match hyper::Request::builder()
            .uri(uri)
            .body(Full::new(bytes::Bytes::new()))
        {
            Ok(r) => r,
            Err(_) => return false,
        };
        let resp = match self {
            ProxyClient::Unix(c) => c.request(req).await,
            ProxyClient::Tcp(c) => c.request(req).await,
        };
        match resp {
            Ok(r) => r.status().is_success(),
            Err(_) => false,
        }
    }
}
