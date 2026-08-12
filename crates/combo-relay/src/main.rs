use combo_relay::{build_router, RelayState};
use std::net::SocketAddr;
use std::path::PathBuf;
use tracing::info;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_target(false)
        .init();

    let mut args = std::env::args().skip(1);
    let mut port: u16 = 8080;
    let mut host: std::net::IpAddr = "0.0.0.0".parse().unwrap();
    let mut static_dir: Option<PathBuf> = None;
    let mut tunnel_all = true;
    let mut origins = Vec::new();

    while let Some(a) = args.next() {
        match a.as_str() {
            "--port" => port = args.next().unwrap().parse()?,
            "--host" => host = args.next().unwrap().parse()?,
            "--static-dir" => static_dir = Some(PathBuf::from(args.next().unwrap())),
            "--tunnel-all" => tunnel_all = true,
            "--no-tunnel-all" => tunnel_all = false,
            "--origin" => origins.push(args.next().unwrap()),
            "--help" | "-h" => {
                println!("combo-relay — 中转服务器(反向隧道 + 全量代理)");
                println!();
                println!("用法: combo-relay [OPTIONS]");
                println!();
                println!("选项:");
                println!("  --port <PORT>          监听端口 (默认 8080)");
                println!("  --host <HOST>          监听地址 (默认 0.0.0.0)");
                println!("  --static-dir <DIR>     前端静态资源目录 (dist/)");
                println!("  --tunnel-all           tunnel-all 模式:无静态目录时,所有请求通过隧道转发 (默认)");
                println!("  --no-tunnel-all        禁用 tunnel-all,无静态目录时非 API 请求返回 404");
                println!("  --origin <ORIGIN>      CORS 白名单 (可多次指定,缺省全开放)");
                println!("  -h, --help             显示帮助");
                println!();
                println!("部署模式:");
                println!("  1. 静态托管:combo-relay --static-dir dist/");
                println!("     中转服务器直接提供前端,API 通过隧道转发到桌面端");
                println!("  2. 全量代理:combo-relay (默认 tunnel-all)");
                println!("     所有请求(含前端)通过隧道转发到桌面端 combo-cli serve");
                println!("     桌面端需以 --static-dir 启动,或在 Tauri 应用中自动配置");
                std::process::exit(0);
            }
            _ => {}
        }
    }

    // 环境变量回退
    if static_dir.is_none() {
        if let Ok(d) = std::env::var("COMBO_STATIC_DIR") {
            static_dir = Some(PathBuf::from(d));
        }
    }
    if origins.is_empty() {
        if let Ok(o) = std::env::var("COMBO_CORS_ORIGINS") {
            origins = o.split(',').map(|s| s.trim().to_string()).collect();
        }
    }

    let state = RelayState::default();
    let app = build_router(state, static_dir.clone(), tunnel_all, origins);

    let addr = SocketAddr::new(host, port);
    let listener = tokio::net::TcpListener::bind(addr).await?;
    let actual_port = listener.local_addr()?.port();

    info!("combo-relay 启动: http://{host}:{actual_port}");
    if let Some(ref dir) = static_dir {
        info!("  静态资源: {}", dir.display());
    } else if tunnel_all {
        info!("  模式: tunnel-all(所有请求通过隧道转发到桌面端)");
    } else {
        info!("  静态资源: 未配置(仅 API 中转)");
    }
    info!("  隧道端点: ws://{host}:{actual_port}/v1/relay/tunnel?token=<access_token>");

    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .await?;

    Ok(())
}
