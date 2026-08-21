use serde::Serialize;
use std::borrow::Cow;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, RwLock};
use tauri::utils::assets::{AssetKey, CspHash};
use tauri::{Emitter, Manager};

mod tray;

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

/// 打开系统「麦克风」隐私设置页(录音权限被拒时前端引导用户跳转)。
/// macOS 走系统设置深链,Windows 走 ms-settings;其余平台为 no-op。
#[tauri::command]
fn open_privacy_settings(settings: String) {
    let target = match settings.as_str() {
        "microphone" => open_mic_settings_url(),
        _ => return,
    };
    if !target.is_empty() {
        let _ = open::that(target);
    }
}

fn open_mic_settings_url() -> String {
    #[cfg(target_os = "macos")]
    {
        "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone".to_string()
    }
    #[cfg(target_os = "windows")]
    {
        "ms-settings:privacy-microphone".to_string()
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        String::new()
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // GUI(Finder/Dock/launchd)启动的进程不继承 .zshrc 的 PATH,
    // ~/.cargo/bin、/opt/homebrew/bin 等缺失会导致 LSP 检测「未找到」、
    // npm/rustup 等命令无法 spawn;从登录 shell 解析补全(终端/dev 模式
    // PATH 已完整,直接跳过)。须在任何后台线程 spawn 之前执行。
    combo_cli::paths::ensure_gui_path();
    // 前端资源改为「磁盘优先」:真实前端(dist/)作为 bundle resources 随包分发,
    // 编译期内嵌的只是稳定兜底页(fallback-frontend/)。这样前端内容不再进入
    // cargo 指纹,`make dmg` 在只有前端变更时 cargo 是 no-op(不重编译/重链接)。
    // 详见 `ResourceFirstAssets` 的文档说明。
    let mut context = tauri::generate_context!();
    let embedded = context.assets;
    context.assets = Box::new(ResourceFirstAssets::new(embedded));
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .manage(ProxyPort::default())
        .invoke_handler(tauri::generate_handler![
            get_proxy_port,
            open_url,
            open_privacy_settings
        ])
        .setup(|app| {
            // 调试:COMBO_DEVTOOLS=1 时自动打开 WebView 开发者工具
            if std::env::var("COMBO_DEVTOOLS").is_ok() {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.open_devtools();
                }
            }
            // 系统托盘(macOS/Windows):右键菜单 + 左键切换窗口 + 关闭到托盘。
            // 失败仅记录,不影响主窗口启动(如无托盘的环境)。
            if let Err(e) = tray::init(app.handle()) {
                eprintln!("系统托盘初始化失败: {e:?}");
            }
            // macOS:替换默认应用菜单,去掉「关闭窗口 ⌘W」,把按键留给前端
            // (前端编辑器视图用 ⌘W 关闭当前文件)
            #[cfg(target_os = "macos")]
            tray::init_app_menu(app.handle());
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                init_backend(&handle).await;
            });
            Ok(())
        })
        .build(context)
        .expect("error while running tauri application")
        .run(|app, event| {
            // macOS:窗口全部隐藏(关闭到托盘)时,点击 Dock 图标重新显示主窗口
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen {
                has_visible_windows,
                ..
            } = event
            {
                if !has_visible_windows {
                    tray::show_main_window(app);
                }
            }
            #[cfg(not(target_os = "macos"))]
            let _ = (app, event);
        });
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
        readonly_tools: false,
        mcp_command: None,
        mcp_url: None,
        explicit_api_key: None,
        explicit_base_url: None,
        mcp_servers: Vec::new(),
        reasoning_effort: None,
        lsp: std::collections::BTreeMap::new(),
    }
}

