use crate::backend::{Backend, BackendType};
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
use std::path::PathBuf;

/// 长生命周期的 HTTP 客户端,持有连接池。
/// 每次 forward 调用 clone 它(仅 Arc 引用计数递增,开销极低),
/// 确保连接池在 SSE 响应体完整消费前不被 drop。
enum ProxyClient {
    Unix(Client<hyperlocal::UnixConnector, Full<bytes::Bytes>>),
    Tcp(Client<HttpConnector, Full<bytes::Bytes>>),
}

/// Crush (rune) 后端:对运行中的 crush server 做透明转发。
/// 持有 `Upstream`(Unix socket 或 TCP 地址)和长生命周期的 HTTP 客户端,
/// 所有 trait 方法直接代理 HTTP 请求。
pub struct CrushBackend {
    upstream: Upstream,
    client: ProxyClient,
}

impl CrushBackend {
    pub fn new(upstream: Upstream) -> Self {
        let client = match &upstream {
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
        };
        Self { upstream, client }
    }

    /// 底层 upstream 地址(供健康状态报告用)。
    pub fn upstream(&self) -> &Upstream {
        &self.upstream
    }
}

#[async_trait::async_trait]
impl Backend for CrushBackend {
    fn backend_type(&self) -> BackendType {
        BackendType::Crush
    }

    async fn forward(
        &self,
        method: Method,
        path_query: &str,
        headers: &HeaderMap,
        body: Vec<u8>,
    ) -> Result<Response> {
        forward_to_upstream(&self.upstream, &self.client, method, path_query, headers, body).await
    }

    async fn workspace_root(&self, id: &str) -> Result<PathBuf> {
        let pq = format!("/v1/workspaces/{id}");
        let resp = self
            .forward(Method::GET, &pq, &HeaderMap::new(), Vec::new())
            .await?;
        let status = resp.status();
        let bytes = axum::body::to_bytes(resp.into_body(), 1024 * 1024)
            .await
            .map_err(|e| anyhow::anyhow!("读取 workspace 响应失败: {e}"))?;
        if !status.is_success() {
            anyhow::bail!("查询 workspace 返回 {status}");
        }
        let v: serde_json::Value = serde_json::from_slice(&bytes)?;
        let path = v
            .get("path")
            .and_then(|p| p.as_str())
            .ok_or_else(|| anyhow::anyhow!("workspace 响应缺少 path 字段"))?;
        Ok(PathBuf::from(path))
    }

    async fn health(&self) -> bool {
        check_health(&self.upstream, &self.client).await
    }
}

/// 向 upstream 发送请求并原样透传响应(SSE 流式不缓冲)。
/// 使用长生命周期的 Client 保持连接池存活,防止 SSE 流提前断开。
async fn forward_to_upstream(
    upstream: &Upstream,
    client: &ProxyClient,
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
    let resp: hyper::Response<hyper::body::Incoming> = match client {
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
async fn check_health(upstream: &Upstream, client: &ProxyClient) -> bool {
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
    let resp = match client {
        ProxyClient::Unix(c) => c.request(req).await,
        ProxyClient::Tcp(c) => c.request(req).await,
    };
    match resp {
        Ok(r) => r.status().is_success(),
        Err(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::StatusCode;
    use axum::routing::get;
    use axum::Router;

    /// 启动一个内存 stub upstream,提供 /v1/health 和 /v1/workspaces/:id。
    async fn stub_upstream(ws_path: String) -> std::net::SocketAddr {
        let app = Router::new()
            .route(
                "/v1/health",
                get(|| async { (StatusCode::OK, "ok") }),
            )
            .route(
                "/v1/workspaces/:id",
                get(move || async move {
                    axum::Json(serde_json::json!({ "id": "w1", "path": ws_path }))
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        addr
    }

    #[tokio::test]
    async fn crush_forward_proxies_health_endpoint() {
        let addr = stub_upstream("/tmp".into()).await;
        let backend = CrushBackend::new(Upstream::Tcp(addr));
        assert!(backend.health().await);
        let resp = backend
            .forward(Method::GET, "/v1/health", &HeaderMap::new(), Vec::new())
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn crush_workspace_root_resolves_path() {
        let addr = stub_upstream("/custom/path".into()).await;
        let backend = CrushBackend::new(Upstream::Tcp(addr));
        let root = backend.workspace_root("w1").await.unwrap();
        assert_eq!(root, PathBuf::from("/custom/path"));
    }

    #[tokio::test]
    async fn crush_health_returns_false_for_dead_upstream() {
        let backend = CrushBackend::new(Upstream::Tcp("127.0.0.1:1".parse().unwrap()));
        assert!(!backend.health().await);
    }

    #[test]
    fn crush_backend_type_is_crush() {
        let backend = CrushBackend::new(Upstream::Tcp("127.0.0.1:1".parse().unwrap()));
        assert_eq!(backend.backend_type(), BackendType::Crush);
    }
}
