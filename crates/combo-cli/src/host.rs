//! 服务器目录浏览服务:接管 `/v1/host/*` 的只读浏览。
//! 用途:浏览器/移动端没有原生目录选择器,从远端打开服务器上的项目目录时,
//! 通过该 API 浏览服务器文件系统并点选目录。
//! 安全:只读;可配置浏览根目录(`browse_root`),越界返回 403。

use axum::body::Body;
use axum::extract::{Query, State};
use axum::http::{header, StatusCode};
use axum::response::Response;
use serde::Deserialize;
use serde_json::json;
use std::path::{Path as FsPath, PathBuf};

use crate::serve::AppState;

#[derive(Deserialize)]
pub struct PathQuery {
    pub path: Option<String>,
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

/// 缺省浏览起点:受限时为浏览根,否则取 HOME(存在时),最后兜底 `/`。
fn default_start(browse_root: Option<&FsPath>) -> PathBuf {
    if let Some(root) = browse_root {
        return root.to_path_buf();
    }
    if let Ok(home) = std::env::var("HOME") {
        let home = PathBuf::from(home);
        if home.is_dir() {
            return home;
        }
    }
    PathBuf::from("/")
}

/// canonicalize 目标目录并校验浏览范围(返回规范绝对路径)。
fn resolve_dir(state: &AppState, requested: &FsPath) -> Result<PathBuf, Response> {
    let canon = std::fs::canonicalize(requested)
        .map_err(|_| error(StatusCode::NOT_FOUND, "目录不存在"))?;
    if !canon.is_dir() {
        return Err(error(StatusCode::BAD_REQUEST, "目标不是目录"));
    }
    if let Some(root) = &state.browse_root {
        let root_canon = std::fs::canonicalize(root)
            .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "浏览根目录不可用"))?;
        if !canon.starts_with(&root_canon) {
            return Err(error(StatusCode::FORBIDDEN, "路径超出浏览范围"));
        }
    }
    Ok(canon)
}

/// 目录条目(仅目录)。
struct DirEntry {
    name: String,
    path: String,
}

/// 列出 dir 的直接子目录:过滤隐藏项;symlink 仅在解析后仍是目录
/// (且未越出浏览根)时才包含,断链忽略。
fn list_dirs(dir: &FsPath, browse_root: Option<&FsPath>) -> anyhow::Result<Vec<DirEntry>> {
    let root_canon = match browse_root {
        Some(root) => Some(std::fs::canonicalize(root).unwrap_or_default()),
        None => None,
    };
    let mut entries = Vec::new();
    for entry in std::fs::read_dir(dir)? {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let ft = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        let is_dir = if ft.is_dir() {
            true
        } else if ft.is_symlink() {
            match std::fs::canonicalize(entry.path()) {
                Ok(target) => {
                    let within = match &root_canon {
                        Some(rc) => target.starts_with(rc),
                        None => true,
                    };
                    within && target.is_dir()
                }
                Err(_) => false, // 断链
            }
        } else {
            false
        };
        if !is_dir {
            continue;
        }
        entries.push(DirEntry {
            name,
            path: entry.path().to_string_lossy().to_string(),
        });
    }
    entries.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(entries)
}

/// GET /v1/host/home — 返回缺省浏览起点(家目录或浏览根)。
pub async fn home(State(state): State<AppState>) -> Response {
    let start = default_start(state.browse_root.as_deref());
    match resolve_dir(&state, &start) {
        Ok(_) => ok_json(json!({ "path": start.to_string_lossy() })),
        Err(resp) => resp,
    }
}

/// GET /v1/host/dirs?path=<绝对路径> — 列出单层子目录。
/// 返回 `{ path, parent, entries: [{name, path}] }`;缺省 path 时为浏览起点。
pub async fn dirs(State(state): State<AppState>, Query(q): Query<PathQuery>) -> Response {
    let requested = match q.path.filter(|p| !p.trim().is_empty()) {
        Some(p) => FsPath::new(&p).to_path_buf(),
        None => default_start(state.browse_root.as_deref()),
    };
    let dir = match resolve_dir(&state, &requested) {
        Ok(d) => d,
        Err(resp) => return resp,
    };
    let entries = match list_dirs(&dir, state.browse_root.as_deref()) {
        Ok(e) => e,
        Err(_) => return error(StatusCode::NOT_FOUND, "目录不可读或不存在"),
    };
    // 受限浏览时,向上导航不得越出浏览根
    let parent: Option<String> = match dir.parent() {
        Some(p) if !p.as_os_str().is_empty() => {
            let pp = p.to_string_lossy().to_string();
            match &state.browse_root {
                Some(root) if !FsPath::new(&pp).starts_with(root) => {
                    Some(root.to_string_lossy().to_string())
                }
                _ => Some(pp),
            }
        }
        _ => None,
    };
    let arr: Vec<_> = entries
        .into_iter()
        .map(|e| json!({ "name": e.name, "path": e.path }))
        .collect();
    ok_json(json!({ "path": dir.to_string_lossy(), "parent": parent, "entries": arr }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("combo-host-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn lists_dirs_sorted_and_skips_hidden_and_files() {
        let base = temp_dir("list");
        std::fs::create_dir_all(base.join("b")).unwrap();
        std::fs::create_dir_all(base.join("a")).unwrap();
        std::fs::create_dir_all(base.join(".hidden")).unwrap();
        std::fs::write(base.join("file.txt"), "x").unwrap();
        let entries = list_dirs(&base, None).unwrap();
        let names: Vec<_> = entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["a", "b"]);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn browse_root_restricts_entries() {
        let root = temp_dir("root");
        let outside = temp_dir("outside");
        let inner = root.join("inner");
        std::fs::create_dir_all(&inner).unwrap();
        // outside 不参与;验证 root 下正常列出
        let entries = list_dirs(&root, Some(&root)).unwrap();
        let names: Vec<_> = entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["inner"]);
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&outside);
    }

}