/// 直接内嵌 combo-cli serve:默认在 18236(被占用自动 +1)上提供 combo 全部 API
/// (不再有独立的 combo-proxy 子进程,combo-cli 与桌面端同进程)。
async fn init_backend(app: &tauri::AppHandle) {
    use combo_cli::serve::{AppState, serve_listener};

    // 旧版数据目录(~/.local/share/combo)一次性迁移到统一目录 ~/.config/combo
    combo_cli::paths::migrate_legacy_data_dir();

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

    // 绑定地址:默认 0.0.0.0(支持手机同 WiFi 局域网直连;非回环请求由令牌
    // 中间件强制鉴权)。如需仅本机访问,设 COMBO_HOST=127.0.0.1。
    let bind_host: std::net::IpAddr = std::env::var("COMBO_HOST")
        .ok()
        .and_then(|h| h.trim().parse().ok())
        .unwrap_or([0, 0, 0, 0].into());
    // 默认监听 18236(与独立 combo-cli serve 行为一致),被占用自动 +1 递增;
    // 桌面端前端默认连接本机 combo-cli,实际端口经 proxy-ready 事件/命令下发。
    let listener = match combo_cli::serve::bind_auto(
        &bind_host.to_string(),
        combo_cli::serve::DEFAULT_SERVE_PORT,
    )
    .await
    {
        Ok(l) => l,
        Err(e) => {
            eprintln!("serve bind failed: {e:?}");
            return;
        }
    };
    let port = listener.local_addr().map(|a| a.port()).unwrap_or(0);

    // 立即暴露端口给前端:AppState 初始化(数据库迁移等)可能耗时数秒,
    // 提前设置 ProxyPort + emit proxy-ready,前端 connectLoop 通过健康检查
    // 轮询等待 serve 就绪,而非 fallback 到硬编码端口。
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

    // 托盘忙碌动画:任一项目(含自动化任务)的 run 进行中时,托盘图标切换为
    // 琥珀色旋转动画,全部结束恢复静态图标。AppState 为 Arc 聚合,克隆共享。
    {
        let app_watcher = app.clone();
        let state_watcher = state.clone();
        tauri::async_runtime::spawn(async move {
            tray::watch_busy(app_watcher, state_watcher).await;
        });
    }

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

    // 3. 可执行文件相对探测(裸跑仓库二进制时 resource_dir 是 cargo 输出
    //    目录本身、cwd 又可能不在仓库内,两处都 miss;详见 dist_near_executable)
    if let Ok(exe) = std::env::current_exe() {
        if let Some(found) = dist_near_executable(&exe) {
            return Some(found);
        }
    }

    // 4. 开发模式:auto-detect
    for candidate in ["./dist", "../dist", "../../dist"] {
        let path = std::path::PathBuf::from(candidate);
        if path.join("index.html").is_file() {
            return Some(path);
        }
    }

    None
}

/// 前端资源 provider:webview 的 `tauri://localhost/*` 请求**优先读取磁盘上
/// 随包分发的 dist**(Tauri Resources 目录 / COMBO_STATIC_DIR / 开发目录探测,
/// 复用 `resolve_static_dir` 的解析规则),磁盘没有才回退到编译期内嵌资源
/// (`src-tauri/fallback-frontend/` 兜底页)。
///
/// ## 为什么需要它
///
/// tauri-codegen 会把 `frontendDist` 下所有文件经 `include_bytes!` 内嵌进
/// 二进制——前端任何改动都会使 `combo` crate 重编译 + 重链接(分钟级)。
/// 把 `frontendDist` 指向稳定的兜底页目录后,前端内容完全脱离 cargo 指纹:
/// - 仅前端变更:`tauri build` 里 cargo 是 no-op,只需重建前端 + 重新打包;
/// - Rust 变更:照常重编译;
/// - `cargo build -p combo` 也不要求先 `npm run build` 才能过编译。
///
/// 真实前端依旧经 `bundle.resources`(`{"../dist/": "dist/"}`)随包分发,
/// tunnel-all 模式的静态服务(`resolve_static_dir`)与 webview 由此共用
/// 同一份 dist,不再出现「内嵌旧版 / 资源新版」的漂移。
struct ResourceFirstAssets {
    /// 磁盘 dist 目录(解析后缓存;None = 无磁盘资源,全部走内嵌)。
    /// 注意:tauri 创建 webview 窗口**早于** `Assets::setup`(app.rs 中
    /// `WebviewWindowBuilder::build()` 在 `assets.setup(app)` 之前),首个
    /// 资源请求会先用较弱的路径探测;因此用 RwLock 而非 OnceLock,setup
    /// 的权威解析结果(resource_dir 布局)可以无条件覆盖首探测。
    dist_dir: RwLock<Option<PathBuf>>,
    embedded: Box<dyn tauri::Assets<tauri::Wry>>,
}

