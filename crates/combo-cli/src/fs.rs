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
async fn run_rg_content_search(
    pattern: &str,
    search_dir: &FsPath,
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
        // 跳过隐藏文件
        let basename = path.rsplit_once('/').map(|(_, n)| n).unwrap_or(path);
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

        results.push(json!({
            "path": path,
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
            rel.to_string_lossy().to_string()
        } else {
            format!("{rel_prefix}/{}", rel.to_string_lossy())
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

    let literal = !use_regex;

    // 先尝试 ripgrep
    let results = match run_rg_content_search(
        &query,
        &search_dir,
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
            walkdir_content_search(&search_dir, &rel_path, &re, MAX_SEARCH_RESULTS)
        }
    };

    ok_json(json!(results))
}
