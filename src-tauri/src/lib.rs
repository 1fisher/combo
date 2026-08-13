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

/// 在系统默认浏览器中打开外部链接(前端对超链接 cmd/ctrl+click 时调用)。
/// 仅放行 http/https/mailto,避免 IPC 被用于打开任意协议。
#[tauri::command]
fn open_url(url: String) {
    let trimmed = url.trim();
    if !(trimmed.starts_with("http://")
        || trimmed.starts_with("https://")
        || trimmed.starts_with("mailto:"))
    {
        return;
    }
    let _ = open::that(trimmed);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(ProxyPort::default())
        .invoke_handler(tauri::generate_handler![get_proxy_port, open_url])
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
        base_preamble: "你是 combo 内置的智能助手。".to_string(),
        skills_paths: Vec::new(),
        disabled_skills: Vec::new(),
        tools: true,
        mcp_command: None,
        mcp_url: None,
        explicit_api_key: None,
        explicit_base_url: None,
        mcp_servers: Vec::new(),
        reasoning_effort: None,
        lsp: std::collections::BTreeMap::new(),
    }
}

/// 直接内嵌 combo-cli serve:在随机端口上提供 combo 全部 API
/// (不再有独立的 combo-proxy 子进程,combo-cli 与桌面端同进程)。
async fn init_backend(app: &tauri::AppHandle) {
    use combo_cli::serve::{AppState, serve_listener};
    use std::net::SocketAddr;
    use tokio::net::TcpListener;

    // 初始化 tracing:打包后看不到 stderr,日志写到文件方便诊断。
    // 开发模式(终端运行)时 stderr 仍有输出。
    init_tracing();

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

    // 立即暴露端口给前端:AppState 初始化(数据库迁移等)可能耗时数秒,
    // 提前设置 ProxyPort + emit proxy-ready,前端 connectLoop 通过健康检查
    // 轮询等待 serve 就绪,而非 fallback 到 18234 硬编码端口。
    if let Some(state) = app.try_state::<ProxyPort>() {
        *state.0.lock().unwrap() = Some(port);
    }
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

    let mut state = match AppState::new(cfg) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("初始化 combo 数据目录失败: {e:?}");
            return;
        }
    };
    state.local_port = port;

    let origins = vec![
        "tauri://localhost".to_string(),
        "http://localhost:5173".to_string(),
    ];
    // 长驻服务:combo-cli 与桌面端同进程,退出由桌面端进程回收;失败时仅记录
    // 静态资源目录:支持 tunnel-all 模式下通过隧道提供前端页面给远程中转服务器。
    let static_dir = resolve_static_dir(app);
    match &static_dir {
        Some(dir) => eprintln!("combo 静态资源目录(tunnel-all): {}", dir.display()),
        None => eprintln!("combo 静态资源目录: 未找到 dist/(tunnel-all 模式下远程页面将 404)"),
    }
    if let Err(e) = serve_listener(listener, state, origins, static_dir).await {
        eprintln!("serve exited: {e:?}");
    }
}

/// 解析前端静态资源目录:
/// 1. `COMBO_STATIC_DIR` 环境变量(优先级最高)
/// 2. Tauri resource 目录下的 `dist/`(打包后的资源)
/// 3. 开发模式:auto-detect(当前工作目录或上级目录下的 `dist/`)
fn resolve_static_dir(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    use tauri::Manager;

    // 1. 环境变量
    if let Ok(dir) = std::env::var("COMBO_STATIC_DIR") {
        let path = std::path::PathBuf::from(dir);
        if path.is_dir() {
            return Some(path);
        }
    }

    // 2. Tauri resource 目录(打包后的 production 模式)
    //    resources 配置为 map 格式 {"../dist/": "dist/"} 时,文件在 resource_dir/dist/。
    //    兼容旧配置:glob "../dist/*" 经 resource_relpath 转换后落在 _up_/dist/。
    if let Ok(resource_dir) = app.path().resource_dir() {
        for sub in ["dist", "_up_/dist"] {
            let candidate = resource_dir.join(sub);
            if candidate.join("index.html").is_file() {
                return Some(candidate);
            }
        }
    }

    // 3. 开发模式:auto-detect
    for candidate in ["./dist", "../dist", "../../dist"] {
        let path = std::path::PathBuf::from(candidate);
        if path.join("index.html").is_file() {
            return Some(path);
        }
    }

    None
}

/// 初始化 tracing 日志:打包后写文件到 combo 数据目录的 logs/ 下,
/// 开发模式(stderr 可见)时也输出到终端。
fn init_tracing() {
    use tracing_subscriber::{fmt, EnvFilter, prelude::*};

    let env_filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("combo_cli=info,tower_http=warn,info"));

    // 尝试日志文件路径:COMBO_DATA_DIR/logs/combo-desktop.log
    let log_dir = std::env::var("COMBO_DATA_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| {
            dirs::data_dir()
                .unwrap_or_else(|| std::path::PathBuf::from("."))
                .join("combo")
        })
        .join("logs");

    let _ = std::fs::create_dir_all(&log_dir);

    let layers: Vec<Box<dyn tracing_subscriber::Layer<_> + Send + Sync>> =
        match std::fs::File::create(log_dir.join("combo-desktop.log")) {
            Ok(file) => {
                let file_layer = fmt::layer()
                    .with_writer(file)
                    .with_ansi(false)
                    .with_target(false);
                vec![Box::new(file_layer)]
            }
            Err(_) => vec![],
        };

    // stderr 层(开发模式)
    let stderr_layer = fmt::layer()
        .with_writer(std::io::stderr)
        .with_target(false);

    tracing_subscriber::registry()
        .with(env_filter)
        .with(layers)
        .with(stderr_layer)
        .init();
}