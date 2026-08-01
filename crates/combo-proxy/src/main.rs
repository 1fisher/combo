use anyhow::Result;
use combo_proxy::rune::RuneManager;
use combo_proxy::{parse_upstream, serve, Upstream};
use std::net::SocketAddr;
use tokio::net::TcpListener;

#[tokio::main]
async fn main() -> Result<()> {
    let mut args = std::env::args().skip(1);
    let mut upstream_arg = None;
    let mut port: u16 = 0;
    let mut origins = Vec::new();
    while let Some(a) = args.next() {
        match a.as_str() {
            "--upstream" => upstream_arg = Some(args.next().unwrap()),
            "--port" => port = args.next().unwrap().parse()?,
            "--origin" => origins.push(args.next().unwrap()),
            _ => {}
        }
    }
    let upstream: Upstream = match upstream_arg {
        Some(s) => parse_upstream(&s)?,
        None => {
            // 自动接管 rune 生命周期
            let mut mgr = RuneManager::new(
                std::env::var("COMBO_CRUSH_BIN").unwrap_or_else(|_| "crush".into()),
            );
            let u = mgr.ensure_running().await?;
            println!("COMBO_RUNE_STATUS=connected");
            u
        }
    };

    let listener = TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], port))).await?;
    let actual = listener.local_addr()?.port();
    println!("COMBO_PROXY_PORT={actual}");
    serve(listener, upstream, origins).await?;
    Ok(())
}