impl ResourceFirstAssets {
    fn new(embedded: Box<dyn tauri::Assets<tauri::Wry>>) -> Self {
        Self {
            dist_dir: RwLock::new(None),
            embedded,
        }
    }

    fn dist(&self) -> Option<PathBuf> {
        if let Some(dir) = self.dist_dir.read().unwrap().clone() {
            return Some(dir);
        }
        let found = find_disk_dist_dir();
        match found {
            Some(dir) => {
                let mut guard = self.dist_dir.write().unwrap();
                if guard.is_none() {
                    *guard = Some(dir.clone());
                }
                guard.clone()
            }
            None => None,
        }
    }
}

/// 无 AppHandle 时的磁盘 dist 探测(与 resolve_static_dir 的 exe/cwd 部分同口径)。
fn find_disk_dist_dir() -> Option<PathBuf> {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(found) = dist_near_executable(&exe) {
            return Some(found);
        }
    }
    for cwd in ["./dist", "../dist", "../../dist"] {
        let path = PathBuf::from(cwd);
        if path.join("index.html").is_file() {
            return Some(path);
        }
    }
    None
}

/// 按可执行文件位置探测磁盘 dist:
/// 1. macOS .app 布局:`Contents/MacOS/<bin>` → `Contents/Resources/dist`
///    (resource_dir 解析失败时的兜底);
/// 2. 从 exe 所在目录向上最多 4 级找 `dist/`(要求 index.html 存在)——
///    覆盖仓库内裸跑的两种 cargo 布局:`target/release/<bin>`(上 2 级到
///    仓库根)与 `target/<triple>/release/<bin>`(上 3 级),另含 1 级余量。
///
/// 没有这一步时,裸跑二进制的 resource_dir 被 tauri-utils 特判为 cargo 输出
/// 目录(exe 目录本身),`dist`/`_up_/dist` 探测必 miss;若 cwd 又不在仓库
/// 内(如在 $HOME 用绝对路径启动),resolve_static_dir 返回 None 且被
/// OnceLock 锁死,webview 只能显示内嵌兜底页。
fn dist_near_executable(exe: &Path) -> Option<PathBuf> {
    let dir = exe.parent()?;
    // .app 布局:Contents/MacOS/<bin> → Contents/Resources/dist
    let resources = dir.parent()?.join("Resources/dist");
    if resources.join("index.html").is_file() {
        return Some(resources);
    }
    find_dist_upward(dir, 4)
}

/// 从 `from` 目录(含自身)向上最多 `max_levels` 级,逐级探测 `<dir>/dist`。
fn find_dist_upward(from: &Path, max_levels: usize) -> Option<PathBuf> {
    let mut dir = from.to_path_buf();
    for _ in 0..=max_levels {
        let candidate = dir.join("dist");
        if candidate.join("index.html").is_file() {
            return Some(candidate);
        }
        if !dir.pop() {
            break;
        }
    }
    None
}

impl tauri::Assets<tauri::Wry> for ResourceFirstAssets {
    fn setup(&self, app: &tauri::App<tauri::Wry>) {
        // 注意:tauri 创建 webview 窗口早于本回调,首个资源请求可能已经用
        // 弱探测初始化过;resolve_static_dir(resource_dir 兼容各平台 bundle
        // 布局)更权威,无条件覆盖。
        let resolved = resolve_static_dir(app.handle());
        // tracing 尚未初始化(init_tracing 在 init_backend 里,晚于 webview
        // 首个资源请求),用 eprintln 保证诊断可见。
        match &resolved {
            Some(dir) => eprintln!("[assets] webview 前端资源目录: {}", dir.display()),
            None => eprintln!("[assets] 未找到磁盘 dist,回退内嵌兜底页"),
        }
        *self.dist_dir.write().unwrap() = resolved;
    }

