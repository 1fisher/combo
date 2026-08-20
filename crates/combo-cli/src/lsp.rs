//! LSP 支持:实现 stdio JSON-RPC 客户端,连接配置的 LSP server,
//! 提供 `lsp list`(查看已配置 server 与可执行状态)与代码诊断/定义/引用/hover 能力。
//!
//! - [`LspClient`]:单个 LSP server 子进程的 JSON-RPC 客户端(Content-Length 帧协议)。
//! - [`LspManager`]:按文件扩展名路由到对应语言 server,lazy 启动并复用。
//!
//! combo-cli 的 LSP 工具(`diagnostics`/`definition`/`references`/`hover`)
//! 通过 `LspManager` 暴露给 agent。

use crate::config::{LspServerConfig, ResolvedConfig};
use crate::serve::AppState;
use anyhow::Result;
use axum::extract::{Path as AxumPath, State};
use axum::http::StatusCode;
use axum::response::Response;
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout};
use tokio::sync::{oneshot, Mutex};

/// 一个 LSP server 的状态(供 `lsp list` 展示)。
#[allow(dead_code)]
pub struct LspStatus {
    pub name: String,
    pub command: String,
    pub executable: bool,
    pub path: Option<PathBuf>,
}

/// 列出配置的 LSP server 及其可执行状态(供 `lsp list` 使用)。
pub fn list(cfg: &ResolvedConfig) -> Result<()> {
    if cfg.lsp.is_empty() {
        println!("未配置 LSP server(配置文件的 [lsp] 字段)");
        return Ok(());
    }
    println!("已配置 {} 个 LSP server:", cfg.lsp.len());
    for (name, srv) in &cfg.lsp {
        let exe = find_executable(&srv.command);
        match &exe {
            Some(p) => println!("  {}  {}  ✓ {}", name, srv.command, p.display()),
            None => println!("  {}  {}  ✗ 未找到", name, srv.command),
        }
    }
    Ok(())
}

/// GUI 启动(Finder/Dock)的进程 PATH 往往只有系统目录,缺少用户级安装位置;
/// 追加常见目录兜底:rustup(`~/.cargo/bin`)、pipx/uv(`~/.local/bin`)、
/// Homebrew(Apple Silicon `/opt/homebrew/bin`;Intel/手动安装 `/usr/local/bin`)。
/// PATH 中的目录命中优先,兜底目录仅去重追加。
fn extra_bin_dirs(home: Option<&Path>) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(h) = home {
        dirs.push(h.join(".cargo").join("bin"));
        dirs.push(h.join(".local").join("bin"));
    }
    if cfg!(target_os = "macos") {
        dirs.push(PathBuf::from("/opt/homebrew/bin"));
    }
    dirs.push(PathBuf::from("/usr/local/bin"));
    dirs
}

/// 在给定目录列表中查找可执行文件(测试可注入目录,生产走 `find_executable`)。
fn find_in_dirs(cmd: &str, dirs: impl IntoIterator<Item = PathBuf>) -> Option<PathBuf> {
    for dir in dirs {
        if dir.as_os_str().is_empty() {
            continue;
        }
        let p = dir.join(cmd);
        if p.is_file() {
            return Some(p);
        }
    }
    None
}

/// 按进程 PATH + 常见用户级安装目录查找可执行文件
/// (serve 的 `/v1/lsp` 状态检测、LSP server 启动共用同一解析口径)。
pub fn find_executable(cmd: &str) -> Option<PathBuf> {
    if cmd.contains('/') || cmd.contains('\\') {
        let p = PathBuf::from(cmd);
        return p.is_file().then_some(p);
    }
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .ok()
        .map(PathBuf::from);
    // PATH 命中优先(同时接受 ':' unix 与 ';' Windows 分隔),兜底目录去重后追加
    let path = std::env::var("PATH").unwrap_or_default();
    let mut dirs: Vec<PathBuf> = path
        .split([':', ';'])
        .filter(|d| !d.is_empty())
        .map(PathBuf::from)
        .collect();
    for d in extra_bin_dirs(home.as_deref()) {
        if !dirs.contains(&d) {
            dirs.push(d);
        }
    }
    find_in_dirs(cmd, dirs)
}

/// 把待 spawn 的裸命令解析为绝对路径(与 `find_executable` 同一口径:
/// 进程 PATH 优先 + `~/.cargo/bin`/`/opt/homebrew/bin` 等常见安装目录兜底)。
///
/// 背景:GUI(Finder/Dock)启动的进程 PATH 往往只有系统目录,Homebrew 等
/// 方式安装的包管理器只在兜底目录里——检测侧(`resolve_install_command`)
/// 判定「可安装」,spawn 侧若直接 `Command::new("npm")` 只查进程 PATH,
/// 会报 `No such file or directory (os error 2)`。与 `LspClient::start`
/// 保持同一解析口径。已是路径或查不到时原样返回(后者交由 spawn 报错)。
pub fn resolve_spawn_program(program: &str) -> String {
    if program.contains('/') || program.contains('\\') {
        return program.to_string();
    }
    find_executable(program)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|| program.to_string())
}

/// 向 PATH 目录列表追加一个条目(去空白、跳过空条目、保序去重)。
fn push_path_dir(dirs: &mut Vec<String>, dir: &str) {
    let dir = dir.trim();
    if !dir.is_empty() && !dirs.iter().any(|d| d == dir) {
        dirs.push(dir.to_string());
    }
}

/// 为 spawn 外部命令构造子进程 PATH——**spawn 时统一「加载 shell 环境」**:
/// 按优先级合并 ①已解析命令所在目录 ②登录 shell PATH(`paths.rs::
/// login_shell_path_cached`,GUI/launchd 进程读不到 .zshrc,探测结果缓存
/// 一次)③进程 PATH(`ensure_gui_path` 启动时可能已合并过)④常见用户级
/// 安装目录(`extra_bin_dirs`)。①排最前是关键:npm / typescript-language-server
/// 等是 `#!/usr/bin/env node` 脚本,shebang 的解释器仍按 **PATH** 查找,
/// 只把命令本身解析成绝对路径不够——受限 PATH 下报 `env: node: No such
/// file or directory`(退出码 127);node 与 npm 通常同目录(Homebrew 的
/// `/opt/homebrew/bin`、nvm 的版本目录),目录置首保证命中同版本解释器。
/// 子进程再派生的进程(npm 拉起 node/git 等)同样继承该 PATH。
pub fn spawn_path_for(program: Option<&str>) -> String {
    let mut dirs: Vec<String> = Vec::new();
    if let Some(parent) = program.and_then(|p| Path::new(p).parent()) {
        push_path_dir(&mut dirs, &parent.to_string_lossy());
    }
    if let Some(shell) = crate::paths::login_shell_path_cached() {
        for d in shell.split([':', ';']) {
            push_path_dir(&mut dirs, d);
        }
    }
    for d in std::env::var("PATH")
        .unwrap_or_default()
        .split([':', ';'])
    {
        push_path_dir(&mut dirs, d);
    }
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .ok()
        .map(PathBuf::from);
    for d in extra_bin_dirs(home.as_deref()) {
        push_path_dir(&mut dirs, &d.to_string_lossy());
    }
    let sep = if cfg!(windows) { ";" } else { ":" };
    dirs.join(sep)
}

// =========================== 一键安装方案 ===========================

/// 某语言 LSP server 的一键安装方案(`POST /v1/lsp/install` 使用)。
pub struct LspInstallPlan {
    /// 语言标识(与 `[lsp.<lang>]` 配置段一致)。
    pub lang: &'static str,
    /// 对应 server 可执行文件(安装成功后写入配置的 command)。
    pub server_command: &'static str,
    /// server 启动参数(写入配置的 args)。
    pub server_args: Option<&'static [&'static str]>,
    /// 安装命令候选(按优先级):(包管理器可执行名, 完整 argv)。
    /// 运行时取本机 PATH 中第一个命中的候选执行。
    pub candidates: &'static [(&'static str, &'static [&'static str])],
}

