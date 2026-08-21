//! 本地文件服务:仅接管 `/v1/workspaces/{id}/files/*` 的读写。
//! workspace 的真实路径从 sqlite 元数据(`MetaStore`)直接获取,不依赖后端在线,
//! 之后所有相对路径都在该根目录内做 canonicalize 前缀校验,防止目录穿越
//! 与 symlink 逃逸。

use axum::body::Body;
use axum::extract::{Path, Query, State};
use axum::http::{header, StatusCode};
use axum::response::Response;
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::{Component, Path as FsPath, PathBuf};
use tokio::process::Command as TokioCommand;

use crate::serve::AppState;

/// 单文件读取上限(1MB),超过视为过大。
const MAX_FILE_BYTES: u64 = 1024 * 1024;
/// 二进制文件(图片/PDF)读取上限(20MB)。
const MAX_RAW_BYTES: u64 = 20 * 1024 * 1024;

/// 根据扩展名推断 content-type。
fn mime_for(name: &str) -> &'static str {
    let lower = name.to_lowercase();
    let ext = lower.rsplit_once('.').map(|(_, e)| e).unwrap_or("");
    match ext {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        "pdf" => "application/pdf",
        _ => "application/octet-stream",
    }
}

/// 从 sqlite 元数据解析 workspace 根目录。
pub fn resolve_root(state: &AppState, id: &str) -> Result<PathBuf, Response> {
    match state.meta.get(id) {
        Some(m) => Ok(m.path),
        None => Err(error(StatusCode::NOT_FOUND, "workspace 不存在")),
    }
}

#[derive(Deserialize)]
pub struct PathQuery {
    pub path: Option<String>,
}

#[derive(Deserialize)]
pub struct WriteBody {
    pub content: String,
}

/// 上传文件大小上限(20MB,与二进制读取上限 MAX_RAW_BYTES 一致)。
pub const MAX_UPLOAD_BYTES: usize = 20 * 1024 * 1024;

/// 清洗上传文件名:先取最后一段路径(输入可能带 `/`、`\` 分隔符),
/// 再去掉各平台非法字符、空白收敛为单个 `-`,过长截断(保留扩展名),
/// 空结果回退 `upload-<毫秒时间戳>`。
fn sanitize_upload_name(name: &str) -> String {
    // 取最后一段:带路径的输入(`a/b/c.png`、`../../evil.txt`)只保留文件名
    let last_seg = name
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("")
        .trim();
    let cleaned: String = last_seg
        .chars()
        .map(|c| match c {
            ':' | '*' | '?' | '"' | '<' | '>' | '|' => '-',
            c if c.is_control() => '-',
            c => c,
        })
        .collect();
    let cleaned = cleaned.trim_matches(|c: char| c == '.' || c.is_whitespace()).to_string();
    let cleaned = cleaned
        .split_whitespace()
        .collect::<Vec<_>>()
        .join("-");
    if cleaned.is_empty() {
        return format!("upload-{}", chrono::Utc::now().timestamp_millis());
    }
    // 超长截断:保留扩展名,主干最多 80 字符
    let p = FsPath::new(&cleaned);
    let stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or("upload");
    let ext = p.extension().and_then(|e| e.to_str());
    let mut stem: String = stem.chars().take(80).collect();
    if stem.is_empty() {
        stem = "upload".into();
    }
    match ext {
        Some(e) if !e.is_empty() => format!("{stem}.{}", e.chars().take(16).collect::<String>()),
        _ => stem,
    }
}

/// 目标文件已存在时生成不冲突的文件名:`name (n).ext`(n 从 1 递增)。
fn dedupe_upload_path(dir: &FsPath, name: &str) -> PathBuf {
    let candidate = dir.join(name);
    if !candidate.exists() {
        return candidate;
    }
    let p = FsPath::new(name);
    let stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or("upload");
    let ext = p.extension().and_then(|e| e.to_str());
    for n in 1..1000u32 {
        let next = match ext {
            Some(e) => format!("{stem} ({n}).{e}"),
            None => format!("{stem} ({n})"),
        };
        let candidate = dir.join(next);
        if !candidate.exists() {
            return candidate;
        }
    }
    // 兜底:毫秒时间戳几乎不可能冲突
    dir.join(format!(
        "{stem}-{}.{}",
        chrono::Utc::now().timestamp_millis(),
        ext.unwrap_or("bin")
    ))
}


fn json_response(status: StatusCode, value: serde_json::Value) -> Response {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(value.to_string()))
        .unwrap()
}

