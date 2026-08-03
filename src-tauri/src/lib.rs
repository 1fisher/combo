use serde::Serialize;
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
    use combo_proxy::rune::RuneManager;
    use combo_proxy::{serve, AppState, BackendRegistry, ClaudeCodeBackend, CodexBackend, CrushBackend, MetaStore, OpenCodeBackend, OpenCodeManager, Upstream};
    use std::net::SocketAddr;
    use std::sync::Arc;
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

    let mut registry = BackendRegistry::new(Arc::new(CrushBackend::new(upstream)));

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

    let state = AppState {
        meta: Arc::new(MetaStore::open_default().unwrap_or_else(|_| MetaStore::new())),
        registry: Arc::new(registry),
    };

    // crush 为内存态,重启后 workspace 会被遗忘:启动时把元数据库里的
    // workspace 重新注册/对齐,否则转发到 crush 的请求会 404。
    let failed = combo_proxy::workspace::reconcile_all(&state).await;
    if failed > 0 {
        eprintln!("rune workspace reconcile failed for {failed} workspaces");
    }

    let listener = match TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0))).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("proxy bind failed: {e:?}");
            return;
        }
    };
    let port = listener.local_addr().map(|a| a.port()).unwrap_or(0);
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
