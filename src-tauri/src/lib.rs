use serde::Serialize;
use tauri::Emitter;

#[derive(Clone, Serialize)]
pub struct ProxyReady {
    pub port: u16,
}

#[derive(Clone, Serialize)]
pub struct RuneStatus {
    pub connected: bool,
}

pub const EVENT_PROXY_READY: &str = "proxy-ready";
pub const EVENT_RUNE_STATUS: &str = "rune-status";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                init_backend(&handle).await;
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

async fn init_backend(app: &tauri::AppHandle) {
    use combo_proxy::rune::RuneManager;
    use combo_proxy::{serve, Upstream};
    use std::net::SocketAddr;
    use tokio::net::TcpListener;

    let bin = std::env::var("COMBO_CRUSH_BIN").unwrap_or_else(|_| "crush".into());
    let mut mgr = RuneManager::new(bin);
    let upstream = match mgr.ensure_running().await {
        Ok(u) => {
            let _ = app.emit(EVENT_RUNE_STATUS, RuneStatus { connected: true });
            u
        }
        Err(e) => {
            eprintln!("rune server failed: {e:?}");
            let _ = app.emit(EVENT_RUNE_STATUS, RuneStatus { connected: false });
            // 用不可达 TCP 地址保持代理存活,UI 显示断开
            Upstream::Tcp("127.0.0.1:1".parse().unwrap())
        }
    };
    let listener = match TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0))).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("proxy bind failed: {e:?}");
            return;
        }
    };
    let port = listener.local_addr().map(|a| a.port()).unwrap_or(0);
    let origins = vec![
        "tauri://localhost".to_string(),
        "http://localhost:5173".to_string(),
    ];
    let _ = app.emit(EVENT_PROXY_READY, ProxyReady { port });
    if let Err(e) = serve(listener, upstream, origins).await {
        eprintln!("proxy exited: {e:?}");
    }
}