pub fn ok_json(value: serde_json::Value) -> Response {
    json_response(StatusCode::OK, value)
}

pub fn error(status: StatusCode, message: &str) -> Response {
    json_response(status, json!({ "message": message }))
}

/// 绝对路径若在 workspace 根目录内,转为相对路径;否则原样返回(由后续 component 检查拒绝)。
/// 对于已存在的文件/目录:canonicalize 后做前缀校验。
/// 对于尚不存在的路径:canonicalize 父目录后做前缀校验。
fn normalize_abs_path(root: &FsPath, rel: &str) -> anyhow::Result<String> {
    let p = FsPath::new(rel);
    if !p.is_absolute() {
        return Ok(rel.to_string());
    }
    // 文件已存在:canonicalize 整条路径后做前缀校验
    if let Ok(canon) = std::fs::canonicalize(p) {
        if !canon.starts_with(root) {
            anyhow::bail!("路径越出 workspace 根目录");
        }
        return Ok(canon.strip_prefix(root).unwrap().to_string_lossy().to_string());
    }
    // 文件不存在:canonicalize 父目录后做前缀校验
    let parent = match p.parent() {
        Some(par) if !par.as_os_str().is_empty() => par,
        _ => anyhow::bail!("路径越出 workspace 根目录"),
    };
    let canon_parent = std::fs::canonicalize(parent)
        .map_err(|_| anyhow::anyhow!("路径越出 workspace 根目录"))?;
    if !canon_parent.starts_with(root) {
        anyhow::bail!("路径越出 workspace 根目录");
    }
    let filename = p
        .file_name()
        .ok_or_else(|| anyhow::anyhow!("无效路径"))?;
    Ok(canon_parent
        .strip_prefix(root)
        .unwrap()
        .join(filename)
        .to_string_lossy()
        .to_string())
}

/// 在 workspace 根内安全拼接相对路径。
/// 逐段拒绝绝对路径与 `..`;canonicalize 最深已存在祖先后做前缀校验,
/// 若目标本身是符号链接再做一次最终校验,阻止逃逸到根目录之外。
/// 绝对路径若在 workspace 根目录内则自动转为相对路径。
pub fn safe_join(root: &FsPath, rel: &str) -> anyhow::Result<PathBuf> {
    let root = std::fs::canonicalize(root)
        .map_err(|e| anyhow::anyhow!("无法访问 workspace 根目录: {e}"))?;
    if !root.is_dir() {
        anyhow::bail!("workspace 根目录不是文件夹");
    }
    // 绝对路径:在 workspace 根目录内则转为相对路径,否则拒绝
    let rel = normalize_abs_path(&root, rel)?;
    let mut clean = PathBuf::new();
    for comp in FsPath::new(&rel).components() {
        match comp {
            Component::Normal(p) => clean.push(p),
            Component::CurDir => {}
            Component::ParentDir => anyhow::bail!("不允许访问上级目录"),
            Component::RootDir | Component::Prefix(_) => anyhow::bail!("不允许绝对路径"),
        }
    }
    let target = root.join(clean);
    // 找到目标路径上最深已存在的祖先
    let mut existing = target.as_path();
    loop {
        if existing.exists() {
            break;
        }
        match existing.parent() {
            Some(p) => existing = p,
            None => anyhow::bail!("非法路径"),
        }
    }
    let canonical = std::fs::canonicalize(existing)
        .map_err(|e| anyhow::anyhow!("无法解析路径: {e}"))?;
    if !canonical.starts_with(&root) {
        anyhow::bail!("路径越出 workspace 根目录");
    }
    // 目标本身是符号链接(含断链)时做最终校验
    if target
        .symlink_metadata()
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false)
    {
        let target_canon = std::fs::canonicalize(&target)
            .map_err(|e| anyhow::anyhow!("无法解析目标路径: {e}"))?;
        if !target_canon.starts_with(&root) {
            anyhow::bail!("路径越出 workspace 根目录");
        }
    }
    Ok(target)
}