/// 内置一键安装方案目录(rust/typescript/javascript/python/go)。
/// 未收录的语言仍可经表单手动配置;前端据 `GET /v1/lsp/plans` 展示
/// 解析后的实际命令(无可用包管理器时 install_command 为 null)。
pub const LSP_INSTALL_PLANS: &[LspInstallPlan] = &[
    LspInstallPlan {
        lang: "rust",
        server_command: "rust-analyzer",
        server_args: None,
        candidates: &[
            ("rustup", &["rustup", "component", "add", "rust-analyzer"]),
            ("brew", &["brew", "install", "rust-analyzer"]),
        ],
    },
    LspInstallPlan {
        lang: "typescript",
        server_command: "typescript-language-server",
        server_args: Some(&["--stdio"]),
        candidates: &[
            (
                "npm",
                &["npm", "install", "-g", "typescript", "typescript-language-server"],
            ),
            (
                "pnpm",
                &["pnpm", "add", "-g", "typescript", "typescript-language-server"],
            ),
            (
                "yarn",
                &["yarn", "global", "add", "typescript", "typescript-language-server"],
            ),
            (
                "bun",
                &["bun", "install", "-g", "typescript", "typescript-language-server"],
            ),
            ("brew", &["brew", "install", "typescript-language-server"]),
        ],
    },
    LspInstallPlan {
        lang: "javascript",
        server_command: "typescript-language-server",
        server_args: Some(&["--stdio"]),
        candidates: &[
            (
                "npm",
                &["npm", "install", "-g", "typescript", "typescript-language-server"],
            ),
            (
                "pnpm",
                &["pnpm", "add", "-g", "typescript", "typescript-language-server"],
            ),
            (
                "yarn",
                &["yarn", "global", "add", "typescript", "typescript-language-server"],
            ),
            (
                "bun",
                &["bun", "install", "-g", "typescript", "typescript-language-server"],
            ),
            ("brew", &["brew", "install", "typescript-language-server"]),
        ],
    },
    LspInstallPlan {
        lang: "python",
        server_command: "pyright-langserver",
        server_args: Some(&["--stdio"]),
        candidates: &[
            ("pipx", &["pipx", "install", "pyright"]),
            ("uv", &["uv", "tool", "install", "pyright"]),
            ("brew", &["brew", "install", "pyright"]),
            ("pip3", &["pip3", "install", "pyright"]),
        ],
    },
    LspInstallPlan {
        lang: "go",
        server_command: "gopls",
        server_args: None,
        candidates: &[
            ("go", &["go", "install", "golang.org/x/tools/gopls@latest"]),
            ("brew", &["brew", "install", "gopls"]),
        ],
    },
];

/// 按语言取安装方案。
pub fn install_plan(lang: &str) -> Option<&'static LspInstallPlan> {
    LSP_INSTALL_PLANS.iter().find(|p| p.lang == lang)
}

/// 解析实际执行的安装命令:按候选顺序取第一个本机可用的包管理器。
/// `lookup` 注入可执行探测函数(测试用),生产传 `find_executable`。
/// 返回 (展示用完整命令行, argv)。
pub fn resolve_install_command_with(
    lang: &str,
    lookup: impl Fn(&str) -> bool,
) -> Option<(String, Vec<String>)> {
    let plan = install_plan(lang)?;
    for (bin, argv) in plan.candidates {
        if lookup(bin) {
            return Some((argv.join(" "), argv.iter().map(|s| s.to_string()).collect()));
        }
    }
    None
}

/// 按本机 PATH 解析实际执行的安装命令(展示串 + argv)。
/// 返回 None 表示该语言没有收录方案,或本机缺少全部候选包管理器。
pub fn resolve_install_command(lang: &str) -> Option<(String, Vec<String>)> {
    resolve_install_command_with(lang, |bin| find_executable(bin).is_some())
}

// =========================== 扩展名 → 语言 ===========================

/// 常见文件扩展名到语言标识的内置映射(与配置键 `[lsp.<lang>]` 对应)。
pub fn ext_to_lang(ext: &str) -> Option<&'static str> {
    let m = match ext {
        "rs" => "rust",
        "ts" | "tsx" | "mts" | "cts" => "typescript",
        "js" | "jsx" | "mjs" | "cjs" => "javascript",
        "py" => "python",
        "go" => "go",
        "java" => "java",
        "kt" | "kts" => "kotlin",
        "scala" => "scala",
        "c" | "h" => "c",
        "cpp" | "cc" | "cxx" | "hpp" | "hh" => "cpp",
        "cs" => "csharp",
        "rb" => "ruby",
        "php" => "php",
        "swift" => "swift",
        "sh" | "bash" | "zsh" => "bash",
        "lua" => "lua",
        "dart" => "dart",
        _ => return None,
    };
    Some(m)
}

/// didOpen 发给 server 的 **LSP languageId** 与配置键(`ext_to_lang`)
/// 是两个口径:tsx/jsx 在 LSP 协议里是独立语言标识(VS Code 约定),
/// typescript-language-server 等按它选择语法解析模式——把 .tsx 报成
/// `typescript` 会用纯 TS 语法解析 JSX,报出大量虚假语法错误
/// (`';' expected / '>' expected`)。因此必须按扩展名精确映射。
pub fn lsp_language_id(ext: &str) -> &'static str {
    match ext {
        "tsx" => "typescriptreact",
        "jsx" => "javascriptreact",
        _ => ext_to_lang(ext).unwrap_or("plaintext"),
    }
}

// =========================== workspace 语言统计 ===========================

/// 语言统计扫描文件数上限(超过截断;只遍历文件名不读内容,速度远快于图谱扫描)。
const MAX_LANG_SCAN_FILES: usize = 4000;

