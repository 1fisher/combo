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
use crate::serve::AppState;

#[derive(Deserialize)]
pub struct PathQuery {
    pub path: Option<String>,
    pub repo: Option<String>,
}

#[derive(Deserialize)]
pub struct RepoQuery {
    pub repo: Option<String>,
}

#[derive(Deserialize)]
pub struct StageBody {
    pub paths: Vec<String>,
    pub repo: Option<String>,
}

#[derive(Deserialize)]
pub struct CommitBody {
    pub message: String,
    pub repo: Option<String>,
}

#[derive(Deserialize)]
pub struct LogQuery {
    pub limit: Option<u32>,
    pub repo: Option<String>,
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

/// 解析 git 工作目录:默认 workspace 根;传 `repo` 时定位到根下的一级子目录
/// (经 `safe_join` 前缀校验,防止目录穿越)。
fn resolve_git_dir(
    state: &AppState,
    id: &str,
    repo: Option<&str>,
) -> Result<std::path::PathBuf, Response> {
    let root = resolve_root(state, id)?;
    match repo {
        Some(r) if !r.is_empty() => safe_join(&root, r)
            .map_err(|e| error(StatusCode::BAD_REQUEST, &e.to_string())),
        _ => Ok(root),
    }
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

/// 获取某个 git 仓库的分支与变更文件(rel 为相对 workspace 根的目录,空串表示根)。
fn repo_status(root: &FsPath, rel: &str) -> Option<serde_json::Value> {
    let dir = if rel.is_empty() {
        root.to_path_buf()
    } else {
        root.join(rel)
    };
    let branch = git_output(&dir, ["rev-parse", "--abbrev-ref", "HEAD"])
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|_| "HEAD".to_string());
    let raw = git_output(&dir, ["status", "--porcelain=v1", "-u"]).ok()?;
    Some(json!({
        "path": rel,
        "branch": branch,
        "files": parse_porcelain(&raw),
    }))
}

/// GET /v1/workspaces/{id}/git/repos
/// 发现 workspace 根目录及其一级子目录中的 git 仓库,返回各仓库的当前分支与变更文件。
pub async fn repos(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    let root = match resolve_root(&state, &id) {
        Ok(r) => r,
        Err(resp) => return resp,
    };
    let mut list: Vec<serde_json::Value> = Vec::new();
    if root.join(".git").exists() {
        if let Some(repo) = repo_status(&root, "") {
            list.push(repo);
        }
    }
    // 扫描一级子目录中的独立 git 仓库
    let mut subdirs: Vec<String> = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&root) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            if name.starts_with('.') {
                continue;
            }
            if path.join(".git").exists() {
                subdirs.push(name.to_string());
            }
        }
    }
    subdirs.sort();
    for name in subdirs {
        if let Some(repo) = repo_status(&root, &name) {
            list.push(repo);
        }
    }
    ok_json(json!({ "repos": list }))
}

