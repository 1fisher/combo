use std::net::SocketAddr;
use tokio::net::TcpStream;
use anyhow::Result;

/// Where the proxy forwards requests to.
#[derive(Clone, Debug)]
pub enum Upstream {
    Unix(std::path::PathBuf),
    Tcp(SocketAddr),
}

/// A connected stream to the upstream, either over a Unix socket or TCP.
pub enum UpstreamStream {
    Unix(tokio::net::UnixStream),
    Tcp(TcpStream),
}

impl Upstream {
    pub async fn connect(&self) -> Result<UpstreamStream> {
        match self {
            Upstream::Unix(path) => {
                let s = tokio::net::UnixStream::connect(path).await?;
                Ok(UpstreamStream::Unix(s))
            }
            Upstream::Tcp(addr) => {
                let s = TcpStream::connect(addr).await?;
                Ok(UpstreamStream::Tcp(s))
            }
        }
    }
}
