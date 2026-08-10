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
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(ProxyPort::default())
        .invoke_handler(tauri::generate_handler![get_proxy_port])
        .setup(|app| {
            // 调试:COMBO_DEVTOOLS=1 时自动打开 WebView 开发者工具
            if std::env::var("COMBO_DEVTOOLS").is_ok() {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.open_devtools();
                }
            }
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                init_backend(&handle).await;
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// 读取 combo-cli 配置并解析出 AskConfig(与 CLI 相同的流程,无命令行参数)。
fn load_cfg() -> anyhow::Result<combo_cli::agent::AskConfig> {
    let config_path = combo_cli::config::default_config_path();
    // 先加载同目录 .env(为 $ENV_VAR 形式的 key/base_url 提供默认值)
    combo_cli::config::load_dotenv(&config_path);
    let file_cfg = combo_cli::config::AppConfig::load_or_create(&config_path)?;
    let resolved = file_cfg.resolve(None, None, None, None, None, None);
    let provider =
        combo_cli::providers::find_provider(&resolved.provider, &resolved.providers)?;
    Ok(combo_cli::agent::AskConfig::from_resolved(&resolved, provider))
}

/// 配置缺失/无法解析时的兜底:内置 opencode provider。
/// serve 的 health/文件/会话等端点不依赖 API key,agent 运行会在无 key 时以 error 收尾。
fn fallback_cfg() -> combo_cli::agent::AskConfig {
    let provider = combo_cli::providers::builtin_providers()
        .into_iter()
        .find(|p| p.id == "opencode")
        .expect("builtin opencode provider 必然存在");
    combo_cli::agent::AskConfig {
        provider,
        model: "deepseek-v4-flash-free".to_string(),
        preamble: "你是 combo 内置的智能助手。".to_string(),
        tools: true,
        mcp_command: None,
        mcp_url: None,
        explicit_api_key: None,
        explicit_base_url: None,
        mcp_servers: Vec::new(),
    }
}

/// 直接内嵌 combo-cli serve:在随机端口上提供 combo 全部 API
/// (不再有独立的 combo-proxy 子进程,combo-cli 与桌面端同进程)。
async fn init_backend(app: &tauri::AppHandle) {
    use combo_cli::serve::{AppState, serve_listener};
    use std::net::SocketAddr;
    use tokio::net::TcpListener;

    let cfg = match load_cfg() {
        Ok(cfg) => cfg,
        Err(e) => {
            eprintln!("读取 combo 配置失败,使用内置默认 provider: {e:#}");
            fallback_cfg()
        }
    };

    // 绑定地址:默认 127.0.0.1(仅本地);域名部署时可设 COMBO_HOST=0.0.0.0 对外开放。
    let bind_host: std::net::IpAddr = std::env::var("COMBO_HOST")
        .ok()
        .and_then(|h| h.trim().parse().ok())
        .unwrap_or([127, 0, 0, 1].into());
    let listener = match TcpListener::bind(SocketAddr::from((bind_host, 0))).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("serve bind failed: {e:?}");
            return;
        }
    };
    let port = listener.local_addr().map(|a| a.port()).unwrap_or(0);

    let mut state = match AppState::new(cfg) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("初始化 combo 数据目录失败: {e:?}");
            return;
        }
    };
    state.local_port = port;

    // 存入 Tauri state,前端可通过 get_proxy_port command 主动查询
    if let Some(state) = app.try_state::<ProxyPort>() {
        *state.0.lock().unwrap() = Some(port);
    }
    let origins = vec![
        "tauri://localhost".to_string(),
        "http://localhost:5173".to_string(),
    ];
    // emit 事件(兼容已有逻辑),同时持续重发以覆盖前端 listener 注册竞态
    let _ = app.emit(EVENT_RUNE_STATUS, RuneStatus { connected: true });
    let _ = app.emit(EVENT_PROXY_READY, ProxyReady { port });
    let app_clone = app.clone();
    tauri::async_runtime::spawn(async move {
        use std::time::Duration;
        for _ in 0..20 {
            tokio::time::sleep(Duration::from_millis(500)).await;
            let _ = app_clone.emit(EVENT_PROXY_READY, ProxyReady { port });
        }
    });
    // 长驻服务:combo-cli 与桌面端同进程,退出由桌面端进程回收;失败时仅记录
    if let Err(e) = serve_listener(listener, state, origins).await {
        eprintln!("serve exited: {e:?}");
    }
}