    fn get(&self, key: &AssetKey) -> Option<Cow<'_, [u8]>> {
        if let Some(dir) = self.dist() {
            // tauri protocol 传入的 key 可能带前导斜杠(如 `/index.html`),
            // 必须去掉:Path::join 遇绝对路径会替换整个 dist 前缀,导致
            // 读到文件系统根下的路径。key 已 percent 解码,按路径分量拒绝
            // `..` 防穿越;磁盘模式为「全有或全无」:单个文件缺失不回退内嵌,
            // 避免新旧两套前端混搭(index.html 引用不到对应 hash 的资源)。
            let rel = key.as_ref().trim_start_matches(['/', '\\']);
            if rel.split(['/', '\\']).any(|seg| seg == "..") {
                return None;
            }
            return match std::fs::read(dir.join(rel)) {
                Ok(bytes) => Some(Cow::Owned(bytes)),
                Err(err) => {
                    eprintln!(
                        "[assets] 磁盘 dist 读取失败: dir={} key={rel} err={err}",
                        dir.display()
                    );
                    None
                }
            };
        }
        self.embedded.get(key)
    }

    fn iter(&self) -> Box<tauri::utils::assets::AssetsIter<'_>> {
        self.embedded.iter()
    }

    fn csp_hashes(&self, html_path: &AssetKey) -> Box<dyn Iterator<Item = CspHash<'_>> + '_> {
        self.embedded.csp_hashes(html_path)
    }
}

/// 初始化 tracing 日志:打包后写文件到 combo 统一数据目录的 logs/ 下,
/// 开发模式(stderr 可见)时也输出到终端。
fn init_tracing() {
    use tracing_subscriber::{fmt, EnvFilter, prelude::*};

    let env_filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("combo_cli=info,tower_http=warn,info"));

    // 尝试日志文件路径:统一目录(~/.config/combo)/logs/combo-desktop.log
    let log_dir = combo_cli::paths::default_data_dir().join("logs");

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

#[cfg(test)]
mod tests {
    use super::*;

    /// 在临时目录构造假布局后执行 `f`,返回其结果(目录用后即删)。
    fn with_temp_layout<F>(f: F) -> Option<PathBuf>
    where
        F: FnOnce(&Path) -> Option<PathBuf>,
    {
        let base = std::env::temp_dir().join(format!(
            "combo-assets-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = std::fs::remove_dir_all(&base);
        let result = f(&base);
        let _ = std::fs::remove_dir_all(&base);
        result
    }

    fn touch(path: &Path) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, b"ok").unwrap();
    }

    #[test]
    fn dist_near_executable_finds_repo_dist_from_target_release() {
        // 裸跑 target/release/Combo(cwd 不在仓库内也能找到仓库根 dist)
        with_temp_layout(|base| {
            let exe = base.join("target/release/Combo");
            touch(&exe);
            touch(&base.join("dist/index.html"));
            assert_eq!(dist_near_executable(&exe), Some(base.join("dist")));
            None
        });
    }

    #[test]
    fn dist_near_executable_finds_repo_dist_from_triple_layout() {
        // 裸跑 target/<triple>/release/Combo(上 3 级到仓库根)
        with_temp_layout(|base| {
            let exe = base.join("target/aarch64-apple-darwin/release/Combo");
            touch(&exe);
            touch(&base.join("dist/index.html"));
            assert_eq!(dist_near_executable(&exe), Some(base.join("dist")));
            None
        });
    }

    #[test]
    fn dist_near_executable_prefers_app_resources_layout() {
        // .app 布局:Contents/MacOS/<bin> → Contents/Resources/dist
        with_temp_layout(|base| {
            let exe = base.join("Combo.app/Contents/MacOS/Combo");
            touch(&exe);
            touch(&base.join("Combo.app/Contents/Resources/dist/index.html"));
            assert_eq!(
                dist_near_executable(&exe),
                Some(base.join("Combo.app/Contents/Resources/dist"))
            );
            None
        });
    }

    #[test]
    fn dist_near_executable_returns_none_without_dist() {
        with_temp_layout(|base| {
            let exe = base.join("target/release/Combo");
            touch(&exe);
            assert_eq!(dist_near_executable(&exe), None);
            None
        });
    }

    #[test]
    fn find_dist_upward_respects_level_limit() {
        with_temp_layout(|base| {
            touch(&base.join("dist/index.html"));
            // 上 4 级:target/<triple>/<profile>/<bin-dir> → 仓库根可达
            let from = base.join("a/b/c/d");
            assert_eq!(find_dist_upward(&from, 4), Some(base.join("dist")));
            // 上 3 级:差一级,够不到
            assert_eq!(find_dist_upward(&from, 3), None);
            None
        });
    }
}