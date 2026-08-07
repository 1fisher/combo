//! Git 操作:在 workspace 根目录下执行 `git` 子命令。
//! 所有 handler 仅接受 workspace id(从 sqlite 元数据解析根目录)和相对路径参数。
//! 文件级操作会经 `safe_join` 做前缀校验,防止目录穿越。

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::Response;
use serde::Deserialize;
use serde_json::json;
use std::ffi::OsStr;
use std::path::Path as FsPath;
use std::process::Command;

use crate::fs::{error, ok_json, resolve_root, safe_join};
use crate::AppState;

#[derive(Deserialize)]
pub struct PathQuery {
    pub path: Option<String>,
}

#[derive(Deserialize)]
pub struct StageBody {
    pub paths: Vec<String>,
}

#[derive(Deserialize)]
pub struct CommitBody {
    pub message: String,
}

#[derive(Deserialize)]
pub struct LogQuery {
    pub limit: Option<u32>,
}

/// 在 workspace 根目录运行 git 子命令,返回 stdout。
fn git_output<I, S>(root: &FsPath, args: I) -> Result<String, String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let output = Command::new("git")
        .current_dir(root)
        .args(args)
        .output()
        .map_err(|e| format!("无法执行 git: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stderr = stderr.trim();
        let display_args = output.status.code().unwrap_or(-1);
        return Err(if stderr.is_empty() {
            format!("git 命令失败 (exit {display_args})")
        } else {
            stderr.to_string()
        });
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// 将 git porcelain 单字符状态码转为可读字符串。
fn status_char_to_str(c: char) -> Option<&'static str> {
    match c {
        'M' => Some("modified"),
        'A' => Some("added"),
        'D' => Some("deleted"),
        'R' => Some("renamed"),
        'C' => Some("copied"),
        'U' => Some("unmerged"),
        '?' => Some("untracked"),
        '!' => Some("ignored"),
        ' ' | '\0' => None,
        _ => Some("modified"),
    }
}

/// 解析 `git status --porcelain=v1` 输出为 JSON 数组。
/// 每行格式: `XY path` 或 `XY oldpath -> newpath`(重命名)。
fn parse_porcelain(raw: &str) -> Vec<serde_json::Value> {
    let mut entries = Vec::new();
    for line in raw.lines() {
        if line.len() < 3 {
            continue;
        }
        let x = line.chars().next().unwrap_or(' ');
        let y = line.chars().nth(1).unwrap_or(' ');
        let rest = &line[3..];
        let (path, old_path) = if let Some(idx) = rest.find(" -> ") {
            let old = &rest[..idx];
            let new = &rest[idx + 4..];
            (new, Some(old.to_string()))
        } else {
            (rest, None)
        };

        let mut index_status = status_char_to_str(x);
        let mut work_tree_status = status_char_to_str(y);
        // untracked 文件:两个状态都是 '?'
        if x == '?' && y == '?' {
            index_status = None;
            work_tree_status = Some("untracked");
        }

        let mut entry = json!({
            "path": path,
            "indexStatus": index_status,
            "workTreeStatus": work_tree_status,
        });
        if let Some(op) = old_path {
            entry["oldPath"] = json!(op);
        }
        entries.push(entry);
    }
    entries
}

/// GET /v1/workspaces/{id}/git/status
pub async fn status(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    let root = match resolve_root(&state, &id) {
        Ok(r) => r,
        Err(resp) => return resp,
    };
    let branch = git_output(&root, ["rev-parse", "--abbrev-ref", "HEAD"])
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|_| "HEAD".to_string());
    let raw = match git_output(&root, ["status", "--porcelain=v1", "-u"]) {
        Ok(s) => s,
        Err(msg) => return error(StatusCode::INTERNAL_SERVER_ERROR, &msg),
    };
    let files = parse_porcelain(&raw);
    ok_json(json!({ "branch": branch, "files": files }))
}

enum DiffScope {
    WorkTree,
    Staged,
    Head,
}

fn diff_impl(state: &AppState, id: &str, path: &Option<String>, scope: DiffScope) -> Response {
    let root = match resolve_root(state, id) {
        Ok(r) => r,
        Err(resp) => return resp,
    };
    let mut args: Vec<String> = vec!["diff".into()];
    match scope {
        DiffScope::Staged => args.push("--cached".into()),
        DiffScope::Head => args.push("HEAD".into()),
        DiffScope::WorkTree => {}
    }
    if let Some(p) = path {
        if !p.is_empty() {
            match safe_join(&root, p) {
                Ok(abs) => {
                    if let Ok(rel) = abs.strip_prefix(&root) {
                        args.push("--".into());
                        args.push(rel.to_string_lossy().into_owned());
                    }
                }
                Err(e) => return error(StatusCode::BAD_REQUEST, &e.to_string()),
            }
        }
    }
    match git_output(&root, &args) {
        Ok(diff_text) => ok_json(json!({ "diff": diff_text })),
        Err(msg) => error(StatusCode::INTERNAL_SERVER_ERROR, &msg),
    }
}

/// GET /v1/workspaces/{id}/git/diff?path=<可选>
pub async fn diff(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<PathQuery>,
) -> Response {
    diff_impl(&state, &id, &q.path, DiffScope::WorkTree)
}

/// GET /v1/workspaces/{id}/git/diff/staged?path=<可选>
pub async fn diff_staged(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<PathQuery>,
) -> Response {
    diff_impl(&state, &id, &q.path, DiffScope::Staged)
}

/// GET /v1/workspaces/{id}/git/diff/head?path=<可选>
pub async fn diff_head(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<PathQuery>,
) -> Response {
    diff_impl(&state, &id, &q.path, DiffScope::Head)
}

