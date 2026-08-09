use crate::backend::http::ProxyClient;
use crate::backend::{Backend, BackendType};
use crate::upstream::Upstream;
use anyhow::Result;
use axum::http::{HeaderMap, Method};
use axum::response::Response;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

/// ComboCli 后端:对 combo-cli serve 进程做透明转发。
///
/// combo-cli serve 提供 rune 兼容的 agent/events 端点;会话/历史由
/// combo-proxy 的 sqlite 镜像负责(见 handler.rs 的 history 注入)。
/// upstream 每次请求实时解析:combo-cli 崩溃重启后端口会变,
/// 由 ComboCliManager 更新共享地址单元格,后端随之生效。
pub struct ComboCliBackend {
    resolve: Arc<dyn Fn() -> Upstream + Send + Sync>,
}

impl ComboCliBackend {
    /// 固定 upstream(测试/静态地址场景)。
    pub fn new(upstream: Upstream) -> Self {
        Self {
            resolve: Arc::new(move || upstream.clone()),
        }
    }

    /// 随 ComboCliManager 重启实时解析地址(托管场景)。
    pub fn new_resolving(addr: Arc<Mutex<Option<std::net::SocketAddr>>>) -> Self {
        Self {
            resolve: Arc::new(move || {
                addr.lock()
                    .unwrap()
                    .map(Upstream::Tcp)
                    .unwrap_or_else(|| Upstream::Tcp("127.0.0.1:1".parse().unwrap()))
            }),
        }
    }
}

#[async_trait::async_trait]
impl Backend for ComboCliBackend {
    fn backend_type(&self) -> BackendType {
        BackendType::ComboCli
    }

    async fn forward(
        &self,
        method: Method,
        path_query: &str,
        headers: &HeaderMap,
        body: Vec<u8>,
    ) -> Result<Response> {
        let upstream = (self.resolve)();
        let client = ProxyClient::for_upstream(&upstream);
        client
            .forward(&upstream, method, path_query, headers, body)
            .await
    }

    /// combo-cli 不感知 workspace;根目录由 MetaStore 解析(与 opencode 等一致)。
    async fn workspace_root(&self, _id: &str) -> Result<PathBuf> {
        anyhow::bail!("ComboCli workspace_root should be resolved from MetaStore")
    }

    async fn health(&self) -> bool {
        let upstream = (self.resolve)();
        let client = ProxyClient::for_upstream(&upstream);
        client.check_health(&upstream).await
    }
}