/// GET /v1/workspaces/{id}/files/list?path=<相对目录>
/// 返回单层目录条目:dir 在前,file 在后,各按名称排序。
pub async fn list(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<PathQuery>,
) -> Response {
    let root = match resolve_root(&state, &id) {
        Ok(r) => r,
        Err(resp) => return resp,
    };
    let rel = q.path.unwrap_or_default();
    let dir = match safe_join(&root, &rel) {
        Ok(d) => d,
        Err(e) => return error(StatusCode::BAD_REQUEST, &e.to_string()),
    };
    let rd = match std::fs::read_dir(&dir) {
        Ok(rd) => rd,
        Err(_) => return error(StatusCode::NOT_FOUND, "目录不存在"),
    };
    let mut entries = Vec::new();
    for entry in rd.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue; // 隐藏文件(如 .git)不进文件树
        }
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        let rel_path = if rel.is_empty() {
            name.clone()
        } else {
            format!("{rel}/{name}")
        };
        let size = if is_dir {
            0
        } else {
            entry.metadata().map(|m| m.len()).unwrap_or(0)
        };
        entries.push(json!({
            "name": name,
            "path": rel_path,
            "type": if is_dir { "dir" } else { "file" },
            "size": size,
        }));
    }
    entries.sort_by(|a, b| {
        let ta = a["type"].as_str().unwrap_or("file");
        let tb = b["type"].as_str().unwrap_or("file");
        ta.cmp(tb).then_with(|| {
            a["name"]
                .as_str()
                .unwrap_or("")
                .cmp(b["name"].as_str().unwrap_or(""))
        })
    });
    ok_json(json!(entries))
}

