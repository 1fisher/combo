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

// ============================= 文件搜索 =============================

/// 搜索时应跳过的目录名(加快递归速度)。
fn is_skip_dir(name: &str) -> bool {
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

/// 构建文件名匹配正则;query 为空返回 None(不过滤,列出全部)。
fn build_search_matcher(
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

/// 运行 `rg --files`,返回相对搜索目录的文件路径列表。
/// rg 不可用时返回 Err。
async fn run_rg_files(dir: &FsPath) -> Result<Vec<String>, ()> {
    let mut cmd = TokioCommand::new("rg");
    cmd.current_dir(dir)
        .arg("--files")
        .arg("--color")
        .arg("never")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .stdin(std::process::Stdio::null());

    let output = tokio::time::timeout(std::time::Duration::from_secs(10), cmd.output()).await;
    match output {
        Ok(Ok(out)) => {
            let text = String::from_utf8_lossy(&out.stdout);
            Ok(text
                .lines()
                .map(|l| l.trim().to_string())
                .filter(|l| !l.is_empty())
                .collect())
        }
        _ => Err(()),
    }
}

/// 从 rg --files 输出构建搜索结果(文件 + 匹配的目录)。
fn build_search_entries(
    lines: &[String],
    rel_prefix: &str,
    matcher: Option<&regex::Regex>,
) -> Vec<Value> {
    let mut files: Vec<Value> = Vec::new();
    let mut dirs: Vec<Value> = Vec::new();
    let mut seen_dirs = std::collections::HashSet::new();

    for line in lines {
        if files.len() + dirs.len() >= MAX_SEARCH_RESULTS {
            break;
        }
        // 跳过隐藏文件
        let basename = line.rsplit_once('/').map(|(_, n)| n).unwrap_or(line);
        if basename.starts_with('.') {
            continue;
        }
        let full_path = if rel_prefix.is_empty() {
            line.clone()
        } else {
            format!("{rel_prefix}/{line}")
        };

        if matcher.map_or(true, |m| m.is_match(basename)) {
            files.push(json!({
                "name": basename,
                "path": full_path,
                "type": "file",
            }));
        }

        // 收集匹配的父目录
        if let Some(m) = matcher {
            let mut parent = line.as_str();
            while let Some((dirpath, _)) = parent.rsplit_once('/') {
                if seen_dirs.insert(dirpath.to_string()) {
                    let dir_name = dirpath.rsplit_once('/').map(|(_, n)| n).unwrap_or(dirpath);
                    if m.is_match(dir_name) {
                        let full_dir = if rel_prefix.is_empty() {
                            dirpath.to_string()
                        } else {
                            format!("{rel_prefix}/{dirpath}")
                        };
                        dirs.push(json!({
                            "name": dir_name,
                            "path": full_dir,
                            "type": "dir",
                        }));
                    }
                }
                parent = dirpath;
            }
        }
    }

    // 目录在前,文件在后
    dirs.extend(files);
    dirs
}

/// walkdir 回退搜索(rg 不可用时)。
fn walkdir_search(
    search_dir: &FsPath,
    rel_prefix: &str,
    matcher: Option<&regex::Regex>,
) -> Vec<Value> {
    let mut entries: Vec<Value> = Vec::new();

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
        if entries.len() >= MAX_SEARCH_RESULTS {
            break;
        }
        if entry.depth() == 0 {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
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
        if !matcher.map_or(true, |m| m.is_match(&name)) {
            continue;
        }
        let is_dir = entry.file_type().is_dir();
        entries.push(json!({
            "name": name,
            "path": full_path,
            "type": if is_dir { "dir" } else { "file" },
        }));
    }

    entries.sort_by(|a, b| {
        let ta = a["type"].as_str().unwrap_or("file");
        let tb = b["type"].as_str().unwrap_or("file");
        ta.cmp(tb)
            .then_with(|| a["name"].as_str().unwrap_or("").cmp(b["name"].as_str().unwrap_or("")))
    });
    entries
}

/// GET /v1/workspaces/{id}/files/search?q=<pattern>&path=<dir>&regex=true&case_sensitive=false
/// 使用 ripgrep --files 快速列出文件,再按文件名过滤;rg 不可用时回退 walkdir。
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

    let search_dir = match safe_join(&root, &rel_path) {
        Ok(d) => d,
        Err(e) => return error(StatusCode::BAD_REQUEST, &e.to_string()),
    };
    if !search_dir.is_dir() {
        return error(StatusCode::BAD_REQUEST, "搜索路径不是目录");
    }

    let matcher = match build_search_matcher(&query, use_regex, case_sensitive, whole_word) {
        Ok(m) => m,
        Err(_) => return error(StatusCode::BAD_REQUEST, "无效的正则表达式"),
    };

    let entries = match run_rg_files(&search_dir).await {
        Ok(lines) => build_search_entries(&lines, &rel_path, matcher.as_ref()),
        Err(_) => walkdir_search(&search_dir, &rel_path, matcher.as_ref()),
    };

    ok_json(json!(entries))
}