/// GET /v1/workspaces/{id}/languages — 按扩展名统计 workspace 各语言源文件数。
///
/// 与 `ext_to_lang` 同一口径(即 LSP 工具按扩展名路由的口径),供会话界面
/// 展示「项目语言 vs 已配置 LSP server 的检测状态」:如 rust 项目未配置
/// rust-analyzer、或已配置但 PATH 中找不到可执行文件时给出提示。
pub async fn workspace_languages(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> Response {
    let root = match crate::fs::resolve_root(&state, &id) {
        Ok(r) => r,
        Err(resp) => return resp,
    };
    match tokio::task::spawn_blocking(move || count_languages(&root)).await {
        Ok((langs, truncated)) => {
            let arr: Vec<Value> = langs
                .into_iter()
                .map(|(lang, files)| json!({ "lang": lang, "files": files }))
                .collect();
            crate::fs::ok_json(json!({ "languages": arr, "truncated": truncated }))
        }
        Err(e) => crate::fs::error(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("语言统计任务异常: {e}"),
        ),
    }
}

/// 遍历 workspace 统计各语言源文件数(跳过 node_modules/target 等目录与隐藏
/// 文件;上限 MAX_LANG_SCAN_FILES 防超大仓库拖慢)。返回按文件数降序的
/// `(语言标识, 文件数)` 列表与是否截断。
fn count_languages(root: &Path) -> (Vec<(String, usize)>, bool) {
    let mut counts: BTreeMap<String, usize> = BTreeMap::new();
    let mut seen = 0usize;
    let mut truncated = false;
    for entry in walkdir::WalkDir::new(root)
        .into_iter()
        .filter_entry(|e| {
            if e.depth() == 0 {
                return true;
            }
            let name = e.file_name().to_string_lossy();
            if e.file_type().is_dir() {
                return !crate::fs::is_skip_dir(&name);
            }
            true
        })
        .filter_map(|e| e.ok())
    {
        if !entry.file_type().is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy();
        if name.starts_with('.') {
            continue;
        }
        let ext = name
            .rsplit_once('.')
            .map(|(_, e)| e.to_ascii_lowercase())
            .unwrap_or_default();
        if let Some(lang) = ext_to_lang(&ext) {
            *counts.entry(lang.to_string()).or_insert(0) += 1;
        }
        seen += 1;
        if seen >= MAX_LANG_SCAN_FILES {
            truncated = true;
            break;
        }
    }
    let mut langs: Vec<(String, usize)> = counts.into_iter().collect();
    langs.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    (langs, truncated)
}

// =========================== 编辑器文档同步与实时诊断 ===========================

/// POST /v1/workspaces/{id}/lsp/document 的请求体。
#[derive(serde::Deserialize)]
pub struct LspDocumentBody {
    /// workspace 相对路径。
    pub path: String,
    /// 文档当前全量文本(编辑器缓冲区内容,未保存的修改也包含在内)。
    pub text: String,
    /// 是否伴随保存(额外发 didSave,触发 rust-analyzer cargo check 等落盘分析)。
    #[serde(default)]
    pub saved: bool,
}

/// 取(或按当前配置重建)某 workspace 的编辑器常驻 LSP 会话。
///
/// 与 agent 工具的 per-run LspManager 分离:编辑器会话跨 run 存活,client
/// lazy 启动后常驻(server 进程内保持打开文档状态,诊断即时推送)。
/// 配置指纹(格式化字符串)变化时丢弃旧 manager——旧 client 由 Arc 引用
/// 计数回收,`kill_on_drop` 关闭子进程。未配置任何 server 时返回 None。
async fn editor_manager(state: &AppState, ws_id: &str) -> Result<Option<Arc<LspManager>>, Response> {
    let root = match crate::fs::resolve_root(state, ws_id) {
        Ok(r) => r,
        Err(resp) => return Err(resp),
    };
    let configs = state.cfg.lock().unwrap().lsp.clone();
    if configs.is_empty() {
        return Ok(None);
    }
    let sig = format!("{configs:?}");
    let mut map = state.lsp_docs.lock().await;
    if let Some((s, m)) = map.get(ws_id) {
        if *s == sig {
            return Ok(Some(m.clone()));
        }
    }
    let m = Arc::new(LspManager::new(root, configs));
    map.insert(ws_id.to_string(), (sig, m.clone()));
    Ok(Some(m))
}

/// 在 workspace 根内安全解析文档相对路径,返回 (绝对路径, 无点扩展名)。
fn resolve_doc_path(state: &AppState, id: &str, rel: &str) -> Result<(PathBuf, String), Response> {
    let root = match crate::fs::resolve_root(state, id) {
        Ok(r) => r,
        Err(resp) => return Err(resp),
    };
    let path = match crate::fs::safe_join(&root, rel) {
        Ok(p) => p,
        Err(e) => {
            return Err(crate::fs::error(
                StatusCode::BAD_REQUEST,
                &format!("非法路径: {e}"),
            ))
        }
    };
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    Ok((path, ext))
}

/// POST /v1/workspaces/{id}/lsp/document — 编辑器打开/编辑时同步文档内容。
///
/// 首次 didOpen,后续 didChange(全量文本,未保存的修改也可见);
/// `saved=true` 额外发 didSave。扩展名无对应 server 时 `language` 为 null,
/// 前端据此跳过诊断轮询。
pub async fn lsp_document_sync(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    axum::Json(body): axum::Json<LspDocumentBody>,
) -> Response {
    let (path, ext) = match resolve_doc_path(&state, &id, &body.path) {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    let manager = match editor_manager(&state, &id).await {
        Ok(m) => m,
        Err(resp) => return resp,
    };
    let Some(manager) = manager else {
        return crate::fs::ok_json(json!({ "language": null }));
    };
    match manager.sync_document(&path, &ext, &body.text, body.saved).await {
        Ok(lang) => crate::fs::ok_json(json!({ "language": lang })),
        Err(e) => crate::fs::error(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("LSP 文档同步失败: {e}"),
        ),
    }
}

/// GET /v1/workspaces/{id}/lsp/diagnostics?path=&wait= — 拉取某文件的实时诊断。
///
/// `wait` 为等待 server 推送的预算毫秒数(默认 2500,上限 5000);超时返回
/// 当前缓存(冷启动中可能为空,前端稍后重试)。诊断为扁平结构
/// (line/character 0-based,severity 1=error 2=warning 3=info 4=hint)。
pub async fn lsp_document_diagnostics(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    axum::extract::Query(params): axum::extract::Query<HashMap<String, String>>,
) -> Response {
    let Some(rel) = params.get("path") else {
        return crate::fs::error(StatusCode::BAD_REQUEST, "缺少 path 参数");
    };
    let wait = params
        .get("wait")
        .and_then(|w| w.parse::<u64>().ok())
        .unwrap_or(2500)
        .min(5000);
    let (path, ext) = match resolve_doc_path(&state, &id, rel) {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    let manager = match editor_manager(&state, &id).await {
        Ok(m) => m,
        Err(resp) => return resp,
    };
    let Some(manager) = manager else {
        return crate::fs::ok_json(json!({ "language": null, "diagnostics": [] }));
    };
    match manager.diagnostics_for_editor(&path, &ext, wait).await {
        Ok(Some(diags)) => crate::fs::ok_json(json!({ "language": ext_to_lang(&ext), "diagnostics": diags })),
        Ok(None) => crate::fs::ok_json(json!({ "language": null, "diagnostics": [] })),
        Err(e) => crate::fs::error(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("LSP 诊断获取失败: {e}"),
        ),
    }
}

// =========================== LspClient ===========================

/// 单个 LSP server 子进程的 JSON-RPC 客户端。
///
/// 通过 stdio 通信:stdin 写请求/通知,stdout 读响应/通知。
/// 使用 Content-Length 帧协议(每帧 `Content-Length: N\r\n\r\n{json}`)。
pub struct LspClient {
    /// 子进程 stdin(写帧时加锁,保证整帧顺序写入)。
    stdin: Arc<Mutex<ChildStdin>>,
    _child: Child,
    next_id: AtomicU64,
    /// 请求 id → oneshot,读循环收到 response 后回填。
    pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Value>>>>,
    /// 文件 URI → 最新诊断列表(server 主动 push,工具读取)。
    diagnostics: Arc<Mutex<HashMap<String, Vec<Value>>>>,
    /// 已完成 initialize 握手。
    initialized: bool,
}

impl LspClient {
    /// 启动子进程并完成 LSP initialize 握手。
    pub async fn start(
        command: &str,
        args: &[String],
        env: &BTreeMap<String, String>,
        workspace_root: &Path,
    ) -> Result<Self> {
        // GUI 启动的进程 PATH 可能缺少 ~/.cargo/bin 等用户级目录:
        // 裸命令先经 find_executable(含常见目录兜底)解析为绝对路径再 spawn,
        // 否则会出现「检测已安装、实际拉起失败」的不一致。
        let resolved = if command.contains('/') || command.contains('\\') {
            PathBuf::from(command)
        } else {
            find_executable(command).ok_or_else(|| {
                anyhow::anyhow!("PATH 及常见安装目录中未找到 `{command}`(可先在「LSP 服务」视图检测)")
            })?
        };
        // 子进程 PATH 补全:typescript-language-server 等是 `#!/usr/bin/env node`
        // 脚本,shebang 解释器按 PATH 查找——GUI 受限 PATH 下需注入登录 shell
        // PATH 与命令所在目录(node 与 server 常同目录)才能启动。经
        // spawn_blocking 执行:登录 shell 探测首次可能耗时,不阻塞 runtime。
        let env_path = {
            let s = resolved.to_string_lossy().into_owned();
            tokio::task::spawn_blocking(move || spawn_path_for(Some(&s)))
                .await
                .unwrap_or_default()
        };
        let mut cmd = tokio::process::Command::new(&resolved);
        cmd.args(args);
        for (k, v) in env {
            cmd.env(k, v);
        }
        // 用户在 [lsp.<lang>] 的 env 里显式配置了 PATH 时尊重之
        if !env_path.is_empty() && !env.contains_key("PATH") {
            cmd.env("PATH", env_path);
        }
        cmd.stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            // stderr 透传到父进程,便于排查 server 问题
            .stderr(std::process::Stdio::inherit())
            .kill_on_drop(true);

        let mut child = cmd.spawn().map_err(|e| {
            anyhow::anyhow!("启动 LSP server `{command}` 失败: {e}(可在配置文件 [lsp] 检查路径)")
        })?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| anyhow::anyhow!("LSP server 无 stdin"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| anyhow::anyhow!("LSP server 无 stdout"))?;

        let pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Value>>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let diagnostics: Arc<Mutex<HashMap<String, Vec<Value>>>> =
            Arc::new(Mutex::new(HashMap::new()));

        let stdin_arc = Arc::new(Mutex::new(stdin));
        // 启动 stdout 读循环
        tokio::spawn(read_loop(
            BufReader::new(stdout),
            stdin_arc.clone(),
            pending.clone(),
            diagnostics.clone(),
        ));

        let mut client = Self {
            stdin: stdin_arc,
            _child: child,
            next_id: AtomicU64::new(1),
            pending,
            diagnostics,
            initialized: false,
        };

        client.initialize(workspace_root).await?;
        Ok(client)
    }

    /// LSP initialize 握手 + initialized 通知。
    async fn initialize(&mut self, workspace_root: &Path) -> Result<()> {
        let root_uri = path_to_uri(workspace_root);
        let params = json!({
            "processId": std::process::id(),
            "rootUri": root_uri,
            "capabilities": {
                "textDocument": {
                    "publishDiagnostics": { "relatedInformation": true },
                    "synchronization": { "didOpen": true, "didChange": true, "didSave": true }
                },
                "workspace": { "workspaceFolders": true }
            },
        });
        let _res = self.request("initialize", params).await?;
        self.notify_async("initialized", json!({})).await?;
        self.initialized = true;
        tracing::info!("LSP server 已就绪(workspace: {})", workspace_root.display());
        Ok(())
    }

    /// 发送请求并等待响应。
    async fn request(&self, method: &str, params: Value) -> Result<Value> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id, tx);
        let msg = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        self.write_frame(&msg).await?;
        let res = tokio::time::timeout(std::time::Duration::from_secs(30), rx)
            .await
            .map_err(|_| anyhow::anyhow!("LSP 请求 `{method}` 超时"))??;
        if let Some(err) = res.get("error") {
            anyhow::bail!("LSP 请求 `{method}` 错误: {err}");
        }
        Ok(res.get("result").cloned().unwrap_or(Value::Null))
    }

    /// 写一帧 JSON(Content-Length 头 + 正文)到 stdin。
    async fn write_frame(&self, msg: &Value) -> Result<()> {
        let body = serde_json::to_vec(msg)?;
        let header = format!("Content-Length: {}\r\n\r\n", body.len());
        let mut stdin = self.stdin.lock().await;
        stdin.write_all(header.as_bytes()).await?;
        stdin.write_all(&body).await?;
        stdin.flush().await?;
        Ok(())
    }

    /// textDocument/didOpen 通知。
    pub async fn did_open(&self, abs_path: &Path, text: &str, language_id: &str) -> Result<()> {
        let uri = path_to_uri(abs_path);
        let params = json!({
            "textDocument": {
                "uri": uri,
                "languageId": language_id,
                "version": 1,
                "text": text,
            }
        });
        self.notify_async("textDocument/didOpen", params).await
    }

    /// textDocument/didChange(全量文本;version 由 LspManager 的打开表单调递增)。
    pub async fn did_change(&self, abs_path: &Path, text: &str, version: u32) -> Result<()> {
        let uri = path_to_uri(abs_path);
        let params = json!({
            "textDocument": { "uri": uri, "version": version },
            "contentChanges": [{ "text": text }],
        });
        self.notify_async("textDocument/didChange", params).await
    }

    /// textDocument/didSave(带全量文本;触发 rust-analyzer cargo check 等落盘分析)。
    pub async fn did_save(&self, abs_path: &Path, text: &str) -> Result<()> {
        let uri = path_to_uri(abs_path);
        let params = json!({
            "textDocument": { "uri": uri, "text": text },
        });
        self.notify_async("textDocument/didSave", params).await
    }

    /// 取回某文件最新诊断(server 通过 publishDiagnostics 主动 push)。
    pub async fn get_diagnostics(&self, abs_path: &Path) -> Vec<Value> {
        let uri = path_to_uri(abs_path);
        self.diagnostics
            .lock()
            .await
            .get(&uri)
            .cloned()
            .unwrap_or_default()
    }

    /// textDocument/definition → 位置列表。
    pub async fn definition(&self, abs_path: &Path, line: u32, col: u32) -> Result<Vec<Value>> {
        self.location_request("textDocument/definition", abs_path, line, col)
            .await
    }

    /// textDocument/references → 位置列表。
    pub async fn references(&self, abs_path: &Path, line: u32, col: u32) -> Result<Vec<Value>> {
        let params = self.position_params(abs_path, line, col);
        let mut params = params;
        params["context"] = json!({ "includeDeclaration": true });
        let res = self.request("textDocument/references", params).await?;
        Ok(location_list(res))
    }

    /// textDocument/hover → 文本(Markdown/plain)。
    pub async fn hover(&self, abs_path: &Path, line: u32, col: u32) -> Result<Option<String>> {
        let params = self.position_params(abs_path, line, col);
        let res = self.request("textDocument/hover", params).await?;
        Ok(extract_hover_text(&res))
    }

    fn position_params(&self, abs_path: &Path, line: u32, col: u32) -> Value {
        json!({
            "textDocument": { "uri": path_to_uri(abs_path) },
            "position": { "line": line, "character": col }
        })
    }

    async fn location_request(
        &self,
        method: &str,
        abs_path: &Path,
        line: u32,
        col: u32,
    ) -> Result<Vec<Value>> {
        let res = self.request(method, self.position_params(abs_path, line, col)).await?;
        Ok(location_list(res))
    }

    async fn notify_async(&self, method: &str, params: Value) -> Result<()> {
        let msg = json!({ "jsonrpc": "2.0", "method": method, "params": params });
        self.write_frame(&msg).await
    }
}

/// stdout 读循环:逐帧解析 JSON,按 id 分发 response,通知存入 diagnostics。
async fn read_loop(
    mut reader: BufReader<ChildStdout>,
    stdin: Arc<Mutex<ChildStdin>>,
    pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Value>>>>,
    diagnostics: Arc<Mutex<HashMap<String, Vec<Value>>>>,
) {
    loop {
        let mut content_len: Option<usize> = None;
        let mut line = String::new();
        // 读 header 直到空行
        loop {
            line.clear();
            match reader.read_line(&mut line).await {
                Ok(0) => return, // EOF
                Ok(_) => {}
                Err(_) => return,
            }
            let trimmed = line.trim_end_matches(['\r', '\n']);
            if trimmed.is_empty() {
                break; // header 结束
            }
            if let Some(v) = trimmed.strip_prefix("Content-Length:") {
                content_len = v.trim().parse().ok();
            }
        }
        let Some(len) = content_len else { continue };
        let mut buf = vec![0u8; len];
        if reader.read_exact(&mut buf).await.is_err() {
            return;
        }
        let Ok(msg) = serde_json::from_slice::<Value>(&buf) else {
            continue;
        };

        // server→client 消息(通知与请求)。注意 server 请求也带 id,
        // 必须先于下方 response 分支判断——否则被当成响应丢弃。
        if let Some(method) = msg.get("method").and_then(Value::as_str) {
            // server 请求(如 workspace/configuration、client/registerCapability):
            // 回 null result 让 server 落回默认配置。不回复的话
            // typescript-language-server 等会在等响应处挂起,
            // publishDiagnostics 永远不来(表现为诊断一直为空)。
            if let Some(id) = msg.get("id").and_then(Value::as_u64) {
                let reply = json!({ "jsonrpc": "2.0", "id": id, "result": null });
                if let Ok(body) = serde_json::to_vec(&reply) {
                    let header = format!("Content-Length: {}\r\n\r\n", body.len());
                    let mut w = stdin.lock().await;
                    let _ = w.write_all(header.as_bytes()).await;
                    let _ = w.write_all(&body).await;
                    let _ = w.flush().await;
                }
            }
            if method == "textDocument/publishDiagnostics" {
                if let Some(params) = msg.get("params") {
                    let uri = params.get("uri").and_then(Value::as_str).map(String::from);
                    let diags = params
                        .get("diagnostics")
                        .cloned()
                        .unwrap_or(Value::Array(vec![]));
                    let arr = match diags {
                        Value::Array(a) => a,
                        other => vec![other],
                    };
                    if let Some(uri) = uri {
                        diagnostics.lock().await.insert(uri, arr);
                    }
                }
            }
            continue;
        }
        // response(id 匹配)
        if let Some(id) = msg.get("id").and_then(Value::as_u64) {
            if let Some(tx) = pending.lock().await.remove(&id) {
                let _ = tx.send(msg);
            }
        }
    }
}

/// 绝对路径 → `file://` URI。
fn path_to_uri(p: &Path) -> String {
    let abs = if p.is_absolute() {
        p.to_path_buf()
    } else {
        std::env::current_dir().unwrap_or_default().join(p)
    };
    format!("file://{}", abs.display())
}

/// 把 definition/references 的响应归一为位置数组。
fn location_list(res: Value) -> Vec<Value> {
    match res {
        Value::Null => vec![],
        Value::Array(a) => a,
        other => vec![other],
    }
}

/// 从 hover 响应提取可读文本。
fn extract_hover_text(res: &Value) -> Option<String> {
    // res 本身是字符串时直接返回。
    if let Some(s) = res.as_str() {
        return Some(s.to_string());
    }
    let content = res.get("contents").or_else(|| res.get("value"))?;
    match content {
        Value::String(s) => Some(s.clone()),
        Value::Object(_) => content
            .get("value")
            .and_then(Value::as_str)
            .map(String::from),
        Value::Array(a) => {
            let parts: Vec<String> = a
                .iter()
                .filter_map(|v| v.get("value").and_then(Value::as_str).map(String::from))
                .collect();
            if parts.is_empty() {
                None
            } else {
                Some(parts.join("\n\n"))
            }
        }
        _ => None,
    }
}

// =========================== LspManager ===========================

/// 多语言 LSP 路由器。按文件扩展名找到配置的语言 server,lazy 启动并复用。
///
/// 生命周期绑定到所注册的 agent 工具:工具 drop → Arc 引用归零 → client drop → 子进程关闭。
/// (编辑器会话由 serve 层的 `AppState.lsp_docs` 单独持有一份常驻 manager。)
pub struct LspManager {
    workspace_root: PathBuf,
    configs: BTreeMap<String, LspServerConfig>,
    clients: Mutex<HashMap<String, Arc<LspClient>>>,
    /// 已打开文档 uri → 当前版本号(didOpen 为 1,之后 didChange 递增)。
    /// agent 工具与编辑器共用同一张表,保证版本单调、不重复 didOpen。
    open_docs: Mutex<HashMap<String, u32>>,
}

/// 计算文档同步动作:未打开 → didOpen(version=1);已打开 → didChange(version+1)。
/// 抽成纯函数便于单测。
fn next_doc_version(open_docs: &HashMap<String, u32>, uri: &str) -> (bool, u32) {
    match open_docs.get(uri) {
        None => (true, 1),
        Some(v) => (false, v + 1),
    }
}

/// 把 LSP 诊断对象精简为扁平 JSON(编辑器/状态指示器直接渲染用的 wire 结构)。
/// 字段缺失时给安全默认(severity 默认 3=info,位置默认 0)。
fn slim_diagnostic(d: Value) -> Value {
    let pos = |obj: &str, key: &str| {
        d.pointer(&format!("/range/{obj}/{key}"))
            .and_then(Value::as_u64)
            .unwrap_or(0)
    };
    json!({
        "line": pos("start", "line"),
        "character": pos("start", "character"),
        "endLine": pos("end", "line"),
        "endCharacter": pos("end", "character"),
        "severity": d.get("severity").and_then(Value::as_u64).unwrap_or(3),
        "message": d.get("message").and_then(Value::as_str).unwrap_or(""),
        "source": d.get("source").and_then(Value::as_str),
    })
}

impl LspManager {
    pub fn new(workspace_root: PathBuf, configs: BTreeMap<String, LspServerConfig>) -> Self {
        Self {
            workspace_root,
            configs,
            clients: Mutex::new(HashMap::new()),
            open_docs: Mutex::new(HashMap::new()),
        }
    }

    /// 是否配置了任意 LSP server(决定是否注册 LSP 工具)。
    pub fn has_servers(&self) -> bool {
        !self.configs.is_empty()
    }

    /// 按扩展名解析语言标识,并返回该语言是否已配置 server。
    pub fn lang_for_ext(&self, ext: &str) -> Option<String> {
        let lang = ext_to_lang(ext)?;
        if self.configs.contains_key(lang) {
            Some(lang.to_string())
        } else {
            None
        }
    }

    /// 取得(必要时启动)某语言对应的 client。
    async fn client_for(&self, lang: &str) -> Result<Arc<LspClient>> {
        if let Some(c) = self.clients.lock().await.get(lang) {
            return Ok(c.clone());
        }
        let cfg = self
            .configs
            .get(lang)
            .ok_or_else(|| anyhow::anyhow!("语言 `{lang}` 未配置 LSP server"))?;
        let args = cfg.args.clone().unwrap_or_default();
        let env = cfg.env.clone().unwrap_or_default();
        let client = LspClient::start(&cfg.command, &args, &env, &self.workspace_root).await?;
        let arc = Arc::new(client);
        self.clients.lock().await.insert(lang.to_string(), arc.clone());
        Ok(arc)
    }

    /// 打开或更新文档并等待诊断就绪(agent 工具入口)。
    ///
    /// LSP server(如 rust-analyzer)首次加载项目可能先推送空诊断,
    /// 分析完成后才推送实际诊断。因此等待策略:
    /// 1. 轮询直到 diagnostics 中出现该文件 uri(最多 30s);
    /// 2. 继续轮询直到诊断稳定(连续 3 次读取相同)或非空,最多再等 10s。
    async fn ensure_opened(&self, client: &LspClient, abs_path: &Path) -> Result<()> {
        let text = std::fs::read_to_string(abs_path)
            .map_err(|e| anyhow::anyhow!("读取文件失败 {}: {e}", abs_path.display()))?;
        // 与编辑器共用同一文档同步入口:首次 didOpen,后续 didChange,版本单调
        let ext = abs_path.extension().and_then(|e| e.to_str()).unwrap_or("");
        self.sync_document(abs_path, ext, &text, false).await?;
        let uri = path_to_uri(abs_path);
        let diags = client.diagnostics.clone();

        // 1. 等待 uri 首次出现(server 已开始处理)。
        for _ in 0..600 {
            if diags.lock().await.contains_key(&uri) {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }

        // 2. 等待诊断稳定或非空(分析可能多次推送)。
        let mut last_len: Option<usize> = None;
        let mut stable = 0;
        for _ in 0..200 {
            let cur_len = diags
                .lock()
                .await
                .get(&uri)
                .map(|v| v.len())
                .unwrap_or(0);
            if cur_len > 0 {
                break; // 有诊断即可返回
            }
            if Some(cur_len) == last_len {
                stable += 1;
                if stable >= 6 {
                    break; // 连续 ~3s 稳定为空,视为无诊断
                }
            } else {
                stable = 0;
            }
            last_len = Some(cur_len);
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        }
        Ok(())
    }

    /// 同步文档内容给 LSP server(编辑器与 agent 工具共用的唯一入口):
    /// 首次 → didOpen(version=1);后续 → didChange(version+1,全量文本)。
    /// `save=true` 时额外发 didSave,触发 rust-analyzer cargo check 等落盘分析。
    /// 扩展名无对应 server 时返回 Ok(None),调用方据此跳过诊断请求。
    pub async fn sync_document(
        &self,
        abs_path: &Path,
        ext: &str,
        text: &str,
        save: bool,
    ) -> Result<Option<String>> {
        let Some(lang) = self.lang_for_ext(ext) else {
            return Ok(None);
        };
        let client = self.client_for(&lang).await?;
        let uri = path_to_uri(abs_path);
        let (first, version) = {
            let mut docs = self.open_docs.lock().await;
            let r = next_doc_version(&docs, &uri);
            docs.insert(uri, r.1);
            r
        };
        if first {
            // languageId 按扩展名精确映射(tsx → typescriptreact),
            // 不能用配置键 lang——见 `lsp_language_id` 文档
            client
                .did_open(abs_path, text, lsp_language_id(ext))
                .await?;
        } else {
            client.did_change(abs_path, text, version).await?;
        }
        if save {
            client.did_save(abs_path, text).await?;
        }
        Ok(Some(lang))
    }

    /// 等待并返回某文件的结构化诊断(编辑器场景,轻量等待):
    /// 轮询直到 server 推送该 uri 的诊断(上限 `wait_ms`),出现后再做短稳定
    /// 窗口(连续两次条数相同即认为稳定,上限 400ms),返回精简后的 JSON 数组。
    /// 超时返回当前缓存(可能为空——如 rust-analyzer 首次冷启动仍在分析,
    /// 前端稍后重试即可)。扩展名无对应 server 时返回 Ok(None)。
    pub async fn diagnostics_for_editor(
        &self,
        abs_path: &Path,
        ext: &str,
        wait_ms: u64,
    ) -> Result<Option<Vec<Value>>> {
        let Some(lang) = self.lang_for_ext(ext) else {
            return Ok(None);
        };
        let client = self.client_for(&lang).await?;
        let uri = path_to_uri(abs_path);
        let cache = client.diagnostics.clone();
        // 1. 等待 uri 首次出现(server 已开始处理)
        let deadline = std::time::Instant::now() + std::time::Duration::from_millis(wait_ms);
        while !cache.lock().await.contains_key(&uri) {
            if std::time::Instant::now() >= deadline {
                return Ok(Some(Vec::new()));
            }
            tokio::time::sleep(std::time::Duration::from_millis(40)).await;
        }
        // 2. 稳定窗口:server 对同一次变更可能连发多批,条数不再变化即返回
        let stable_deadline = std::time::Instant::now() + std::time::Duration::from_millis(400);
        let mut prev_len: Option<usize> = None;
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(120)).await;
            let cur = cache.lock().await.get(&uri).cloned().unwrap_or_default();
            if prev_len == Some(cur.len()) {
                return Ok(Some(cur.into_iter().map(slim_diagnostic).collect()));
            }
            prev_len = Some(cur.len());
            if std::time::Instant::now() >= stable_deadline {
                let last = cache.lock().await.get(&uri).cloned().unwrap_or_default();
                return Ok(Some(last.into_iter().map(slim_diagnostic).collect()));
            }
        }
    }

    /// 获取文件诊断(错误/警告)。返回人类可读的多行文本。
    pub async fn diagnostics(&self, abs_path: &Path, ext: &str) -> Result<String> {        let lang = self
            .lang_for_ext(ext)
            .ok_or_else(|| anyhow::anyhow!("扩展名 `.{ext}` 无对应 LSP server"))?;
        let client = self.client_for(&lang).await?;
        self.ensure_opened(client.as_ref(), abs_path).await?;
        let diags = client.get_diagnostics(abs_path).await;
        Ok(format_diagnostics(&diags, abs_path))
    }

    /// 跳转定义,返回格式化位置列表。
    pub async fn definition(&self, abs_path: &Path, ext: &str, line: u32, col: u32) -> Result<String> {
        let lang = self
            .lang_for_ext(ext)
            .ok_or_else(|| anyhow::anyhow!("扩展名 `.{ext}` 无对应 LSP server"))?;
        let client = self.client_for(&lang).await?;
        self.ensure_opened(client.as_ref(), abs_path).await?;
        let locs = client.definition(abs_path, line, col).await?;
        Ok(format_locations(&locs))
    }

    /// 查找引用,返回格式化位置列表。
    pub async fn references(&self, abs_path: &Path, ext: &str, line: u32, col: u32) -> Result<String> {
        let lang = self
            .lang_for_ext(ext)
            .ok_or_else(|| anyhow::anyhow!("扩展名 `.{ext}` 无对应 LSP server"))?;
        let client = self.client_for(&lang).await?;
        self.ensure_opened(client.as_ref(), abs_path).await?;
        let locs = client.references(abs_path, line, col).await?;
        Ok(format_locations(&locs))
    }

    /// hover,返回文档文本。
    pub async fn hover(&self, abs_path: &Path, ext: &str, line: u32, col: u32) -> Result<String> {
        let lang = self
            .lang_for_ext(ext)
            .ok_or_else(|| anyhow::anyhow!("扩展名 `.{ext}` 无对应 LSP server"))?;
        let client = self.client_for(&lang).await?;
        self.ensure_opened(client.as_ref(), abs_path).await?;
        let text = client.hover(abs_path, line, col).await?;
        Ok(text.unwrap_or_else(|| "无 hover 信息".into()))
    }
}