/// GET /v1/workspaces/{id}/files/content?path=<相对文件>
/// 读取文件文本;含 NUL 判定为二进制,超过 1MB 拒绝。
pub async fn read(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<PathQuery>,
) -> Response {
    let root = match resolve_root(&state, &id) {
        Ok(r) => r,
        Err(resp) => return resp,
    };
    let rel = match q.path {
        Some(p) if !p.is_empty() => p,
        _ => return error(StatusCode::BAD_REQUEST, "缺少 path 参数"),
    };
    let file = match safe_join(&root, &rel) {
        Ok(f) => f,
        Err(e) => return error(StatusCode::BAD_REQUEST, &e.to_string()),
    };
    let meta = match std::fs::metadata(&file) {
        Ok(m) => m,
        Err(_) => return error(StatusCode::NOT_FOUND, "文件不存在"),
    };
    if !meta.is_file() {
        return error(StatusCode::BAD_REQUEST, "目标是目录,不是文件");
    }
    if meta.len() > MAX_FILE_BYTES {
        return error(StatusCode::PAYLOAD_TOO_LARGE, "文件超过 1MB,无法在编辑器打开");
    }
    let bytes = match std::fs::read(&file) {
        Ok(b) => b,
        Err(e) => return error(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
    };
    if bytes.iter().take(8192).any(|&b| b == 0) {
        return error(StatusCode::UNSUPPORTED_MEDIA_TYPE, "二进制文件不支持编辑");
    }
    ok_json(json!({ "content": String::from_utf8_lossy(&bytes) }))
}

/// GET /v1/workspaces/{id}/files/raw?path=<相对文件>
/// 以原始字节返回文件(图片/PDF 等),根据扩展名设置 content-type。
pub async fn raw(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<PathQuery>,
) -> Response {
    let root = match resolve_root(&state, &id) {
        Ok(r) => r,
        Err(resp) => return resp,
    };
    let rel = match q.path {
        Some(p) if !p.is_empty() => p,
        _ => return error(StatusCode::BAD_REQUEST, "缺少 path 参数"),
    };
    let file = match safe_join(&root, &rel) {
        Ok(f) => f,
        Err(e) => return error(StatusCode::BAD_REQUEST, &e.to_string()),
    };
    let meta = match std::fs::metadata(&file) {
        Ok(m) => m,
        Err(_) => return error(StatusCode::NOT_FOUND, "文件不存在"),
    };
    if !meta.is_file() {
        return error(StatusCode::BAD_REQUEST, "目标是目录,不是文件");
    }
    if meta.len() > MAX_RAW_BYTES {
        return error(StatusCode::PAYLOAD_TOO_LARGE, "文件超过 20MB");
    }
    let bytes = match std::fs::read(&file) {
        Ok(b) => b,
        Err(e) => return error(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
    };
    let mime = mime_for(&rel);
    let file_name = std::path::Path::new(&rel)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("file");
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, mime)
        .header(
            header::CONTENT_DISPOSITION,
            format!("inline; filename=\"{}\"", file_name),
        )
        .header(header::CACHE_CONTROL, "no-cache")
        .body(Body::from(bytes))
        .unwrap()
}

/// PUT /v1/workspaces/{id}/files/content?path=<相对文件>  body: { "content": ... }
/// 原子写:同目录临时文件 + rename,避免写一半。
pub async fn write(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<PathQuery>,
    axum::extract::Json(body): axum::extract::Json<WriteBody>,
) -> Response {
    let root = match resolve_root(&state, &id) {
        Ok(r) => r,
        Err(resp) => return resp,
    };
    let rel = match q.path {
        Some(p) if !p.is_empty() => p,
        _ => return error(StatusCode::BAD_REQUEST, "缺少 path 参数"),
    };
    let file = match safe_join(&root, &rel) {
        Ok(f) => f,
        Err(e) => return error(StatusCode::BAD_REQUEST, &e.to_string()),
    };
    let parent = match file.parent() {
        Some(p) if p.is_dir() => p.to_path_buf(),
        _ => return error(StatusCode::BAD_REQUEST, "父目录不存在"),
    };
    let tmp = parent.join(format!(
        ".combo-{}-{}.tmp",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));
    if let Err(e) = std::fs::write(&tmp, body.content.as_bytes()) {
        let _ = std::fs::remove_file(&tmp);
        return error(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string());
    }
    match std::fs::rename(&tmp, &file) {
        Ok(_) => ok_json(json!({ "ok": true })),
        Err(e) => {
            let _ = std::fs::remove_file(&tmp);
            error(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string())
        }
    }
}

#[derive(Deserialize)]
pub struct UploadQuery {
    /// 目标目录(workspace 相对路径);缺省为 `.combo/uploads/<yyyy-mm-dd>`。
    pub dir: Option<String>,
    /// 上传文件名(会清洗,同名自动加序号);缺省按时间戳生成。
    pub name: Option<String>,
}

/// POST /v1/workspaces/{id}/files/upload?dir=<相对目录>&name=<文件名>
/// 请求体为原始二进制(非 multipart,前端直接 fetch 字节)。
///
/// 面向输入框粘贴/拖拽上传:目标目录不存在时自动创建,同名文件自动
/// `name (n).ext` 递增,写入走 tmp + rename 原子替换。返回最终写入的
/// workspace 相对路径,可直接作为附件 file_path 发给 agent。
///
/// 大小上限 20MB(路由挂 DefaultBodyLimit,见 serve.rs)。
pub async fn upload(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<UploadQuery>,
    body: axum::body::Bytes,
) -> Response {
    if body.is_empty() {
        return error(StatusCode::BAD_REQUEST, "上传内容为空");
    }
    if body.len() > MAX_UPLOAD_BYTES {
        return error(StatusCode::PAYLOAD_TOO_LARGE, "文件超过 20MB");
    }
    let root = match resolve_root(&state, &id) {
        Ok(r) => r,
        Err(resp) => return resp,
    };
    // 默认落盘 `.combo/uploads/<yyyy-mm-dd>/`(隐藏目录,不进文件树)
    let dir_rel = q.dir.unwrap_or_else(|| {
        let today = chrono::Local::now().format("%Y-%m-%d");
        format!(".combo/uploads/{today}")
    });
    let dir = match safe_join(&root, &dir_rel) {
        Ok(d) => d,
        Err(e) => return error(StatusCode::BAD_REQUEST, &e.to_string()),
    };
    if let Err(e) = std::fs::create_dir_all(&dir) {
        return error(StatusCode::INTERNAL_SERVER_ERROR, &format!("创建目录失败: {e}"));
    }
    let name = sanitize_upload_name(q.name.as_deref().unwrap_or(""));
    let file = dedupe_upload_path(&dir, &name);
    let Some(parent) = file.parent() else {
        return error(StatusCode::BAD_REQUEST, "无效路径");
    };
    let tmp = parent.join(format!(
        ".combo-upload-{}-{}.tmp",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));
    if let Err(e) = std::fs::write(&tmp, &body) {
        let _ = std::fs::remove_file(&tmp);
        return error(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string());
    }
    match std::fs::rename(&tmp, &file) {
        Ok(_) => {
            // safe_join 返回的路径基于 canonicalize 后的根目录,这里同样
            // canonicalize 再做前缀剥离,避免 macOS 上 /var ↔ /Users 符号
            // 链差异导致 strip_prefix 失败回退成绝对路径。
            let canon_root = std::fs::canonicalize(&root).unwrap_or(root);
            let rel = file
                .strip_prefix(&canon_root)
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_else(|_| file.to_string_lossy().to_string());
            tracing::debug!("附件上传: ws={id} path={rel} bytes={}", body.len());
            ok_json(json!({ "ok": true, "path": rel, "name": name }))
        }
        Err(e) => {
            let _ = std::fs::remove_file(&tmp);
            error(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string())
        }
    }
}

// ============================= 文件内容搜索 =============================

/// 搜索时应跳过的目录名(加快递归速度)。graph.rs 知识图谱扫描同样复用。
pub(crate) fn is_skip_dir(name: &str) -> bool {
    if name.starts_with('.') {
        return true;
    }
    matches!(
        name,
        "node_modules"
            | "target"
            | "dist"
            | "build"
            | "__pycache__"
            | "venv"
            | ".venv"
            | ".next"
            | ".nuxt"
            | ".cache"
            | ".turbo"
            | "coverage"
            | ".idea"
            | ".vscode"
            | "vendor"
            | "Pods"
    )
}

/// 搜索结果上限。
const MAX_SEARCH_RESULTS: usize = 500;

#[derive(Deserialize)]
pub struct SearchQuery {
    pub q: Option<String>,
    pub path: Option<String>,
    pub regex: Option<bool>,
    pub case_sensitive: Option<bool>,
    pub whole_word: Option<bool>,
}

/// 构建文件名/内容匹配正则;query 为空返回 None。
fn build_search_regex(
    query: &str,
    use_regex: bool,
    case_sensitive: bool,
    whole_word: bool,
) -> Result<Option<regex::Regex>, regex::Error> {
    if query.trim().is_empty() {
        return Ok(None);
    }
    let pattern = if use_regex {
        query.to_string()
    } else {
        regex::escape(query)
    };
    let pattern = if whole_word {
        format!(r"(?:^|[^\w])({})(?:[^\w]|$)", pattern)
    } else {
        pattern
    };
    let case_flag = if case_sensitive { "" } else { "(?i)" };
    regex::Regex::new(&format!("{case_flag}{pattern}")).map(Some)
}

/// 使用 `rg --json` 做内容搜索,返回结构化结果。
/// rg 不可用时返回 Err。
///
/// rg 以 `search_dir` 为 cwd,输出的路径相对该目录;这里统一拼上
/// `rel_prefix`(search_dir 相对 workspace 根的路径),保证返回的 path
/// 始终相对 workspace 根,可直接用于 `files/content` 读取。
async fn run_rg_content_search(
    pattern: &str,
    search_dir: &FsPath,
    rel_prefix: &str,
    case_insensitive: bool,
    literal: bool,
    max_results: usize,
) -> Result<Vec<Value>, ()> {
    // 先解析 rg(PATH + 常见安装目录,GUI 进程 PATH 不含 homebrew 也能找到)
    let Some(rg) = crate::binpath::resolve_rg() else {
        return Err(());
    };
    let mut cmd = TokioCommand::new(rg);
    cmd.current_dir(search_dir)
        .arg("--json")
        .arg("--no-heading")
        .arg("--max-filesize")
        .arg("1M")
        .arg("-m")
        .arg("50"); // 每文件最多 50 个匹配

    if literal {
        cmd.arg("--fixed-strings");
    }
    if case_insensitive {
        cmd.arg("--ignore-case");
    }

    cmd.arg("--").arg(pattern);

    cmd.stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .stdin(std::process::Stdio::null());

    let output = tokio::time::timeout(std::time::Duration::from_secs(15), cmd.output()).await;
    let out = match output {
        Ok(Ok(o)) => o,
        _ => return Err(()),
    };

    let text = String::from_utf8_lossy(&out.stdout);
    let mut results: Vec<Value> = Vec::new();
    let mut count = 0usize;

    for line in text.lines() {
        if count >= max_results {
            break;
        }
        // rg --json 每行一个 JSON 对象,我们只关心 type == "match"
        let parsed: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if parsed.get("type").and_then(|t| t.as_str()) != Some("match") {
            continue;
        }

        let path = parsed
            .get("data")
            .and_then(|d| d.get("path"))
            .and_then(|p| p.get("text"))
            .and_then(|t| t.as_str())
            .unwrap_or("");
        // Windows 下 rg 输出 `\` 分隔,统一为 `/`,与前端及其他端点一致
        let path = path.replace(std::path::MAIN_SEPARATOR, "/");
        // 跳过隐藏文件
        let basename = path
            .rsplit_once('/')
            .map(|(_, n)| n.to_string())
            .unwrap_or_else(|| path.clone());
        if basename.starts_with('.') {
            continue;
        }

        let line_number = parsed
            .get("data")
            .and_then(|d| d.get("line_number"))
            .and_then(|n| n.as_u64());

        let content = parsed
            .get("data")
            .and_then(|d| d.get("lines"))
            .and_then(|l| l.get("text"))
            .and_then(|t| t.as_str())
            .unwrap_or("")
            .trim_end_matches('\n')
            .to_string();

        let full_path = if rel_prefix.is_empty() {
            path
        } else {
            format!("{rel_prefix}/{path}")
        };
        results.push(json!({
            "path": full_path,
            "name": basename,
            "line": line_number,
            "content": content,
        }));
        count += 1;
    }

    Ok(results)
}

/// walkdir + regex 回退内容搜索(rg 不可用时)。
fn walkdir_content_search(
    search_dir: &FsPath,
    rel_prefix: &str,
    re: &regex::Regex,
    max_results: usize,
) -> Vec<Value> {
    let mut results: Vec<Value> = Vec::new();

    for entry in walkdir::WalkDir::new(search_dir)
        .into_iter()
        .filter_entry(|e| {
            if e.depth() == 0 {
                return true;
            }
            if e.file_type().is_dir() {
                let name = e.file_name().to_string_lossy();
                return !is_skip_dir(&name);
            }
            true
        })
        .filter_map(|e| e.ok())
    {
        if results.len() >= max_results {
            break;
        }
        if !entry.file_type().is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        // 跳过超过 1MB 的文件
        if entry.metadata().map(|m| m.len() > 1024 * 1024).unwrap_or(true) {
            continue;
        }
        let rel = entry
            .path()
            .strip_prefix(search_dir)
            .unwrap_or(entry.path());
        let full_path = if rel_prefix.is_empty() {
            rel.to_string_lossy().replace(std::path::MAIN_SEPARATOR, "/")
        } else {
            format!(
                "{rel_prefix}/{}",
                rel.to_string_lossy().replace(std::path::MAIN_SEPARATOR, "/")
            )
        };

        let content = match std::fs::read_to_string(entry.path()) {
            Ok(c) => c,
            Err(_) => continue,
        };

        for (i, line) in content.lines().enumerate() {
            if results.len() >= max_results {
                break;
            }
            if re.is_match(line) {
                results.push(json!({
                    "path": full_path,
                    "name": name,
                    "line": i + 1,
                    "content": line,
                }));
            }
        }
    }

    results
}

/// GET /v1/workspaces/{id}/files/search?q=<pattern>&path=<dir>&regex=true&case_sensitive=false
/// 文件内容搜索:优先使用 ripgrep,不可用时回退 walkdir + regex。
pub async fn search(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<SearchQuery>,
) -> Response {
    let root = match resolve_root(&state, &id) {
        Ok(r) => r,
        Err(resp) => return resp,
    };
    let query = q.q.unwrap_or_default();
    let rel_path = q.path.unwrap_or_default();
    let use_regex = q.regex.unwrap_or(false);
    let case_sensitive = q.case_sensitive.unwrap_or(false);
    let whole_word = q.whole_word.unwrap_or(false);

    if query.trim().is_empty() {
        return ok_json(json!([]));
    }

    let search_dir = match safe_join(&root, &rel_path) {
        Ok(d) => d,
        Err(e) => return error(StatusCode::BAD_REQUEST, &e.to_string()),
    };
    if !search_dir.is_dir() {
        return error(StatusCode::BAD_REQUEST, "搜索路径不是目录");
    }

    // search_dir 相对 workspace 根的路径(canonical 后剥离,兼容用户输入
    // 绝对路径/./x 等写法),作为结果 path 的前缀——rg 以 search_dir 为
    // cwd 输出的路径是相对它的,必须拼回根相对路径,否则前端点击结果
    // 打开文件时会 404「文件不存在」。
    let rel_prefix = std::fs::canonicalize(&root)
        .ok()
        .and_then(|canon_root| search_dir.strip_prefix(&canon_root).ok())
        .map(|p| p.to_string_lossy().replace(std::path::MAIN_SEPARATOR, "/"))
        .unwrap_or_default();

    let literal = !use_regex;

    // 先尝试 ripgrep
    let results = match run_rg_content_search(
        &query,
        &search_dir,
        &rel_prefix,
        !case_sensitive,
        literal,
        MAX_SEARCH_RESULTS,
    )
    .await
    {
        Ok(r) => r,
        Err(_) => {
            // 回退 walkdir + regex
            let re = match build_search_regex(&query, use_regex, case_sensitive, whole_word) {
                Ok(Some(r)) => r,
                Ok(None) => return ok_json(json!([])),
                Err(_) => return error(StatusCode::BAD_REQUEST, "无效的正则表达式"),
            };
            walkdir_content_search(&search_dir, &rel_prefix, &re, MAX_SEARCH_RESULTS)
        }
    };

    ok_json(json!(results))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::extract::State;

    /// 构造带临时目录 workspace 的测试 AppState。
    fn fs_test_state(tag: &str) -> (AppState, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("combo-fs-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("src/nested")).unwrap();
        std::fs::write(dir.join("src/nested/deep.rs"), "needle here\nother line\n").unwrap();
        std::fs::write(dir.join("src/top.ts"), "no match\nneedle top\n").unwrap();
        std::fs::write(dir.join("root.md"), "needle root\n").unwrap();
        let meta = std::sync::Arc::new(crate::meta::MetaStore::new());
        meta.insert(crate::meta::WorkspaceMeta {
            id: "ws".into(),
            path: dir.clone(),
            name: "test".into(),
            backend_type: crate::store::BackendType::ComboCli,
        });
        (AppState::test_state(meta, None), dir)
    }

    async fn parse_body(resp: Response) -> Vec<Value> {
        let body = axum::body::to_bytes(resp.into_body(), 1024 * 1024)
            .await
            .unwrap();
        serde_json::from_slice(&body).unwrap()
    }

    /// 任何搜索结果的 path 都必须能被 `read` 解析(相对 workspace 根)。
    /// 回归:限定子目录搜索时 rg 以该目录为 cwd,输出路径缺少根前缀,
    /// 前端点击结果打开文件会 404「文件不存在」。
    #[tokio::test]
    async fn search_paths_are_workspace_relative() {
        let (state, dir) = fs_test_state("search");

        // 全局搜索:结果路径相对根
        let resp = search(
            State(state.clone()),
            Path("ws".into()),
            Query(SearchQuery {
                q: Some("needle".into()),
                path: None,
                regex: None,
                case_sensitive: None,
                whole_word: None,
            }),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);
        let results = parse_body(resp).await;
        let paths: Vec<&str> = results.iter().filter_map(|r| r["path"].as_str()).collect();
        assert!(paths.contains(&"root.md"), "全局搜索应包含 root.md: {paths:?}");
        assert!(paths.contains(&"src/top.ts"), "全局搜索应包含 src/top.ts: {paths:?}");
        assert!(paths.contains(&"src/nested/deep.rs"), "全局搜索应包含 src/nested/deep.rs: {paths:?}");

        // 限定子目录搜索:结果路径必须带 `src/` 前缀(修复前是相对 src 的裸路径)
        let resp = search(
            State(state.clone()),
            Path("ws".into()),
            Query(SearchQuery {
                q: Some("needle".into()),
                path: Some("src".into()),
                regex: None,
                case_sensitive: None,
                whole_word: None,
            }),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);
        let results = parse_body(resp).await;
        let paths: Vec<&str> = results.iter().filter_map(|r| r["path"].as_str()).collect();
        assert!(!paths.is_empty(), "子目录搜索应有结果");
        assert!(
            paths.iter().all(|p| p.starts_with("src/")),
            "子目录搜索结果应带 src/ 前缀: {paths:?}"
        );
        assert!(paths.contains(&"src/nested/deep.rs"), "应包含 src/nested/deep.rs: {paths:?}");
        assert!(!paths.contains(&"root.md"), "不应包含范围外文件: {paths:?}");

        // 结果路径能被 read 成功读取(端到端验证前端点击可用)
        let resp = read(
            State(state.clone()),
            Path("ws".into()),
            Query(PathQuery {
                path: Some("src/nested/deep.rs".into()),
            }),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK, "搜索结果路径应可读取");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// walkdir 回退路径(rg 不可用)同样保持根相对前缀。
    #[tokio::test]
    async fn walkdir_search_paths_are_workspace_relative() {
        let (_state, dir) = fs_test_state("walkdir");

        // 直接调用 walkdir 回退实现,不依赖环境是否有 rg
        let root = std::fs::canonicalize(&dir).unwrap();
        let search_dir = root.join("src");
        let re = build_search_regex("needle", false, false, false)
            .unwrap()
            .unwrap();
        let rel_prefix = search_dir
            .strip_prefix(&root)
            .unwrap()
            .to_string_lossy()
            .to_string();
        let results = walkdir_content_search(&search_dir, &rel_prefix, &re, 100);
        let paths: Vec<&str> = results.iter().filter_map(|r| r["path"].as_str()).collect();
        assert!(!paths.is_empty());
        assert!(
            paths.iter().all(|p| p.starts_with("src/")),
            "walkdir 回退结果应带 src/ 前缀: {paths:?}"
        );
        assert!(paths.contains(&"src/nested/deep.rs"), "应包含 src/nested/deep.rs: {paths:?}");

        let _ = std::fs::remove_dir_all(&dir);
    }

    async fn parse_obj(resp: Response) -> Value {
        let body = axum::body::to_bytes(resp.into_body(), 1024 * 1024)
            .await
            .unwrap();
        serde_json::from_slice(&body).unwrap()
    }

    /// 粘贴上传:默认目录写入、返回 workspace 相对路径、同名自动加序号。
    #[tokio::test]
    async fn upload_writes_and_dedupes() {
        let (state, dir) = fs_test_state("upload");
        let bytes = axum::body::Bytes::from_static(b"pngbytes");

        // 第一次上传:默认目录(.combo/uploads/<date>/)
        let resp = upload(
            State(state.clone()),
            Path("ws".into()),
            Query(UploadQuery {
                dir: None,
                name: Some("截图.png".into()),
            }),
            bytes.clone(),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);
        let v = parse_obj(resp).await;
        let path1 = v["path"].as_str().unwrap().to_string();
        assert!(path1.starts_with(".combo/uploads/"), "默认目录错误: {path1}");
        assert!(path1.ends_with("截图.png"), "文件名错误: {path1}");
        assert_eq!(std::fs::read(dir.join(&path1)).unwrap(), b"pngbytes");

        // 第二次同名上传:自动 `name (1).ext`
        let resp = upload(
            State(state.clone()),
            Path("ws".into()),
            Query(UploadQuery {
                dir: None,
                name: Some("截图.png".into()),
            }),
            bytes.clone(),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);
        let v = parse_obj(resp).await;
        let path2 = v["path"].as_str().unwrap().to_string();
        assert!(path2.ends_with("截图 (1).png"), "去重命名错误: {path2}");
        assert!(std::fs::read(dir.join(&path2)).is_ok(), "第二次上传未落盘");

        // 指定目录 + 危险文件名清洗
        let resp = upload(
            State(state),
            Path("ws".into()),
            Query(UploadQuery {
                dir: Some("uploads".into()),
                name: Some("../../evil/name.txt".into()),
            }),
            bytes,
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);
        let v = parse_obj(resp).await;
        let path3 = v["path"].as_str().unwrap().to_string();
        assert!(path3.starts_with("uploads/"), "指定目录无效: {path3}");
        // 清洗后文件名不再含路径分隔符(即便原名带 ../../ 也只是一段平面文件名)
        let fname = path3.strip_prefix("uploads/").unwrap();
        assert!(!fname.contains('/') && !fname.contains('\\') && !fname.contains("..") , "文件名残留路径成分: {fname}");
        assert!(std::fs::read(dir.join(&path3)).is_ok());

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 上传目录参数不允许 `..` 越出 workspace 根。
    #[tokio::test]
    async fn upload_rejects_traversal_dir() {
        let (state, dir) = fs_test_state("upload-trav");
        let resp = upload(
            State(state),
            Path("ws".into()),
            Query(UploadQuery {
                dir: Some("../outside".into()),
                name: Some("a.txt".into()),
            }),
            axum::body::Bytes::from_static(b"x"),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 超过 20MB 拒绝(413)。
    #[tokio::test]
    async fn upload_rejects_oversize() {
        let (state, dir) = fs_test_state("upload-big");
        let big = vec![0u8; MAX_UPLOAD_BYTES + 1];
        let resp = upload(
            State(state),
            Path("ws".into()),
            Query(UploadQuery {
                dir: None,
                name: Some("big.bin".into()),
            }),
            axum::body::Bytes::from(big),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::PAYLOAD_TOO_LARGE);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn sanitize_upload_name_cleanups() {
        // 带路径分隔符的输入只保留最后一段
        assert_eq!(sanitize_upload_name("../../evil/name.txt"), "name.txt");
        assert_eq!(sanitize_upload_name("a\\b\\c.png"), "c.png");
        // 非法字符替换为 `-`
        assert_eq!(sanitize_upload_name("a:b*c?d.png"), "a-b-c-d.png");
        // 空白名回退为时间戳名
        assert!(sanitize_upload_name("   ").starts_with("upload-"));
        // 超长主干截断到 80 字符,扩展名保留
        let long = format!("{}.png", "x".repeat(200));
        assert_eq!(sanitize_upload_name(&long), format!("{}.png", "x".repeat(80)));
    }
}
