//! 本地文件服务:仅接管 `/v1/workspaces/{id}/files/*` 的读写。
//! 代理本身不持有业务状态,workspace 的真实路径通过向 rune 查询获得,
//! 之后所有相对路径都在该根目录内做 canonicalize 前缀校验,防止目录穿越
//! 与 symlink 逃逸。

use axum::body::Body;
use axum::extract::{Path, Query, State};
use axum::http::{header, Method, StatusCode};
use axum::response::Response;
use serde::Deserialize;
use serde_json::json;
use std::path::{Component, Path as FsPath, PathBuf};
use std::sync::Arc;

use crate::handler::upstream_call;
use crate::upstream::Upstream;

/// 单文件读取上限(1MB),超过视为过大。
const MAX_FILE_BYTES: u64 = 1024 * 1024;

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

fn ok_json(value: serde_json::Value) -> Response {
    json_response(StatusCode::OK, value)
}

fn error(status: StatusCode, message: &str) -> Response {
    json_response(status, json!({ "message": message }))
}

/// 向 rune 查询 workspace 并返回其真实路径。
async fn workspace_root(upstream: &Upstream, id: &str) -> anyhow::Result<PathBuf> {
    let path_query = format!("/v1/workspaces/{id}");
    let resp = upstream_call(
        upstream,
        Method::GET,
        &path_query,
        &Default::default(),
        Vec::new(),
    )
    .await
    .map_err(|e| anyhow::anyhow!("无法查询 workspace: {e:#}"))?;
    let status = resp.status();
    let bytes = axum::body::to_bytes(resp.into_body(), 1024 * 1024)
        .await
        .map_err(|e| anyhow::anyhow!("读取 workspace 响应失败: {e}"))?;
    if !status.is_success() {
        anyhow::bail!("查询 workspace 返回 {status}");
    }
    let v: serde_json::Value = serde_json::from_slice(&bytes)?;
    let path = v
        .get("path")
        .and_then(|p| p.as_str())
        .ok_or_else(|| anyhow::anyhow!("workspace 响应缺少 path 字段"))?;
    Ok(PathBuf::from(path))
}

/// 在 workspace 根内安全拼接相对路径。
/// 逐段拒绝绝对路径与 `..`;canonicalize 最深已存在祖先后做前缀校验,
/// 若目标本身是符号链接再做一次最终校验,阻止逃逸到根目录之外。
fn safe_join(root: &FsPath, rel: &str) -> anyhow::Result<PathBuf> {
    let root = std::fs::canonicalize(root)
        .map_err(|e| anyhow::anyhow!("无法访问 workspace 根目录: {e}"))?;
    if !root.is_dir() {
        anyhow::bail!("workspace 根目录不是文件夹");
    }
    let mut clean = PathBuf::new();
    for comp in FsPath::new(rel).components() {
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
    State(upstream): State<Arc<Upstream>>,
    Path(id): Path<String>,
    Query(q): Query<PathQuery>,
) -> Response {
    let root = match workspace_root(&upstream, &id).await {
        Ok(r) => r,
        Err(e) => return error(StatusCode::BAD_GATEWAY, &format!("{e:#}")),
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
            continue; // 隐藏文件(如 .git/.crush)不进文件树
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
    State(upstream): State<Arc<Upstream>>,
    Path(id): Path<String>,
    Query(q): Query<PathQuery>,
) -> Response {
    let root = match workspace_root(&upstream, &id).await {
        Ok(r) => r,
        Err(e) => return error(StatusCode::BAD_GATEWAY, &format!("{e:#}")),
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

/// PUT /v1/workspaces/{id}/files/content?path=<相对文件>  body: { "content": ... }
/// 原子写:同目录临时文件 + rename,避免写一半。
pub async fn write(
    State(upstream): State<Arc<Upstream>>,
    Path(id): Path<String>,
    Query(q): Query<PathQuery>,
    axum::extract::Json(body): axum::extract::Json<WriteBody>,
) -> Response {
    let root = match workspace_root(&upstream, &id).await {
        Ok(r) => r,
        Err(e) => return error(StatusCode::BAD_GATEWAY, &format!("{e:#}")),
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