/// 把诊断数组格式化为可读文本。
fn format_diagnostics(diags: &[Value], abs_path: &Path) -> String {
    if diags.is_empty() {
        return format!("{}: 无诊断(0 error/warning)", abs_path.display());
    }
    let mut out = String::new();
    let mut errors = 0;
    let mut warnings = 0;
    for d in diags {
        let severity = d.get("severity").and_then(Value::as_u64).unwrap_or(0);
        let kind = match severity {
            1 => {
                errors += 1;
                "error"
            }
            2 => {
                warnings += 1;
                "warning"
            }
            3 => "info",
            4 => "hint",
            _ => "?",
        };
        let msg = d.get("message").and_then(Value::as_str).unwrap_or("");
        let line = d
            .get("range")
            .and_then(|r| r.get("start"))
            .and_then(|s| s.get("line"))
            .and_then(Value::as_u64)
            .map(|n| n + 1)
            .unwrap_or(0);
        let col = d
            .get("range")
            .and_then(|r| r.get("start"))
            .and_then(|s| s.get("character"))
            .and_then(Value::as_u64)
            .map(|n| n + 1)
            .unwrap_or(0);
        out.push_str(&format!("  [{kind}] {msg} ({}:{}:{})\n", abs_path.display(), line, col));
    }
    format!(
        "{}:{} error, {} warning\n{}",
        abs_path.display(),
        errors,
        warnings,
        out.trim_end()
    )
}