/// GET /v1/workspaces/{id}/git/file?path=<文件>
/// 返回文件在 HEAD 的内容(用于编辑器 git gutter 对比)。
pub async fn file_at_head(
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
    if let Err(e) = safe_join(&root, &rel) {
        return error(StatusCode::BAD_REQUEST, &e.to_string());
    }
    let show_arg = format!("HEAD:{rel}");
    match git_output(&root, ["show", &show_arg]) {
        Ok(content) => ok_json(json!({ "content": content })),
        Err(msg) => {
            if msg.contains("does not exist") || msg.contains("exists on disk, but not in") {
                ok_json(json!({ "content": "" }))
            } else {
                error(StatusCode::INTERNAL_SERVER_ERROR, &msg)
            }
        }
    }
}

/// POST /v1/workspaces/{id}/git/stage  body: { "paths": [...] }
/// 暂存指定文件(`git add`)。空数组暂存全部。
pub async fn stage(
    State(state): State<AppState>,
    Path(id): Path<String>,
    axum::extract::Json(body): axum::extract::Json<StageBody>,
) -> Response {
    let root = match resolve_root(&state, &id) {
        Ok(r) => r,
        Err(resp) => return resp,
    };
    let mut args: Vec<String> = vec!["add".into()];
    if body.paths.is_empty() {
        args.push("-A".into());
    } else {
        args.push("--".into());
        for p in &body.paths {
            if let Err(e) = safe_join(&root, p) {
                return error(StatusCode::BAD_REQUEST, &e.to_string());
            }
            args.push(p.clone());
        }
    }
    match git_output(&root, &args) {
        Ok(_) => ok_json(json!({ "ok": true })),
        Err(msg) => error(StatusCode::INTERNAL_SERVER_ERROR, &msg),
    }
}

/// POST /v1/workspaces/{id}/git/unstage  body: { "paths": [...] }
/// 取消暂存(`git reset HEAD --`)。
pub async fn unstage(
    State(state): State<AppState>,
    Path(id): Path<String>,
    axum::extract::Json(body): axum::extract::Json<StageBody>,
) -> Response {
    let root = match resolve_root(&state, &id) {
        Ok(r) => r,
        Err(resp) => return resp,
    };
    let mut args: Vec<String> = vec!["reset".into(), "HEAD".into(), "--".into()];
    for p in &body.paths {
        if let Err(e) = safe_join(&root, p) {
            return error(StatusCode::BAD_REQUEST, &e.to_string());
        }
        args.push(p.clone());
    }
    match git_output(&root, &args) {
        Ok(_) => ok_json(json!({ "ok": true })),
        Err(msg) => error(StatusCode::INTERNAL_SERVER_ERROR, &msg),
    }
}

/// POST /v1/workspaces/{id}/git/commit  body: { "message": "..." }
pub async fn commit(
    State(state): State<AppState>,
    Path(id): Path<String>,
    axum::extract::Json(body): axum::extract::Json<CommitBody>,
) -> Response {
    let root = match resolve_root(&state, &id) {
        Ok(r) => r,
        Err(resp) => return resp,
    };
    let msg = body.message.trim();
    if msg.is_empty() {
        return error(StatusCode::BAD_REQUEST, "提交信息不能为空");
    }
    match git_output(&root, ["commit", "-m", msg]) {
        Ok(output) => ok_json(json!({ "ok": true, "output": output })),
        Err(msg) => error(StatusCode::INTERNAL_SERVER_ERROR, &msg),
    }
}

/// GET /v1/workspaces/{id}/git/log?limit=<可选>
pub async fn git_log(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<LogQuery>,
) -> Response {
    let root = match resolve_root(&state, &id) {
        Ok(r) => r,
        Err(resp) => return resp,
    };
    let limit = q.limit.unwrap_or(20);
    let fmt = "%h\t%an\t%ad\t%s";
    let limit_str = format!("-{limit}");
    let pretty = format!("--pretty=format:{fmt}");
    match git_output(&root, ["log", &limit_str, &pretty, "--date=short"]) {
        Ok(raw) => {
            let commits: Vec<serde_json::Value> = raw
                .lines()
                .filter_map(|line| {
                    let parts: Vec<&str> = line.splitn(4, '\t').collect();
                    if parts.len() == 4 {
                        Some(json!({
                            "hash": parts[0],
                            "author": parts[1],
                            "date": parts[2],
                            "message": parts[3],
                        }))
                    } else {
                        None
                    }
                })
                .collect();
            ok_json(json!({ "commits": commits }))
        }
        Err(msg) => error(StatusCode::INTERNAL_SERVER_ERROR, &msg),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_untracked() {
        let raw = "?? new_file.ts\n";
        let entries = parse_porcelain(raw);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0]["path"], "new_file.ts");
        assert_eq!(entries[0]["indexStatus"], serde_json::Value::Null);
        assert_eq!(entries[0]["workTreeStatus"], "untracked");
    }

    #[test]
    fn parse_modified_unstaged() {
        let raw = " M src/main.rs\n";
        let entries = parse_porcelain(raw);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0]["path"], "src/main.rs");
        assert_eq!(entries[0]["indexStatus"], serde_json::Value::Null);
        assert_eq!(entries[0]["workTreeStatus"], "modified");
    }

    #[test]
    fn parse_staged_and_unstaged() {
        let raw = "AM src/lib.rs\n";
        let entries = parse_porcelain(raw);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0]["indexStatus"], "added");
        assert_eq!(entries[0]["workTreeStatus"], "modified");
    }

    #[test]
    fn parse_rename() {
        let raw = "R  old.ts -> new.ts\n";
        let entries = parse_porcelain(raw);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0]["path"], "new.ts");
        assert_eq!(entries[0]["oldPath"], "old.ts");
        assert_eq!(entries[0]["indexStatus"], "renamed");
    }
}
