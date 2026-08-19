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
        let mut cmd = tokio::process::Command::new(&resolved);
        cmd.args(args);
        for (k, v) in env {
            cmd.env(k, v);
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

        // 启动 stdout 读循环
        tokio::spawn(read_loop(
            BufReader::new(stdout),
            pending.clone(),
            diagnostics.clone(),
        ));

        let mut client = Self {
            stdin: Arc::new(Mutex::new(stdin)),
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

        // response(id 匹配)
        if let Some(id) = msg.get("id").and_then(Value::as_u64) {
            if let Some(tx) = pending.lock().await.remove(&id) {
                let _ = tx.send(msg);
            }
            continue;
        }
        // notification
        if let Some(method) = msg.get("method").and_then(Value::as_str) {
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
pub struct LspManager {
    workspace_root: PathBuf,
    configs: BTreeMap<String, LspServerConfig>,
    clients: Mutex<HashMap<String, Arc<LspClient>>>,
}

impl LspManager {
    pub fn new(workspace_root: PathBuf, configs: BTreeMap<String, LspServerConfig>) -> Self {
        Self {
            workspace_root,
            configs,
            clients: Mutex::new(HashMap::new()),
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

    /// 打开文件(若未打开)并等待诊断就绪。
    ///
    /// LSP server(如 rust-analyzer)首次加载项目可能先推送空诊断,
    /// 分析完成后才推送实际诊断。因此等待策略:
    /// 1. 轮询直到 diagnostics 中出现该文件 uri(最多 30s);
    /// 2. 继续轮询直到诊断稳定(连续 3 次读取相同)或非空,最多再等 10s。
    async fn ensure_opened(&self, client: &LspClient, abs_path: &Path, lang: &str) -> Result<()> {
        let text = std::fs::read_to_string(abs_path)
            .map_err(|e| anyhow::anyhow!("读取文件失败 {}: {e}", abs_path.display()))?;
        client.did_open(abs_path, &text, lang).await?;
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

    /// 获取文件诊断(错误/警告)。返回人类可读的多行文本。
    pub async fn diagnostics(&self, abs_path: &Path, ext: &str) -> Result<String> {
        let lang = self
            .lang_for_ext(ext)
            .ok_or_else(|| anyhow::anyhow!("扩展名 `.{ext}` 无对应 LSP server"))?;
        let client = self.client_for(&lang).await?;
        self.ensure_opened(client.as_ref(), abs_path, &lang).await?;
        let diags = client.get_diagnostics(abs_path).await;
        Ok(format_diagnostics(&diags, abs_path))
    }

    /// 跳转定义,返回格式化位置列表。
    pub async fn definition(&self, abs_path: &Path, ext: &str, line: u32, col: u32) -> Result<String> {
        let lang = self
            .lang_for_ext(ext)
            .ok_or_else(|| anyhow::anyhow!("扩展名 `.{ext}` 无对应 LSP server"))?;
        let client = self.client_for(&lang).await?;
        self.ensure_opened(client.as_ref(), abs_path, &lang).await?;
        let locs = client.definition(abs_path, line, col).await?;
        Ok(format_locations(&locs))
    }

    /// 查找引用,返回格式化位置列表。
    pub async fn references(&self, abs_path: &Path, ext: &str, line: u32, col: u32) -> Result<String> {
        let lang = self
            .lang_for_ext(ext)
            .ok_or_else(|| anyhow::anyhow!("扩展名 `.{ext}` 无对应 LSP server"))?;
        let client = self.client_for(&lang).await?;
        self.ensure_opened(client.as_ref(), abs_path, &lang).await?;
        let locs = client.references(abs_path, line, col).await?;
        Ok(format_locations(&locs))
    }

    /// hover,返回文档文本。
    pub async fn hover(&self, abs_path: &Path, ext: &str, line: u32, col: u32) -> Result<String> {
        let lang = self
            .lang_for_ext(ext)
            .ok_or_else(|| anyhow::anyhow!("扩展名 `.{ext}` 无对应 LSP server"))?;
        let client = self.client_for(&lang).await?;
        self.ensure_opened(client.as_ref(), abs_path, &lang).await?;
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