/// 把位置数组格式化为可读文本。
fn format_locations(locs: &[Value]) -> String {
    if locs.is_empty() {
        return "无结果".into();
    }
    let mut out = String::new();
    for loc in locs {
        let uri = loc
            .get("uri")
            .or_else(|| loc.get("targetUri"))
            .and_then(Value::as_str)
            .unwrap_or("");
        let path = uri_to_path(uri);
        let (line, col) = loc
            .get("range")
            .or_else(|| loc.get("targetSelectionRange"))
            .and_then(|r| r.get("start"))
            .map(|s| {
                (
                    s.get("line").and_then(Value::as_u64).unwrap_or(0) + 1,
                    s.get("character").and_then(Value::as_u64).unwrap_or(0) + 1,
                )
            })
            .unwrap_or((0, 0));
        out.push_str(&format!("  {}:{}:{}\n", path, line, col));
    }
    out.trim_end().to_string()
}

/// `file://` URI → 本地路径。
fn uri_to_path(uri: &str) -> String {
    uri.strip_prefix("file://").unwrap_or(uri).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn finds_executable_on_path() {
        assert!(find_executable("/bin/ls").is_some());
        assert!(find_executable("/nonexistent/xyz").is_none());
    }

    #[test]
    fn extra_bin_dirs_cover_common_user_installs() {
        let home = Path::new("/Users/tester");
        let dirs = extra_bin_dirs(Some(home));
        assert!(dirs.contains(&PathBuf::from("/Users/tester/.cargo/bin")), "rustup 目录: {dirs:?}");
        assert!(dirs.contains(&PathBuf::from("/Users/tester/.local/bin")), "pipx/uv 目录: {dirs:?}");
        assert!(dirs.contains(&PathBuf::from("/usr/local/bin")), "Intel Homebrew/手动安装: {dirs:?}");
        // 无 HOME(异常环境)时仍给出系统级目录,不 panic
        assert!(!extra_bin_dirs(None).is_empty());
    }

    /// PATH 之外的兜底目录应能命中:GUI 进程 PATH 缺 ~/.cargo/bin 时,
    /// rustup 安装的 rust-analyzer 仍可被找到(检测与 spawn 共用该口径)。
    #[test]
    fn find_in_dirs_hits_user_cargo_bin_beyond_path() {
        let dir = tempfile::tempdir().unwrap();
        let cargo_bin = dir.path().join(".cargo").join("bin");
        std::fs::create_dir_all(&cargo_bin).unwrap();
        let exe = cargo_bin.join("rust-analyzer");
        std::fs::write(&exe, b"#!/bin/sh\nexit 0\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        // 「PATH」为空目录,可执行文件只在兜底的 ~/.cargo/bin
        let empty_path = dir.path().join("empty-bin");
        std::fs::create_dir_all(&empty_path).unwrap();
        let dirs = std::iter::once(empty_path).chain(extra_bin_dirs(Some(dir.path())));
        let found = find_in_dirs("rust-analyzer", dirs).expect("应命中 ~/.cargo/bin 兜底目录");
        assert_eq!(found, exe);
        // 不存在的命令仍为 None
        assert!(find_in_dirs("nope", extra_bin_dirs(Some(dir.path()))).is_none());
    }

    #[test]
    fn ext_to_lang_maps_common() {
        assert_eq!(ext_to_lang("rs"), Some("rust"));
        assert_eq!(ext_to_lang("py"), Some("python"));
        assert_eq!(ext_to_lang("ts"), Some("typescript"));
        assert_eq!(ext_to_lang("tsx"), Some("typescript"));
        assert_eq!(ext_to_lang("unknown"), None);
    }

    /// languageId 必须与配置键分离:tsx/jsx 是 LSP 协议的独立语言标识,
    /// 报错成 typescript/javascript 会导致 JSX 被纯 TS/JS 语法解析而报错。
    #[test]
    fn language_id_distinguishes_react_extensions() {
        assert_eq!(lsp_language_id("ts"), "typescript");
        assert_eq!(lsp_language_id("tsx"), "typescriptreact");
        assert_eq!(lsp_language_id("mts"), "typescript");
        assert_eq!(lsp_language_id("js"), "javascript");
        assert_eq!(lsp_language_id("jsx"), "javascriptreact");
        assert_eq!(lsp_language_id("rs"), "rust");
        assert_eq!(lsp_language_id("unknown"), "plaintext");
    }

    /// spawn 前的裸命令解析:路径原样、查不到的裸命令原样返回。
    #[test]
    fn resolve_spawn_program_passthrough_variants() {
        // 已是路径:原样返回(存在性交由 spawn 报错)
        assert_eq!(resolve_spawn_program("/opt/x/npm"), "/opt/x/npm");
        // 查不到的裸命令:原样返回
        let missing = "combo-definitely-missing-xyz";
        assert_eq!(resolve_spawn_program(missing), missing);
    }

    /// PATH 内的裸命令应解析为绝对路径(unix 上 sh 必在系统 PATH)。
    #[cfg(unix)]
    #[test]
    fn resolve_spawn_program_resolves_bare_command_on_path() {
        let p = resolve_spawn_program("sh");
        assert!(p.starts_with('/'), "应解析为绝对路径: {p}");
    }

    /// PATH 之外的兜底目录(~/.cargo/bin 等)也应命中:GUI 启动的进程
    /// PATH 只有系统目录,Homebrew/rustup 等方式安装的包管理器只在兜底
    /// 目录里——检测与 spawn 共用该口径,否则出现「显示可安装、启动报
    /// os error 2」(回归:typescript 一键安装 npm 启动失败)。
    #[cfg(unix)]
    #[test]
    fn resolve_spawn_program_falls_back_to_user_bin_dirs() {
        let dir = tempfile::tempdir().unwrap();
        let cargo_bin = dir.path().join(".cargo").join("bin");
        std::fs::create_dir_all(&cargo_bin).unwrap();
        // 名字刻意取 PATH 中不可能存在的,保证只能由兜底目录命中
        let exe = cargo_bin.join("combo-test-fake-npm");
        std::fs::write(&exe, b"#!/bin/sh\nexit 0\n").unwrap();
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let old_home = std::env::var("HOME").ok();
        std::env::set_var("HOME", dir.path());
        let resolved = resolve_spawn_program("combo-test-fake-npm");
        // 恢复 HOME,缩小对并行测试的可见窗口
        if let Some(h) = old_home {
            std::env::set_var("HOME", h);
        }
        assert_eq!(
            std::path::PathBuf::from(&resolved),
            exe,
            "兜底目录中的命令应解析为绝对路径"
        );
    }

    /// spawn 子进程 PATH 构造:命令所在目录排最前(shebang 解释器优先命中
    /// 同目录的同版本),且目录去重、不丢进程 PATH。
    #[test]
    fn spawn_path_for_puts_program_dir_first_and_dedups() {
        let dir = tempfile::tempdir().unwrap();
        let prog = dir.path().join("npm");
        let p = spawn_path_for(Some(prog.to_str().unwrap()));
        let sep = if cfg!(windows) { ';' } else { ':' };
        let first = p.split(sep).next().unwrap();
        assert_eq!(
            PathBuf::from(first),
            dir.path(),
            "命令所在目录应排最前: {p}"
        );
        assert_eq!(
            p.split(sep).filter(|d| *d == first).count(),
            1,
            "目录应去重(兜底目录与命令目录重叠时不重复): {p}"
        );
        // 无命令时也应给出可用 PATH(登录 shell/进程 PATH/兜底目录合并)
        assert!(!spawn_path_for(None).is_empty());
    }

    /// 语言统计:按扩展名聚合、跳过忽略目录/隐藏文件、按文件数降序。
    #[test]
    fn count_languages_aggregates_and_skips_ignored() {
        let dir = tempfile::tempdir().unwrap();
        let mk = |rel: &str| {
            let p = dir.path().join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, b"").unwrap();
        };
        mk("src/main.rs");
        mk("src/lib.rs");
        mk("src/ui/mod.rs");
        mk("web/app.ts");
        mk("web/util.tsx");
        mk("web/vite.config.mts");
        // 应被跳过:忽略目录、隐藏文件、非源码扩展名
        mk("node_modules/pkg/index.js");
        mk("target/debug/x.rs");
        mk(".hidden/secret.rs");
        mk(".env.rs");
        mk("README.md");

        let (langs, truncated) = count_languages(dir.path());
        assert!(!truncated);
        let flat: Vec<(String, usize)> = langs;
        assert_eq!(
            flat,
            vec![
                ("rust".to_string(), 3),
                ("typescript".to_string(), 3),
            ],
            "rust 与 typescript 各 3 个,同数按字母序;javascript/bash 不出现"
        );
    }

    /// 大扩展名统一小写后再映射(Windows 下的 Main.RS)。
    #[test]
    fn count_languages_lowercases_extension() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("Main.RS"), b"").unwrap();
        let (langs, _) = count_languages(dir.path());
        assert_eq!(langs, vec![("rust".to_string(), 1)]);
    }

    #[test]
    fn install_plans_resolve_by_available_pm() {
        // rust:只有 rustup → rustup 方案
        let (display, argv) =
            resolve_install_command_with("rust", |b| b == "rustup").unwrap();
        assert_eq!(argv, vec!["rustup", "component", "add", "rust-analyzer"]);
        assert_eq!(display, "rustup component add rust-analyzer");

        // rust:只有 brew → 回退 brew
        let (display, _) = resolve_install_command_with("rust", |b| b == "brew").unwrap();
        assert_eq!(display, "brew install rust-analyzer");

        // typescript:npm 与 pnpm 同时可用 → npm 优先
        let (display, _) =
            resolve_install_command_with("typescript", |b| b == "pnpm" || b == "npm").unwrap();
        assert!(display.starts_with("npm install"), "应优先 npm:{display}");

        // 无任何包管理器 → None;未收录语言 → None
        assert!(resolve_install_command_with("typescript", |_| false).is_none());
        assert!(resolve_install_command_with("cobol", |_| true).is_none());

        // 方案自带的 server 配置与文档一致
        let ts = install_plan("typescript").unwrap();
        assert_eq!(ts.server_command, "typescript-language-server");
        assert_eq!(ts.server_args, Some(&["--stdio"][..]));
        // 每个收录的语言都能被 ext_to_lang 路由到(配置后立即生效的前提)
        for p in LSP_INSTALL_PLANS {
            assert!(
                ext_to_lang(match p.lang {
                    "rust" => "rs",
                    "typescript" => "ts",
                    "javascript" => "js",
                    "python" => "py",
                    "go" => "go",
                    _ => unreachable!(),
                })
                .is_some(),
                "{} 应可按扩展名路由",
                p.lang
            );
        }
    }

    /// 构造带临时目录 workspace 的测试 AppState(不配置任何 LSP server)。
    fn lsp_test_state(tag: &str) -> (AppState, PathBuf) {
        let dir = std::env::temp_dir().join(format!("combo-lspdoc-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("src")).unwrap();
        std::fs::write(dir.join("src/main.rs"), "fn main() {}\n").unwrap();
        let meta = std::sync::Arc::new(crate::meta::MetaStore::new());
        meta.insert(crate::meta::WorkspaceMeta {
            id: "ws".into(),
            path: dir.clone(),
            name: "test".into(),
            backend_type: crate::store::BackendType::ComboCli,
        });
        (AppState::test_state(meta, None), dir)
    }

    /// 读取 axum Response 的 JSON body。
    async fn body_json(resp: Response) -> Value {
        let bytes = axum::body::to_bytes(resp.into_body(), 1024 * 1024).await.unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    /// next_doc_version:首次 → didOpen(version=1);已打开 → didChange(递增)。
    #[test]
    fn next_doc_version_first_then_increment() {
        let mut docs = HashMap::new();
        assert_eq!(next_doc_version(&docs, "file:///a.rs"), (true, 1));
        docs.insert("file:///a.rs".to_string(), 1);
        assert_eq!(next_doc_version(&docs, "file:///a.rs"), (false, 2));
        docs.insert("file:///a.rs".to_string(), 7);
        assert_eq!(next_doc_version(&docs, "file:///a.rs"), (false, 8));
        // 其他文件不受影响
        assert_eq!(next_doc_version(&docs, "file:///b.rs"), (true, 1));
    }

    /// slim_diagnostic:range/severity/message/source 展开为扁平字段,缺字段给安全默认。
    #[test]
    fn slim_diagnostic_maps_and_defaults() {
        let full = json!({
            "range": {
                "start": { "line": 3, "character": 8 },
                "end": { "line": 3, "character": 12 },
            },
            "severity": 1,
            "message": "expected `;`",
            "source": "rust-analyzer",
        });
        let slim = slim_diagnostic(full);
        assert_eq!(slim["line"], json!(3));
        assert_eq!(slim["character"], json!(8));
        assert_eq!(slim["endLine"], json!(3));
        assert_eq!(slim["endCharacter"], json!(12));
        assert_eq!(slim["severity"], json!(1));
        assert_eq!(slim["message"], json!("expected `;`"));
        assert_eq!(slim["source"], json!("rust-analyzer"));

        // 缺 range/severity/source:位置 0、severity 回落 3(info)、source null
        let empty = slim_diagnostic(json!({ "message": "x" }));
        assert_eq!(empty["line"], json!(0));
        assert_eq!(empty["severity"], json!(3));
        assert_eq!(empty["source"], json!(null));
    }

    /// 未配置任何 LSP server 时,文档同步直接返回 language:null(不启动子进程)。
    #[tokio::test]
    async fn lsp_document_sync_without_config_returns_null_language() {
        let (state, _dir) = lsp_test_state("no-config");
        let resp = lsp_document_sync(
            State(state),
            AxumPath("ws".into()),
            axum::Json(LspDocumentBody {
                path: "src/main.rs".into(),
                text: "fn main() {".into(),
                saved: false,
            }),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);
        let v = body_json(resp).await;
        assert_eq!(v["language"], json!(null));
    }

    /// 路径越出 workspace 根目录 → 400(与文件服务同口径的 safe_join 校验)。
    #[tokio::test]
    async fn lsp_document_sync_rejects_path_escape() {
        let (state, _dir) = lsp_test_state("escape");
        let resp = lsp_document_sync(
            State(state),
            AxumPath("ws".into()),
            axum::Json(LspDocumentBody {
                path: "../outside.rs".into(),
                text: String::new(),
                saved: false,
            }),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    }

    /// 诊断端点:缺 path 参数 → 400;未配置 server → language:null + 空列表。
    #[tokio::test]
    async fn lsp_document_diagnostics_validations() {
        let (state, _dir) = lsp_test_state("diag");
        let resp = lsp_document_diagnostics(
            State(state.clone()),
            AxumPath("ws".into()),
            axum::extract::Query(HashMap::new()),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);

        let mut q = HashMap::new();
        q.insert("path".to_string(), "src/main.rs".to_string());
        let resp = lsp_document_diagnostics(State(state), AxumPath("ws".into()), axum::extract::Query(q)).await;
        assert_eq!(resp.status(), StatusCode::OK);
        let v = body_json(resp).await;
        assert_eq!(v["language"], json!(null));
        assert_eq!(v["diagnostics"], json!([]));
    }

    #[test]
    fn path_to_uri_absolute() {
        let u = path_to_uri(Path::new("/tmp/x.rs"));
        assert!(u.starts_with("file://"));
        assert!(u.ends_with("/tmp/x.rs"));
    }

    #[test]
    fn uri_to_path_inverse() {
        let p = uri_to_path("file:///tmp/x.rs");
        assert_eq!(p, "/tmp/x.rs");
    }

    #[test]
    fn location_list_normalizes() {
        let empty: Vec<Value> = location_list(Value::Null);
        assert!(empty.is_empty());
        let one = json!({"uri": "file:///a.rs"});
        assert_eq!(location_list(one.clone()), vec![one]);
        let arr = json!([{"uri": "file:///a.rs"}, {"uri": "file:///b.rs"}]);
        assert_eq!(location_list(arr).len(), 2);
    }

    #[test]
    fn format_diagnostics_empty_and_filled() {
        let s = format_diagnostics(&[], Path::new("/x.rs"));
        assert!(s.contains("无诊断"));
        let d = json!([{
            "severity": 1,
            "message": "missing semicolon",
            "range": { "start": { "line": 3, "character": 9 } }
        }]);
        let arr = d.as_array().unwrap();
        let s = format_diagnostics(arr, Path::new("/x.rs"));
        assert!(s.contains("1 error"));
        assert!(s.contains("missing semicolon"));
        assert!(s.contains("/x.rs:4:10"));
    }

    #[test]
    fn format_locations_empty_and_filled() {
        assert_eq!(format_locations(&[]), "无结果");
        let locs = json!([{
            "uri": "file:///a/b.rs",
            "range": { "start": { "line": 5, "character": 2 } }
        }]);
        let arr = locs.as_array().unwrap();
        let s = format_locations(arr);
        assert!(s.contains("/a/b.rs:6:3"));
    }

    #[test]
    fn extract_hover_variants() {
        assert_eq!(extract_hover_text(&json!("plain")), Some("plain".into()));
        let v = json!({ "contents": { "kind": "markdown", "value": "# h" } });
        assert_eq!(extract_hover_text(&v), Some("# h".into()));
        assert_eq!(extract_hover_text(&Value::Null), None);
    }

    /// 真实集成测试:用 rust-analyzer 验证 LSP 客户端能启动并返回诊断。
    /// 需系统装有 rust-analyzer;用 `cargo test -p combo-cli -- --ignored lsp_real` 运行。
    #[tokio::test]
    #[ignore]
    async fn lsp_real_rust_analyzer_diagnostics() {
        let dir = tempfile::tempdir().unwrap();
        // 故意写一个有错误的 Rust 文件
        std::fs::write(
            dir.path().join("bad.rs"),
            "fn main() { let x: u32 = \"not a number\"; }\n",
        )
        .unwrap();
        // 伪装成 cargo 项目(rust-analyzer 需要 Cargo.toml 才能完整分析)
        std::fs::write(
            dir.path().join("Cargo.toml"),
            "[package]\nname = \"bad\"\nversion = \"0.1.0\"\nedition = \"2021\"\n",
        )
        .unwrap();
        std::fs::create_dir_all(dir.path().join("src")).unwrap();
        std::fs::rename(dir.path().join("bad.rs"), dir.path().join("src/main.rs")).unwrap();

        let mut configs = BTreeMap::new();
        configs.insert(
            "rust".into(),
            LspServerConfig {
                command: "rust-analyzer".into(),
                args: None,
                env: None,
            },
        );
        let manager = LspManager::new(dir.path().to_path_buf(), configs);
        let path = dir.path().join("src/main.rs");
        let result = manager
            .diagnostics(&path, "rs")
            .await
            .expect("LSP 诊断应成功");
        eprintln!("诊断结果:\n{result}");
        // rust-analyzer 应该报告了不匹配错误(具体文案因版本而异,断言非空即可)
        assert!(!result.contains("无诊断"), "应检测到类型错误: {result}");
    }
}
