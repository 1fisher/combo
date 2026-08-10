use serde::Serialize;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{Emitter, Manager};

#[derive(Clone, Serialize)]
pub struct ProxyReady {
    pub port: u16,
}

#[derive(Clone, Serialize)]
pub struct RuneStatus {
    pub connected: bool,
}

/// 在 Tauri state 中存储 proxy 端口,供前端 invoke 主动查询,
/// 消除 proxy-ready 事件的竞态(webview JS 注册 listener 前 emit 丢失)。
#[derive(Default)]
pub struct ProxyPort(Mutex<Option<u16>>);

pub const EVENT_PROXY_READY: &str = "proxy-ready";
pub const EVENT_RUNE_STATUS: &str = "rune-status";

#[tauri::command]
fn get_proxy_port(state: tauri::State<ProxyPort>) -> Option<u16> {
    *state.0.lock().unwrap()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(ProxyPort::default())
        .invoke_handler(tauri::generate_handler![get_proxy_port])
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
    use combo_proxy::combocli::ComboCliManager;
    use combo_proxy::{serve, AppState, BackendRegistry, ClaudeCodeBackend, CodexBackend, ComboCliBackend, MetaStore, OpenCodeBackend, OpenCodeManager, RelayManager};
    use std::net::SocketAddr;
    use std::sync::Arc;
    use tokio::net::TcpListener;

    let mut registry = BackendRegistry::new();

    // 默认 agent:combo-cli serve(本机自有 agent)。
    let combo_cli_mgr = Arc::new(ComboCliManager::new(
        std::env::var("COMBO_CLI_BIN").unwrap_or_else(|_| combo_proxy::combocli::DEFAULT_BIN.into()),
    ));
    match combo_cli_mgr.ensure_running().await {
        Ok(_) => {
            registry.set_combo_cli(Arc::new(ComboCliBackend::new_resolving(
                combo_cli_mgr.addr_shared(),
            )));
            let _ = app.emit(EVENT_RUNE_STATUS, RuneStatus { connected: true });
        }
        Err(e) => {
            eprintln!("combo-cli serve failed: {e:?}");
            let _ = app.emit(EVENT_RUNE_STATUS, RuneStatus { connected: false });
        }
    }

    // 可选:启动 OpenCode 后端
    if let Ok(oc_bin) = std::env::var("COMBO_OPENCODE_BIN") {
        let mut oc_mgr = OpenCodeManager::new(oc_bin);
        match oc_mgr.ensure_running().await {
            Ok(url) => {
                registry.set_opencode(Arc::new(OpenCodeBackend::new(url)));
            }
            Err(e) => {
                eprintln!("opencode server failed: {e:?}");
            }
        }
    }

    // 可选:启动 Claude Code 后端
    if let Ok(cc_bin) = std::env::var("COMBO_CLAUDE_BIN") {
        registry.set_claude_code(Arc::new(ClaudeCodeBackend::new(cc_bin)));
    }

    // 可选:启动 Codex 后端
    if let Ok(cx_bin) = std::env::var("COMBO_CODEX_BIN") {
        registry.set_codex(Arc::new(CodexBackend::new(cx_bin)));
    }

    // 绑定地址:默认 127.0.0.1(仅本地);域名部署时可设 COMBO_HOST=0.0.0.0 对外开放。
    let bind_host: std::net::IpAddr = std::env::var("COMBO_HOST")
        .ok()
        .and_then(|h| h.trim().parse().ok())
        .unwrap_or([127, 0, 0, 1].into());
    let listener = match TcpListener::bind(SocketAddr::from((bind_host, 0))).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("proxy bind failed: {e:?}");
            return;
        }
    };
    let port = listener.local_addr().map(|a| a.port()).unwrap_or(0);

    let state = AppState {
        meta: Arc::new(MetaStore::open_default().unwrap_or_else(|_| MetaStore::new())),
        registry: Arc::new(registry),
        browse_root: std::env::var("COMBO_BROWSE_ROOT")
            .ok()
            .filter(|s| !s.trim().is_empty())
            .map(PathBuf::from),
        relay: RelayManager::new(),
        local_port: port,
    };

    // 启动时迁移遗留的 crush 类型 workspace 到 combo-cli。
    combo_proxy::workspace::reconcile_all(&state).await;

    // 后台健康监控:combo-cli 崩溃时自动重启
    {
        let mgr = Arc::clone(&combo_cli_mgr);
        let app_h = app.clone();
        let mut was_healthy = mgr.is_healthy().await;
        tauri::async_runtime::spawn(async move {
            use std::time::Duration;
            loop {
                tokio::time::sleep(Duration::from_secs(5)).await;
                let now_healthy = mgr.is_healthy().await;
                if !now_healthy {
                    eprintln!("combo-cli 健康检查失败,尝试重启...");
                    match mgr.ensure_running().await {
                        Ok(_) => {
                            eprintln!("combo-cli 重启成功");
                            if !was_healthy {
                                let _ = app_h
                                    .emit(EVENT_RUNE_STATUS, RuneStatus { connected: true });
                            }
                            was_healthy = true;
                        }
                        Err(e) => {
                            eprintln!("combo-cli 重启失败: {e}");
                            if was_healthy {
                                let _ = app_h.emit(
                                    EVENT_RUNE_STATUS,
                                    RuneStatus { connected: false },
                                );
                            }
                            was_healthy = false;
                        }
                    }
                } else if !was_healthy {
                    was_healthy = true;
                    let _ = app_h.emit(EVENT_RUNE_STATUS, RuneStatus { connected: true });
                }
            }
        });
    }

    // 存入 Tauri state,前端可通过 get_proxy_port command 主动查询
    if let Some(state) = app.try_state::<ProxyPort>() {
        *state.0.lock().unwrap() = Some(port);
    }
    let origins = vec![
        "tauri://localhost".to_string(),
        "http://localhost:5173".to_string(),
    ];
    // emit 事件(兼容已有逻辑),同时持续重发以覆盖前端 listener 注册竞态
    let _ = app.emit(EVENT_PROXY_READY, ProxyReady { port });
    let app_clone = app.clone();
    tauri::async_runtime::spawn(async move {
        use std::time::Duration;
        for _ in 0..20 {
            tokio::time::sleep(Duration::from_millis(500)).await;
            let _ = app_clone.emit(EVENT_PROXY_READY, ProxyReady { port });
        }
    });
    if let Err(e) = serve(listener, state, origins).await {
        eprintln!("proxy exited: {e:?}");
    }
}
