pub mod handler;
pub mod router;
pub mod upstream;

pub use router::build_router;
pub use upstream::Upstream;

/// Runs the proxy on `listener`, forwarding to `upstream`.
pub async fn serve(
    listener: tokio::net::TcpListener,
    upstream: Upstream,
    allowed_origins: Vec<String>,
) -> anyhow::Result<()> {
    let app = build_router(upstream, allowed_origins);
    axum::serve(listener, app).await?;
    Ok(())
}
