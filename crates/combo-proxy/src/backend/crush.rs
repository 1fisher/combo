use crate::backend::http::ProxyClient;
use crate::backend::{Backend, BackendType};
use crate::upstream::Upstream;
use anyhow::Result;
use axum::http::{HeaderMap, Method};
use axum::response::Response;
use std::path::PathBuf;

/// Crush (rune) 后端:对运行中的 crush server 做透明转发。
/// 持有 `Upstream`(Unix socket 或 TCP 地址)和长生命周期的 HTTP 客户端,
/// 所有 trait 方法直接代理 HTTP 请求。
pub struct CrushBackend {
    upstream: Upstream,
    client: ProxyClient,
}

impl CrushBackend {
    pub fn new(upstream: Upstream) -> Self {
        let client = ProxyClient::for_upstream(&upstream);
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
        self.client
            .forward(&self.upstream, method, path_query, headers, body)
            .await
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
        self.client.check_health(&self.upstream).await
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
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        addr
    }

    #[tokio::test]
    async fn crush_health_returns_false_for_dead_upstream() {
        let backend = CrushBackend::new(Upstream::Tcp("127.0.0.1:1".parse().unwrap()));
        assert!(!backend.health().await);
    }

    #[tokio::test]
    async fn crush_backend_type_is_crush() {
        let backend = CrushBackend::new(Upstream::Tcp("127.0.0.1:1".parse().unwrap()));
        assert_eq!(backend.backend_type(), BackendType::Crush);
    }

    #[tokio::test]
    async fn crush_workspace_root_resolves_path() {
        let addr = stub_upstream("/tmp/ws".into()).await;
        let backend = CrushBackend::new(Upstream::Tcp(addr));
        let root = backend.workspace_root("w1").await.unwrap();
        assert_eq!(root, PathBuf::from("/tmp/ws"));
    }

    #[tokio::test]
    async fn crush_forward_proxies_health_endpoint() {
        let addr = stub_upstream("/tmp/ws".into()).await;
        let backend = CrushBackend::new(Upstream::Tcp(addr));
        assert!(backend.health().await);
    }
}
