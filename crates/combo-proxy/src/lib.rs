pub mod backend;
pub mod fs;
pub mod handler;
pub mod meta;
pub mod registry;
pub mod rune;
pub mod router;
pub mod upstream;

pub use backend::crush::CrushBackend;
pub use backend::{Backend, BackendType};
pub use meta::{MetaStore, WorkspaceMeta};
pub use registry::BackendRegistry;
pub use router::build_router;
pub use upstream::Upstream;

use std::sync::Arc;

/// 所有 axum handler 共享的应用状态。
#[derive(Clone)]
pub struct AppState {
    pub meta: Arc<MetaStore>,
    pub registry: Arc<BackendRegistry>,
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
