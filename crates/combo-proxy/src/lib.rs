pub mod backend;
pub mod control;
pub mod db;
pub mod fs;
pub mod git;
pub mod handler;
pub mod host;
pub mod manager;
pub mod meta;
pub mod rune;
pub mod registry;
pub mod router;
pub mod session;
pub mod skills;
pub mod terminal;
pub mod upstream;
pub mod workspace;

pub use backend::claude_code::ClaudeCodeBackend;
pub use backend::codex::CodexBackend;
pub use backend::crush::CrushBackend;
pub use backend::opencode::OpenCodeBackend;
pub use backend::{Backend, BackendType};
pub use db::{ComboDb, ConversationMeta, StoredMessage, default_db_path};
pub use manager::opencode::OpenCodeManager;
pub use meta::{MetaStore, WorkspaceMeta};
pub use registry::BackendRegistry;
pub use router::build_router;
pub use rune::RuneManager;
pub use upstream::Upstream;

use std::path::PathBuf;
use std::sync::Arc;

/// 所有 axum handler 共享的应用状态。
#[derive(Clone)]
pub struct AppState {
    pub meta: Arc<MetaStore>,
    pub registry: Arc<BackendRegistry>,
    /// crush 进程守护器(仅当 combo 托管 crush 生命周期时存在)。
    /// 后台监控和 HTTP control 端点通过它重启 crush。
    pub crush_supervisor: Option<Arc<RuneManager>>,
    /// 服务器目录浏览的根限制(`/v1/host/*`);None 表示允许浏览整个文件系统。
    pub browse_root: Option<PathBuf>,
}

/// Parses a `--upstream` argument into an [`Upstream`].
/// Bare paths are unix sockets; `tcp://host:port` is a TCP upstream.
pub fn parse_upstream(s: &str) -> anyhow::Result<Upstream> {
    if let Some(rest) = s.strip_prefix("tcp://") {
        Ok(Upstream::Tcp(rest.parse()?))
    } else {
        Ok(Upstream::Unix(std::path::PathBuf::from(s)))
    }
}

/// Runs the proxy on `listener`.
pub async fn serve(
    listener: tokio::net::TcpListener,
    state: AppState,
    allowed_origins: Vec<String>,
) -> anyhow::Result<()> {
    let app = build_router(state, allowed_origins);
    axum::serve(listener, app).await?;
    Ok(())
}

#[cfg(test)]
mod parse_tests {
    use super::*;

    #[test]
    fn parses_unix_path() {
        match parse_upstream("/tmp/crush.sock").unwrap() {
            Upstream::Unix(p) => assert_eq!(p, std::path::PathBuf::from("/tmp/crush.sock")),
            _ => panic!("expected unix"),
        }
    }

    #[test]
    fn parses_tcp_addr() {
        match parse_upstream("tcp://127.0.0.1:1234").unwrap() {
            Upstream::Tcp(a) => assert_eq!(a.to_string(), "127.0.0.1:1234"),
            _ => panic!("expected tcp"),
        }
    }
}