/// GET /v1/workspaces/{id}/git/status?repo=<可选>
pub async fn status(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<RepoQuery>,
) -> Response {
    let dir = match resolve_git_dir(&state, &id, q.repo.as_deref()) {
        Ok(d) => d,
        Err(resp) => return resp,
    };
    let branch = git_output(&dir, ["rev-parse", "--abbrev-ref", "HEAD"])
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|_| "HEAD".to_string());
    let raw = match git_output(&dir, ["status", "--porcelain=v1", "-u"]) {
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

fn diff_impl(
    state: &AppState,
    id: &str,
    repo: &Option<String>,
    path: &Option<String>,
    scope: DiffScope,
) -> Response {
    let root = match resolve_git_dir(state, id, repo.as_deref()) {
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
    diff_impl(&state, &id, &q.repo, &q.path, DiffScope::WorkTree)
}

/// GET /v1/workspaces/{id}/git/diff/staged?path=<可选>
pub async fn diff_staged(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<PathQuery>,
) -> Response {
    diff_impl(&state, &id, &q.repo, &q.path, DiffScope::Staged)
}

/// GET /v1/workspaces/{id}/git/diff/head?path=<可选>
pub async fn diff_head(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<PathQuery>,
) -> Response {
    diff_impl(&state, &id, &q.repo, &q.path, DiffScope::Head)
}

/// GET /v1/workspaces/{id}/git/file?path=<文件>
/// 返回文件在 HEAD 的内容(用于编辑器 git gutter 对比)。
pub async fn file_at_head(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<PathQuery>,
) -> Response {
    let root = match resolve_git_dir(&state, &id, q.repo.as_deref()) {
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
    let root = match resolve_git_dir(&state, &id, body.repo.as_deref()) {
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
    let root = match resolve_git_dir(&state, &id, body.repo.as_deref()) {
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

/// POST /v1/workspaces/{id}/git/discard  body: { "paths": [...] }
/// 撤销变更:已跟踪文件 `git checkout HEAD --`(恢复到 HEAD 并取消暂存),
/// 未跟踪文件 `git clean -f`(直接删除)。
pub async fn discard(
    State(state): State<AppState>,
    Path(id): Path<String>,
    axum::extract::Json(body): axum::extract::Json<StageBody>,
) -> Response {
    let root = match resolve_git_dir(&state, &id, body.repo.as_deref()) {
        Ok(r) => r,
        Err(resp) => return resp,
    };
    for p in &body.paths {
        if let Err(e) = safe_join(&root, p) {
            return error(StatusCode::BAD_REQUEST, &e.to_string());
        }
    }

    // 区分已跟踪 / 未跟踪文件
    let mut ls_args: Vec<String> = vec!["ls-files".into(), "--".into()];
    ls_args.extend(body.paths.iter().cloned());
    let tracked_set: std::collections::HashSet<String> = git_output(&root, &ls_args)
        .unwrap_or_default()
        .lines()
        .map(|s| s.trim().to_string())
        .collect();

    let (tracked, untracked): (Vec<&String>, Vec<&String>) = body
        .paths
        .iter()
        .partition(|p| tracked_set.contains(*p));

    // 已跟踪:恢复到 HEAD(同时取消暂存)
    if !tracked.is_empty() {
        let mut args: Vec<String> = vec!["checkout".into(), "HEAD".into(), "--".into()];
        args.extend(tracked.iter().map(|s| s.as_str().into()));
        if let Err(msg) = git_output(&root, &args) {
            return error(StatusCode::INTERNAL_SERVER_ERROR, &msg);
        }
    }

    // 未跟踪:直接删除
    if !untracked.is_empty() {
        let mut args: Vec<String> = vec!["clean".into(), "-f".into(), "--".into()];
        args.extend(untracked.iter().map(|s| s.as_str().into()));
        if let Err(msg) = git_output(&root, &args) {
            return error(StatusCode::INTERNAL_SERVER_ERROR, &msg);
        }
    }

    ok_json(json!({ "ok": true }))
}

/// POST /v1/workspaces/{id}/git/commit  body: { "message": "..." }
pub async fn commit(
    State(state): State<AppState>,
    Path(id): Path<String>,
    axum::extract::Json(body): axum::extract::Json<CommitBody>,
) -> Response {
    let root = match resolve_git_dir(&state, &id, body.repo.as_deref()) {
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
/// 返回提交历史(含父提交哈希和分支标签,用于 git graph 可视化)。
pub async fn git_log(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<LogQuery>,
) -> Response {
    let root = match resolve_git_dir(&state, &id, q.repo.as_deref()) {
        Ok(r) => r,
        Err(resp) => return resp,
    };
    let limit = q.limit.unwrap_or(20);
    let limit_str = format!("-{limit}");
    // 用 \x1f (Unit Separator) 分隔字段,\x1e (Record Separator) 分隔父提交列表
    let fmt = "%H\x1f%h\x1f%an\x1f%ad\x1f%s\x1f%P\x1f%D";
    let pretty = format!("--pretty=format:{fmt}");
    match git_output(&root, ["log", &limit_str, &pretty, "--date=short", "--all"]) {
        Ok(raw) => {
            let commits: Vec<serde_json::Value> = raw
                .lines()
                .filter_map(|line| {
                    let parts: Vec<&str> = line.split('\x1f').collect();
                    if parts.len() < 7 {
                        return None;
                    }
                    let full_hash = parts[0];
                    let short_hash = parts[1];
                    let author = parts[2];
                    let date = parts[3];
                    let message = parts[4];
                    let parents: Vec<&str> = parts[5].split_whitespace().collect();
                    let refs_raw = parts[6];
                    let refs: Vec<&str> = if refs_raw.is_empty() {
                        Vec::new()
                    } else {
                        refs_raw.split(", ").collect()
                    };
                    // 标记 HEAD
                    let is_head = refs.iter().any(|r| r.starts_with("HEAD"));
                    // 提取分支名(去掉 HEAD -> 前缀和 remote-tracking 前缀)
                    let branches: Vec<serde_json::Value> = refs
                        .iter()
                        .filter_map(|r| {
                            let r = r.strip_prefix("HEAD -> ").unwrap_or(r);
                            if r == "HEAD" {
                                return None;
                            }
                            let is_remote = r.starts_with("origin/");
                            let name = if is_remote {
                                r.strip_prefix("origin/").unwrap_or(r)
                            } else {
                                r
                            };
                            Some(json!({
                                "name": name,
                                "isRemote": is_remote,
                            }))
                        })
                        .collect();
                    Some(json!({
                        "hash": full_hash,
                        "shortHash": short_hash,
                        "author": author,
                        "date": date,
                        "message": message,
                        "parents": parents,
                        "branches": branches,
                        "isHead": is_head,
                    }))
                })
                .collect();
            ok_json(json!({ "commits": commits }))
        }
        Err(msg) => error(StatusCode::INTERNAL_SERVER_ERROR, &msg),
    }
}

/// 获取本地与远程分支的领先/落后计数。
fn ahead_behind(root: &std::path::Path, branch: &str) -> (u32, u32) {
    let upstream = match git_output(root, ["rev-parse", "--abbrev-ref", &format!("{branch}@{{upstream}}")]) {
        Ok(s) => s.trim().to_string(),
        Err(_) => return (0, 0),
    };
    let count_fmt = "--pretty=format:%D\t";
    let range = format!("{upstream}..HEAD");
    let ahead = git_output(root, ["rev-list", "--count", &range])
        .ok()
        .and_then(|s| s.trim().parse::<u32>().ok())
        .unwrap_or(0);
    let range_behind = format!("HEAD..{upstream}");
    let behind = git_output(root, ["rev-list", "--count", &range_behind])
        .ok()
        .and_then(|s| s.trim().parse::<u32>().ok())
        .unwrap_or(0);
    let _ = count_fmt; // suppress unused warning
    (ahead, behind)
}

/// POST /v1/workspaces/{id}/git/push
/// 推送当前分支到远程。带 `--set-upstream` 以便首次推送自动关联。
pub async fn push(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<RepoQuery>,
) -> Response {
    let root = match resolve_git_dir(&state, &id, q.repo.as_deref()) {
        Ok(r) => r,
        Err(resp) => return resp,
    };
    // 先获取当前分支名
    let branch = git_output(&root, ["rev-parse", "--abbrev-ref", "HEAD"])
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|_| "HEAD".to_string());

    // 检查是否已有上游分支
    let has_upstream = git_output(&root, ["rev-parse", "--abbrev-ref", "@{upstream}"]).is_ok();

    let mut args: Vec<String> = vec!["push".into()];
    if !has_upstream && branch != "HEAD" {
        args.push("--set-upstream".into());
        args.push("origin".into());
        args.push(branch.clone());
    } else {
        args.push("origin".into());
    }

    match git_output(&root, &args) {
        Ok(output) => ok_json(json!({ "ok": true, "output": output })),
        Err(msg) => error(StatusCode::INTERNAL_SERVER_ERROR, &msg),
    }
}

/// POST /v1/workspaces/{id}/git/pull
/// 拉取并合并远程变更。
pub async fn pull(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<RepoQuery>,
) -> Response {
    let root = match resolve_git_dir(&state, &id, q.repo.as_deref()) {
        Ok(r) => r,
        Err(resp) => return resp,
    };
    match git_output(&root, ["pull", "--no-edit"]) {
        Ok(output) => ok_json(json!({ "ok": true, "output": output })),
        Err(msg) => error(StatusCode::INTERNAL_SERVER_ERROR, &msg),
    }
}

/// POST /v1/workspaces/{id}/git/fetch
/// 获取远程变更(不合并)。
pub async fn fetch(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<RepoQuery>,
) -> Response {
    let root = match resolve_git_dir(&state, &id, q.repo.as_deref()) {
        Ok(r) => r,
        Err(resp) => return resp,
    };
    match git_output(&root, ["fetch", "--all", "--prune"]) {
        Ok(output) => ok_json(json!({ "ok": true, "output": output })),
        Err(msg) => error(StatusCode::INTERNAL_SERVER_ERROR, &msg),
    }
}

/// GET /v1/workspaces/{id}/git/branch-info
/// 返回当前分支名、上游分支、领先/落后计数。
pub async fn branch_info(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<RepoQuery>,
) -> Response {
    let root = match resolve_git_dir(&state, &id, q.repo.as_deref()) {
        Ok(r) => r,
        Err(resp) => return resp,
    };
    let branch = git_output(&root, ["rev-parse", "--abbrev-ref", "HEAD"])
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|_| "HEAD".to_string());
    let upstream = git_output(&root, ["rev-parse", "--abbrev-ref", "@{upstream}"])
        .ok()
        .map(|s| s.trim().to_string());
    let has_remote = git_output(&root, ["remote"]).map(|s| s.trim().to_string()).unwrap_or_default();
    let (ahead, behind) = if upstream.is_some() && !has_remote.is_empty() {
        ahead_behind(&root, &branch)
    } else {
        (0, 0)
    };
    ok_json(json!({
        "branch": branch,
        "upstream": upstream,
        "hasRemote": !has_remote.is_empty(),
        "ahead": ahead,
        "behind": behind,
    }))
}

/// GET /v1/workspaces/{id}/git/branches?repo=...
/// 列出本地分支(按最近提交时间倒序),标注当前分支。
pub async fn git_branches(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<RepoQuery>,
) -> Response {
    let root = match resolve_git_dir(&state, &id, q.repo.as_deref()) {
        Ok(r) => r,
        Err(resp) => return resp,
    };
    let current = git_output(&root, ["rev-parse", "--abbrev-ref", "HEAD"])
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|_| "HEAD".to_string());
    let raw = match git_output(
        &root,
        ["for-each-ref", "--sort=-committerdate", "--format=%(refname:short)", "refs/heads"],
    ) {
        Ok(r) => r,
        Err(msg) => return error(StatusCode::INTERNAL_SERVER_ERROR, &msg),
    };
    let branches: Vec<serde_json::Value> = raw
        .lines()
        .map(|line| line.trim().to_string())
        .filter(|l| !l.is_empty())
        .map(|name| json!({ "name": name, "current": name == current }))
        .collect();
    ok_json(json!({ "current": current, "branches": branches }))
}

#[derive(Deserialize)]
pub struct BranchBody {
    pub branch: String,
    pub repo: Option<String>,
}

/// POST /v1/workspaces/{id}/git/checkout  body: { "branch": "xxx", "repo": "..." }
/// 切换到指定本地分支。工作区存在未提交变更时 git 会拒绝,返回 stderr 错误。
pub async fn git_checkout(
    State(state): State<AppState>,
    Path(id): Path<String>,
    axum::extract::Json(body): axum::extract::Json<BranchBody>,
) -> Response {
    let root = match resolve_git_dir(&state, &id, body.repo.as_deref()) {
        Ok(r) => r,
        Err(resp) => return resp,
    };
    // 分支名只允许 git ref 合法字符,防止参数注入
    if body.branch.is_empty()
        || !body
            .branch
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "._-/*".contains(c))
    {
        return error(StatusCode::BAD_REQUEST, "非法的分支名");
    }
    match git_output(&root, ["checkout", &body.branch]) {
        Ok(output) => ok_json(json!({ "ok": true, "output": output })),
        Err(msg) => error(StatusCode::INTERNAL_SERVER_ERROR, &msg),
    }
}

#[derive(Deserialize)]
pub struct CommitQuery {
    pub hash: String,
    pub path: Option<String>,
    pub repo: Option<String>,
}

/// GET /v1/workspaces/{id}/git/commit/files?hash=<commit>
/// 返回某个提交中变更的文件列表(使用 name-status 格式)。
pub async fn commit_files(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<CommitQuery>,
) -> Response {
    let root = match resolve_git_dir(&state, &id, q.repo.as_deref()) {
        Ok(r) => r,
        Err(resp) => return resp,
    };
    let hash = q.hash.trim();
    if hash.is_empty() {
        return error(StatusCode::BAD_REQUEST, "缺少 hash 参数");
    }
    // 用 git diff-tree --name-status 获取变更文件(兼容性最好)
    // 对于初始提交(root commit),用 --root 标志
    let parents = git_output(&root, ["rev-list", "--parents", "-n", "1", hash]).unwrap_or_default();
    let parent_count = parents.split_whitespace().count().saturating_sub(1);
    let diff_args: Vec<String> = if parent_count == 0 {
        vec!["diff-tree".into(), "--no-commit-id".into(), "--name-status".into(), "--root".into(), hash.into()]
    } else {
        vec!["diff-tree".into(), "--no-commit-id".into(), "--name-status".into(), "-r".into(), hash.into()]
    };
    match git_output(&root, &diff_args) {
        Ok(raw) => {
            let files: Vec<serde_json::Value> = raw
                .lines()
                .skip_while(|l| l.is_empty())
                .filter_map(|line| {
                    let parts: Vec<&str> = line.splitn(3, '\t').collect();
                    if parts.is_empty() || parts[0].is_empty() {
                        return None;
                    }
                    let status_code = parts[0].chars().next().unwrap_or('M');
                    let status = match status_code {
                        'A' => "added",
                        'D' => "deleted",
                        'R' => "renamed",
                        'C' => "copied",
                        'U' => "unmerged",
                        _ => "modified",
                    };
                    if parts[0].starts_with('R') || parts[0].starts_with('C') {
                        // rename/copy: old\tnew
                        Some(json!({
                            "path": parts.get(2).unwrap_or(&""),
                            "oldPath": parts.get(1).unwrap_or(&""),
                            "status": status,
                        }))
                    } else {
                        Some(json!({
                            "path": parts.get(1).unwrap_or(&""),
                            "status": status,
                        }))
                    }
                })
                .collect();
            ok_json(json!({ "files": files }))
        }
        Err(msg) => error(StatusCode::INTERNAL_SERVER_ERROR, &msg),
    }
}

/// GET /v1/workspaces/{id}/git/commit/diff?hash=<commit>&path=<可选>
/// 返回某个提交的 unified diff(可按文件过滤)。
pub async fn commit_diff(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<CommitQuery>,
) -> Response {
    let root = match resolve_git_dir(&state, &id, q.repo.as_deref()) {
        Ok(r) => r,
        Err(resp) => return resp,
    };
    let hash = q.hash.trim();
    if hash.is_empty() {
        return error(StatusCode::BAD_REQUEST, "缺少 hash 参数");
    }
    let mut args: Vec<String> = vec!["show".into(), format!("{hash}")];
    if let Some(p) = &q.path {
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
