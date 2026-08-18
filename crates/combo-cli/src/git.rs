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

/// 提交时自动追加的署名稳定前缀(不含版本号);重复检测与 hook 内 grep
/// 都用它匹配,这样旧版本写入的署名(如 v0.2.11)也不会被重复追加。
pub const ATTRIBUTION_PREFIX: &str = "Generated with Combo";

/// 提交时自动追加的署名(含 combo 版本号,便于区分各版本生成的提交):
/// `Generated with Combo v0.2.12`。版本来自构建期 crate 版本,与
/// package.json / tauri.conf.json 保持一致(`scripts/version.sh` 统一升级)。
pub fn commit_attribution() -> String {
    format!("Generated with Combo v{}", env!("CARGO_PKG_VERSION"))
}

/// 全局 commit-msg hook 脚本:combo 开启「git 提交署名」时安装到
/// `core.hooksPath` 指向的目录,让 bash / IDE / 其他工具的一切提交
/// 都自动追加署名(已含署名时跳过)。关闭开关后 hook 被移除。
/// 署名行在安装时写入当前 combo 版本;启动/切换开关都会重新同步,
/// 版本升级后新提交自动携带新版本号。
fn attribution_hook_script() -> String {
    format!(
        r#"#!/bin/sh
# 由 combo 生成:git 提交自动追加 "Generated with Combo vX.Y.Z" 署名(含版本号)。
# 在 combo 设置中关闭「git 提交署名」后,本 hook 会被移除。
MSG_FILE="$1"
[ -f "$MSG_FILE" ] || exit 0
if grep -q 'Generated with Combo' "$MSG_FILE"; then
  exit 0
fi
if [ "$(tail -c 1 "$MSG_FILE" | wc -l)" -eq 0 ]; then
  printf '\n' >> "$MSG_FILE"
fi
printf '\n{}\n' >> "$MSG_FILE"
exit 0
"#,
        commit_attribution()
    )
}

/// 全局 hook 安装目录(数据目录下,`COMBO_DATA_DIR` 可覆盖)。
fn attribution_hook_dir() -> std::path::PathBuf {
    crate::paths::default_data_dir().join("git-hooks")
}

/// 记录「接管 core.hooksPath 之前的值」的文件,关闭开关时据此恢复。
const PREV_HOOKS_PATH_FILE: &str = ".combo-prev-hooks-path";

/// 执行 `git config --global`;`git_cfg` 非空时用 `GIT_CONFIG_GLOBAL`
/// 指向该文件(测试隔离用,生产传 None 走真实全局配置)。
fn git_config_global(args: &[&str], git_cfg: Option<&FsPath>) -> Result<String, String> {
    let mut cmd = Command::new("git");
    cmd.args(["config", "--global"]).args(args);
    if let Some(cfg) = git_cfg {
        cmd.env("GIT_CONFIG_GLOBAL", cfg);
    }
    let output = cmd
        .output()
        .map_err(|e| format!("无法执行 git config: {e}"))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stderr = stderr.trim();
        Err(if stderr.is_empty() {
            format!("git config 失败 (exit {:?})", output.status.code())
        } else {
            stderr.to_string()
        })
    }
}

fn set_hooks_path(hooks_dir: &FsPath, git_cfg: Option<&FsPath>) -> Result<(), String> {
    let dir = hooks_dir.to_string_lossy();
    git_config_global(&["core.hooksPath", &dir], git_cfg).map(|_| ())
}

fn unset_hooks_path(git_cfg: Option<&FsPath>) -> Result<(), String> {
    // 未设置过时 unset 返回非零,忽略即可。
    git_config_global(&["--unset", "core.hooksPath"], git_cfg).map(|_| ())
}

/// 按「git 提交署名」开关同步全局 commit-msg hook:
/// 开启时安装 hook 并把 `core.hooksPath` 指向 combo 管理的目录(接管前
/// 有旧值则记录,关闭时恢复);关闭时移除 hook、还原/卸载 hooksPath。
pub fn sync_attribution_hook(enabled: bool) -> Result<(), String> {
    let hooks_dir = attribution_hook_dir();
    sync_attribution_hook_to(&hooks_dir, enabled, None)
}

/// `sync_attribution_hook` 的实现;`git_cfg` 仅测试注入,生产为 None。
fn sync_attribution_hook_to(
    hooks_dir: &FsPath,
    enabled: bool,
    git_cfg: Option<&FsPath>,
) -> Result<(), String> {
    let hook_file = hooks_dir.join("commit-msg");
    let prev_file = hooks_dir.join(PREV_HOOKS_PATH_FILE);
    if enabled {
        std::fs::create_dir_all(hooks_dir)
            .map_err(|e| format!("创建 git hooks 目录失败: {e}"))?;
        // 记录接管前的 hooksPath;未设置或已是本目录时不记录。
        match git_config_global(&["core.hooksPath"], git_cfg) {
            Ok(prev) if !prev.is_empty() && FsPath::new(&prev) != hooks_dir => {
                std::fs::write(&prev_file, &prev)
                    .map_err(|e| format!("记录原 hooksPath 失败: {e}"))?;
            }
            _ => {
                let _ = std::fs::remove_file(&prev_file);
            }
        }
        std::fs::write(&hook_file, attribution_hook_script())
            .map_err(|e| format!("写入 commit-msg hook 失败: {e}"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&hook_file, std::fs::Permissions::from_mode(0o755))
                .map_err(|e| format!("设置 hook 可执行权限失败: {e}"))?;
        }
        set_hooks_path(hooks_dir, git_cfg)?;
    } else {
        // 还原接管前的 hooksPath(有记录则恢复,否则卸载),再删除 hook。
        let restore = std::fs::read_to_string(&prev_file).ok().map(|s| s.trim().to_string());
        match restore {
            Some(prev) if !prev.is_empty() => {
                set_hooks_path(FsPath::new(&prev), git_cfg)?;
            }
            _ => unset_hooks_path(git_cfg)?,
        }
        let _ = std::fs::remove_file(&prev_file);
        let _ = std::fs::remove_file(&hook_file);
    }
    Ok(())
}

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

/// 用 `git diff --no-index /dev/null <file>` 生成未跟踪(全新)文件的全新增 diff。
/// 注意 `--no-index` 在有差异时 exit code 为 1,与失败区分开。
fn git_diff_no_index(root: &FsPath, abs: &FsPath) -> Result<String, String> {
    let output = Command::new("git")
        .current_dir(root)
        .args(["diff", "--no-index", "--", "/dev/null"])
        .arg(abs)
        .output()
        .map_err(|e| format!("无法执行 git: {e}"))?;
    if !output.status.success() && output.status.code() != Some(1) {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stderr = stderr.trim();
        return Err(if stderr.is_empty() {
            format!("git diff --no-index 失败 (exit {})", output.status.code().unwrap_or(-1))
        } else {
            stderr.to_string()
        });
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
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
    let mut rel_opt: Option<String> = None;
    if let Some(p) = path {
        if !p.is_empty() {
            match safe_join(&root, p) {
                Ok(abs) => {
                    if let Ok(rel) = abs.strip_prefix(&root) {
                        rel_opt = Some(rel.to_string_lossy().into_owned());
                    }
                }
                Err(e) => return error(StatusCode::BAD_REQUEST, &e.to_string()),
            }
        }
    }
    if let Some(rel) = &rel_opt {
        args.push("--".into());
        args.push(rel.clone());
    }
    let diff_text = match git_output(&root, &args) {
        Ok(t) => t,
        Err(msg) => return error(StatusCode::INTERNAL_SERVER_ERROR, &msg),
    };

    // git diff 不包含未跟踪文件:指定单文件且无差异时,若该文件未跟踪,
    // 回退为生成全新增 diff(staged diff 只反映暂存区,不做回退)。
    let diff_text = if !matches!(scope, DiffScope::Staged) && diff_text.trim().is_empty() {
        if let Some(rel) = rel_opt.as_ref() {
            let untracked = git_output(
                &root,
                ["ls-files", "--others", "--exclude-standard", "--", rel],
            )
            .map(|o| !o.trim().is_empty())
            .unwrap_or(false);
            if untracked {
                if let Ok(abs) = safe_join(&root, rel) {
                    // 输出头是绝对路径(git 会去掉前导 /,如 a/tmp/...),
                    // 重写为仓库相对路径,与常规 git diff 一致
                    if let Ok(t) = git_diff_no_index(&root, &abs) {
                        let abs_no_slash = abs.to_string_lossy();
                        let abs_no_slash = abs_no_slash.trim_start_matches('/');
                        t.replace(abs_no_slash, rel)
                    } else {
                        diff_text
                    }
                } else {
                    diff_text
                }
            } else {
                diff_text
            }
        } else {
            diff_text
        }
    } else {
        diff_text
    };

    ok_json(json!({ "diff": diff_text }))
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
    // 自动追加署名(含版本号),标识由 Combo 生成的提交;已含署名时不重复追加
    // (按稳定前缀匹配,旧版本写入的署名也不会重复)。开关存于配置文件
    // commit_attribution(默认开启),每次提交时读取、即时生效。
    let attribution_on =
        crate::config::commit_attribution_enabled(&crate::config::default_config_path());
    let full_msg = if !attribution_on || msg.contains(ATTRIBUTION_PREFIX) {
        msg.to_string()
    } else {
        format!("{msg}\n\n{}", commit_attribution())
    };
    match git_output(&root, ["commit", "-m", &full_msg]) {
        Ok(output) => ok_json(json!({ "ok": true, "output": output })),
        Err(msg) => error(StatusCode::INTERNAL_SERVER_ERROR, &msg),
    }
}

#[derive(Deserialize)]
pub struct AttributionBody {
    pub enabled: bool,
}

/// GET /v1/settings/commit-attribution — 读取「git 提交署名」开关。
pub async fn attribution_get() -> Response {
    let enabled = crate::config::commit_attribution_enabled(&crate::config::default_config_path());
    ok_json(json!({ "enabled": enabled }))
}

/// POST /v1/settings/commit-attribution — 写入「git 提交署名」开关(持久化到配置文件)。
pub async fn attribution_set(
    axum::extract::Json(body): axum::extract::Json<AttributionBody>,
) -> Response {
    match crate::config::set_commit_attribution(&crate::config::default_config_path(), body.enabled)
    {
        Ok(()) => {
            // 同步全局 commit-msg hook:开启时 bash/其他工具提交也自动署名。
            if let Err(e) = sync_attribution_hook(body.enabled) {
                tracing::warn!("同步 git 提交署名 hook 失败: {e}");
            }
            ok_json(json!({ "enabled": body.enabled }))
        }
        Err(e) => error(StatusCode::INTERNAL_SERVER_ERROR, &format!("保存署名开关失败: {e}")),
    }
}

#[derive(Deserialize)]
pub struct CommitModelBody {
    pub enabled: bool,
    pub provider: Option<String>,
    pub model: Option<String>,
}

/// GET /v1/settings/commit-model — 读取「git 提交全局模型」配置
/// (AI 生成提交信息时优先使用的模型;未开启时用会话模型)。
pub async fn commit_model_get() -> Response {
    let (enabled, provider, model) =
        crate::config::get_commit_model(&crate::config::default_config_path());
    ok_json(json!({ "enabled": enabled, "provider": provider, "model": model }))
}

/// POST /v1/settings/commit-model — 写入「git 提交全局模型」配置。
/// 开启时 provider 必填;model 可留空(用 provider 的默认大模型)。
pub async fn commit_model_set(
    axum::extract::Json(body): axum::extract::Json<CommitModelBody>,
) -> Response {
    let provider = body
        .provider
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let model = body
        .model
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    if body.enabled && provider.is_none() {
        return error(StatusCode::BAD_REQUEST, "开启全局提交模型需要选择 Provider");
    }
    match crate::config::set_commit_model(
        &crate::config::default_config_path(),
        body.enabled,
        provider,
        model,
    ) {
        Ok(()) => ok_json(json!({
            "enabled": body.enabled,
            "provider": provider,
            "model": model,
        })),
        Err(e) => error(StatusCode::INTERNAL_SERVER_ERROR, &format!("保存提交模型配置失败: {e}")),
    }
}

#[derive(Deserialize)]
pub struct CommitMessageBody {
    pub repo: Option<String>,
}

/// 生成提交信息的系统提示词:约束模型只输出一行 conventional commit。
const COMMIT_MESSAGE_PREAMBLE: &str = "你是 git 提交信息生成器。根据用户提供的已暂存 diff 与最近提交风格,输出一条简洁的提交信息。\n规则:\n- 使用 conventional commits 格式:type: 描述(可带作用域 type(scope): 描述)。\n- type 从 feat/fix/docs/style/refactor/perf/test/chore/ci/build 中选择。\n- 描述用中文概括本次变更的目的,不超过 50 个字符。\n- 只输出提交信息这一行文本,不要解释、不要引号、不要代码块。";

/// 送入模型的 diff 上限(超出截断,提交信息只需看变更概貌)。
const COMMIT_DIFF_LIMIT: usize = 16_000;

/// 截断过长的 diff(按字符边界安全截断)。
fn truncate_diff(diff: &str) -> String {
    if diff.len() <= COMMIT_DIFF_LIMIT {
        return diff.to_string();
    }
    let mut end = COMMIT_DIFF_LIMIT;
    while !diff.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\n... (diff 过长,已截断)", &diff[..end])
}

/// 清理模型返回的提交信息:去代码围栏/成对引号/「提交信息:」前缀与多余空行,
/// 多行时只保留首行(subject)——提示词已要求单行输出。
fn sanitize_commit_message(raw: &str) -> String {
    let mut s = raw.trim();
    if let Some(rest) = s.strip_prefix("```") {
        let rest = rest.trim_start_matches(|c: char| c.is_ascii_alphanumeric());
        s = match rest.rfind("```") {
            Some(end) => rest[..end].trim(),
            None => rest.trim(),
        };
    }
    let mut lines = s.lines().map(str::trim).filter(|l| !l.is_empty());
    let mut first = lines.next().unwrap_or("").to_string();
    for prefix in ["提交信息:", "提交信息：", "commit message:", "Commit message:", "message:"] {
        if let Some(rest) = first.strip_prefix(prefix) {
            first = rest.trim().to_string();
            break;
        }
    }
    let unquoted = first.trim_matches(|c| c == '"' || c == '\'' || c == '`').to_string();
    unquoted
}

/// POST /v1/workspaces/{id}/git/commit-message — AI 生成提交信息。
/// 基于已暂存的 diff 与最近提交风格生成,不执行任何 git 写操作;
/// 模型优先用设置中开启的「全局提交模型」,未开启(或解析失败)时回退
/// 该 workspace 会话当前生效的模型。
pub async fn commit_message(
    State(state): State<AppState>,
    Path(id): Path<String>,
    axum::extract::Json(body): axum::extract::Json<CommitMessageBody>,
) -> Response {
    let root = match resolve_git_dir(&state, &id, body.repo.as_deref()) {
        Ok(r) => r,
        Err(resp) => return resp,
    };
    let diff = match git_output(&root, ["diff", "--cached"]) {
        Ok(d) => d,
        Err(msg) => return error(StatusCode::INTERNAL_SERVER_ERROR, &msg),
    };
    if diff.trim().is_empty() {
        return error(StatusCode::BAD_REQUEST, "没有已暂存的变更,请先暂存要提交的文件");
    }
    // 最近提交信息供模型对齐风格;空仓库/无历史时忽略
    let recent = git_output(&root, ["log", "-n", "10", "--pretty=format:%s"]).unwrap_or_default();

    // 模型解析:全局提交模型(设置中开启)优先,否则用会话(workspace)模型
    let mut cfg = crate::serve::workspace_effective_cfg(&state, &id);
    let using_global =
        match crate::config::commit_model_override(&crate::config::default_config_path()) {
            Some((pid, model)) => {
                let config_path = crate::config::AppConfig::load_or_create(
                    &crate::config::default_config_path(),
                )
                .unwrap_or_default();
                match crate::providers::find_provider(&pid, &config_path.providers) {
                    Ok(p) => {
                        cfg.provider = p;
                        cfg.model = model.unwrap_or_else(|| cfg.provider.default_model());
                        true
                    }
                    Err(e) => {
                        tracing::warn!(
                            "全局提交模型 provider `{pid}` 解析失败,回退会话模型: {e}"
                        );
                        false
                    }
                }
            }
            None => false,
        };

    let mut prompt = String::new();
    if !recent.trim().is_empty() {
        prompt.push_str("最近的提交信息(供风格参考):\n");
        prompt.push_str(&recent);
        prompt.push_str("\n\n");
    }
    prompt.push_str("已暂存的变更(diff):\n");
    prompt.push_str(&truncate_diff(&diff));

    // 单轮无工具调用:复用 agent 的 provider 分派,关掉工具与 MCP
    let mut ask = cfg.clone();
    ask.tools = false;
    ask.mcp_command = None;
    ask.mcp_url = None;
    ask.mcp_servers = Vec::new();
    ask.reasoning_effort = None;
    ask.preamble = COMMIT_MESSAGE_PREAMBLE.to_string();

    match crate::agent::ask_answer(&ask, &prompt, None).await {
        Ok(raw) => {
            let message = sanitize_commit_message(&raw);
            if message.is_empty() {
                return error(StatusCode::INTERNAL_SERVER_ERROR, "模型未返回有效的提交信息");
            }
            ok_json(json!({
                "message": message,
                "provider": ask.provider.id,
                "model": ask.model,
                "global_model": using_global,
            }))
        }
        Err(e) => error(StatusCode::INTERNAL_SERVER_ERROR, &format!("生成提交信息失败: {e}")),
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

/// 校验分支名:只允许 git ref 合法字符,防止参数注入。
fn valid_branch_name(name: &str) -> bool {
    !name.is_empty()
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "._-/*".contains(c))
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
    if !valid_branch_name(&body.branch) {
        return error(StatusCode::BAD_REQUEST, "非法的分支名");
    }
    match git_output(&root, ["checkout", &body.branch]) {
        Ok(output) => ok_json(json!({ "ok": true, "output": output })),
        Err(msg) => error(StatusCode::INTERNAL_SERVER_ERROR, &msg),
    }
}

/// POST /v1/workspaces/{id}/git/branch/create  body: { "branch": "xxx", "repo": "..." }
/// 新建本地分支(基于当前 HEAD,不切换)。
pub async fn git_branch_create(
    State(state): State<AppState>,
    Path(id): Path<String>,
    axum::extract::Json(body): axum::extract::Json<BranchBody>,
) -> Response {
    let root = match resolve_git_dir(&state, &id, body.repo.as_deref()) {
        Ok(r) => r,
        Err(resp) => return resp,
    };
    if !valid_branch_name(&body.branch) {
        return error(StatusCode::BAD_REQUEST, "非法的分支名");
    }
    match git_output(&root, ["branch", &body.branch]) {
        Ok(output) => ok_json(json!({ "ok": true, "output": output })),
        Err(msg) => error(StatusCode::INTERNAL_SERVER_ERROR, &msg),
    }
}

#[derive(Deserialize)]
pub struct BranchDeleteBody {
    pub branch: String,
    pub repo: Option<String>,
    /// 强制删除(`-D`):丢弃未合并到上游/HEAD 的提交
    #[serde(default)]
    pub force: bool,
}

/// POST /v1/workspaces/{id}/git/branch/delete  body: { "branch": "xxx", "repo": "...", "force": false }
/// 删除本地分支。当前分支不可删除;默认安全删除(`-d`,未合并时 git 拒绝)。
pub async fn git_branch_delete(
    State(state): State<AppState>,
    Path(id): Path<String>,
    axum::extract::Json(body): axum::extract::Json<BranchDeleteBody>,
) -> Response {
    let root = match resolve_git_dir(&state, &id, body.repo.as_deref()) {
        Ok(r) => r,
        Err(resp) => return resp,
    };
    if !valid_branch_name(&body.branch) {
        return error(StatusCode::BAD_REQUEST, "非法的分支名");
    }
    let current = git_output(&root, ["rev-parse", "--abbrev-ref", "HEAD"])
        .map(|s| s.trim().to_string())
        .unwrap_or_default();
    if body.branch == current {
        return error(StatusCode::BAD_REQUEST, "不能删除当前所在分支");
    }
    let flag = if body.force { "-D" } else { "-d" };
    match git_output(&root, ["branch", flag, &body.branch]) {
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
    fn sanitize_commit_message_strips_wrappers() {
        // 纯文本直通
        assert_eq!(sanitize_commit_message("feat: 支持语音输入"), "feat: 支持语音输入");
        // 代码围栏(带语言标注)
        assert_eq!(
            sanitize_commit_message("```text\nfix: 修复登录失败\n```"),
            "fix: 修复登录失败"
        );
        // 成对引号
        assert_eq!(sanitize_commit_message("\"docs: 更新说明\""), "docs: 更新说明");
        // 「提交信息:」前缀
        assert_eq!(
            sanitize_commit_message("提交信息:chore: 清理依赖"),
            "chore: 清理依赖"
        );
        // 多行只保留首行 subject,首尾空行剔除
        assert_eq!(
            sanitize_commit_message("\n  feat: 新增图表  \n\n详细说明第二行\n"),
            "feat: 新增图表"
        );
        // 前缀在围栏+引号叠加时也能剥掉
        assert_eq!(
            sanitize_commit_message("```\ncommit message: \"refactor: 拆分模块\"\n```"),
            "refactor: 拆分模块"
        );
    }

    #[test]
    fn truncate_diff_respects_limit_and_char_boundary() {
        let short = "diff --git a/x b/x\n+1";
        assert_eq!(truncate_diff(short), short);
        let long = "汉".repeat(COMMIT_DIFF_LIMIT); // 多字节字符,截断点须落在字符边界
        let out = truncate_diff(&long);
        assert!(out.len() > COMMIT_DIFF_LIMIT);
        assert!(out.ends_with("... (diff 过长,已截断)"));
        // 截断后仍是合法 UTF-8(能按字符统计即未断在字节中间)
        assert_eq!(out.chars().filter(|c| *c == '汉').count(), COMMIT_DIFF_LIMIT / 3);
    }

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

    /// 未跟踪(全新)文件应生成全新增 diff,而不是空 diff。
    /// 覆盖 git_diff_no_index 与 diff_impl 的未跟踪回退路径。
    #[test]
    fn untracked_file_diff_shows_full_addition() {
        let dir = std::env::temp_dir().join(format!("combo-git-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        git_output(&dir, ["init", "-q"]).unwrap();
        // CI 环境可能没有全局 git 身份,设置仓库级身份保证 commit 可用
        git_output(&dir, ["config", "user.email", "test@combo.local"]).unwrap();
        git_output(&dir, ["config", "user.name", "combo-test"]).unwrap();
        git_output(&dir, ["commit", "-q", "--allow-empty", "-m", "init"])
            .unwrap();
        let file = dir.join("new_file.ts");
        std::fs::write(&file, "line1\nline2\n").unwrap();

        // git diff(HEAD/工作区)对未跟踪文件输出为空
        let plain = git_output(&dir, ["diff", "HEAD", "--", "new_file.ts"]).unwrap();
        assert!(plain.trim().is_empty());

        // 未跟踪识别:ls-files --others 输出非空
        let untracked = git_output(
            &dir,
            ["ls-files", "--others", "--exclude-standard", "--", "new_file.ts"],
        )
        .unwrap();
        assert!(!untracked.trim().is_empty());

        // --no-index 生成全新增 diff(exit 1 视为成功),路径重写为相对路径
        let diff = git_diff_no_index(&dir, &file).unwrap();
        assert!(diff.contains("@@ -0,0 +1,2 @@"), "缺少全新增 hunk: {diff}");
        assert!(diff.contains("+line1"));
        assert!(diff.contains("+line2"));
        let rewritten = diff.replace(
            file.to_string_lossy().trim_start_matches('/'),
            "new_file.ts",
        );
        assert!(rewritten.contains("+++ b/new_file.ts"), "路径未重写: {rewritten}");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 构造带临时 git 仓库 workspace 的测试 AppState。
    async fn branch_test_state(tag: &str) -> (AppState, std::path::PathBuf, String) {
        let dir = std::env::temp_dir().join(format!("combo-git-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        git_output(&dir, ["init", "-q"]).unwrap();
        // CI 环境可能没有全局 git 身份,设置仓库级身份保证 commit 可用
        git_output(&dir, ["config", "user.email", "test@combo.local"]).unwrap();
        git_output(&dir, ["config", "user.name", "combo-test"]).unwrap();
        git_output(&dir, ["commit", "-q", "--allow-empty", "-m", "init"]).unwrap();
        let current = git_output(&dir, ["rev-parse", "--abbrev-ref", "HEAD"])
            .unwrap()
            .trim()
            .to_string();
        let meta = std::sync::Arc::new(crate::meta::MetaStore::new());
        meta.insert(crate::meta::WorkspaceMeta {
            id: "ws".into(),
            path: dir.clone(),
            name: "test".into(),
            backend_type: crate::store::BackendType::ComboCli,
        });
        (AppState::test_state(meta, None), dir, current)
    }

    #[tokio::test]
    async fn branch_create_and_delete() {
        let (state, dir, current) = branch_test_state("crud").await;

        // 新建分支成功
        let resp = git_branch_create(
            State(state.clone()),
            Path("ws".into()),
            axum::extract::Json(BranchBody { branch: "feature/x".into(), repo: None }),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);

        // 非法分支名被拒绝
        let resp = git_branch_create(
            State(state.clone()),
            Path("ws".into()),
            axum::extract::Json(BranchBody { branch: "bad name".into(), repo: None }),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);

        // 不能删除当前分支
        let resp = git_branch_delete(
            State(state.clone()),
            Path("ws".into()),
            axum::extract::Json(BranchDeleteBody { branch: current.clone(), repo: None, force: false }),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);

        // 删除已合并分支成功
        let resp = git_branch_delete(
            State(state.clone()),
            Path("ws".into()),
            axum::extract::Json(BranchDeleteBody { branch: "feature/x".into(), repo: None, force: false }),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);
        let refs = git_output(&dir, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]).unwrap();
        assert!(!refs.contains("feature/x"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn branch_delete_unmerged_requires_force() {
        let (state, dir, current) = branch_test_state("force").await;
        git_output(&dir, ["checkout", "-q", "-b", "wip"]).unwrap();
        git_output(&dir, ["commit", "-q", "--allow-empty", "-m", "on wip"]).unwrap();
        git_output(&dir, ["checkout", "-q", &current]).unwrap();

        // 安全删除未合并分支:git 拒绝,返回 500
        let resp = git_branch_delete(
            State(state.clone()),
            Path("ws".into()),
            axum::extract::Json(BranchDeleteBody { branch: "wip".into(), repo: None, force: false }),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::INTERNAL_SERVER_ERROR);

        // 强制删除成功
        let resp = git_branch_delete(
            State(state.clone()),
            Path("ws".into()),
            axum::extract::Json(BranchDeleteBody { branch: "wip".into(), repo: None, force: true }),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 提交时应自动追加 "Generated with Combo vX.Y.Z" 署名(含版本号);
    /// 已含署名时不重复追加;配置 commit_attribution = false 时完全不追加。
    #[tokio::test]
    async fn commit_appends_attribution() {
        // 隔离配置目录:署名开关读配置文件,不能依赖开发机真实 ~/.config/combo
        let _env = crate::paths::ENV_LOCK.lock().unwrap();
        let cfg_dir = tempfile::tempdir().unwrap();
        let prev_cfg = std::env::var_os("COMBO_CONFIG_DIR");
        std::env::set_var("COMBO_CONFIG_DIR", cfg_dir.path());

        let (state, dir, _current) = branch_test_state("attr").await;
        std::fs::write(dir.join("a.txt"), "v1\n").unwrap();
        git_output(&dir, ["add", "."]).unwrap();

        let resp = commit(
            State(state.clone()),
            Path("ws".into()),
            axum::extract::Json(CommitBody { message: "测试提交".into(), repo: None }),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);
        let body = git_output(&dir, ["log", "-1", "--pretty=%B"]).unwrap();
        assert!(body.contains("测试提交"), "缺少原始信息: {body}");
        assert!(body.contains(&commit_attribution()), "缺少署名: {body}");

        // 信息中已含署名时不重复追加
        std::fs::write(dir.join("a.txt"), "v2\n").unwrap();
        git_output(&dir, ["add", "."]).unwrap();
        let resp = commit(
            State(state.clone()),
            Path("ws".into()),
            axum::extract::Json(CommitBody {
                message: format!("再次提交\n\n{}", commit_attribution()),
                repo: None,
            }),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);
        let body = git_output(&dir, ["log", "-1", "--pretty=%B"]).unwrap();
        assert_eq!(body.matches(ATTRIBUTION_PREFIX).count(), 1, "署名重复: {body}");

        // 关闭开关后提交不再追加署名,原始信息原样保留
        crate::config::set_commit_attribution(&cfg_dir.path().join("combo-cli.toml"), false)
            .unwrap();
        std::fs::write(dir.join("a.txt"), "v3\n").unwrap();
        git_output(&dir, ["add", "."]).unwrap();
        let resp = commit(
            State(state.clone()),
            Path("ws".into()),
            axum::extract::Json(CommitBody { message: "无署名提交".into(), repo: None }),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);
        let body = git_output(&dir, ["log", "-1", "--pretty=%B"]).unwrap();
        assert!(!body.contains(ATTRIBUTION_PREFIX), "关闭后仍追加署名: {body}");
        assert!(body.contains("无署名提交"));

        let _ = std::fs::remove_dir_all(&dir);
        match prev_cfg {
            Some(v) => std::env::set_var("COMBO_CONFIG_DIR", v),
            None => std::env::remove_var("COMBO_CONFIG_DIR"),
        }
    }

    /// GET/POST /v1/settings/commit-attribution:缺省开启、POST 持久化到配置文件。
    #[tokio::test]
    async fn attribution_endpoint_roundtrip() {
        let _env = crate::paths::ENV_LOCK.lock().unwrap();
        let cfg_dir = tempfile::tempdir().unwrap();
        let prev_cfg = std::env::var_os("COMBO_CONFIG_DIR");
        std::env::set_var("COMBO_CONFIG_DIR", cfg_dir.path());
        let cfg_path = cfg_dir.path().join("combo-cli.toml");

        // 无配置时默认开启
        let resp = attribution_get().await;
        assert_eq!(resp.status(), StatusCode::OK);
        let body = axum::body::to_bytes(resp.into_body(), 64 * 1024).await.unwrap();
        let val: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(val["enabled"], serde_json::json!(true));

        // 关闭并持久化
        let resp = attribution_set(axum::extract::Json(AttributionBody { enabled: false })).await;
        assert_eq!(resp.status(), StatusCode::OK);
        let cfg = crate::config::AppConfig::load_or_create(&cfg_path).unwrap();
        assert_eq!(cfg.commit_attribution, Some(false));

        // 重新读取生效
        assert!(!crate::config::commit_attribution_enabled(&cfg_path));

        match prev_cfg {
            Some(v) => std::env::set_var("COMBO_CONFIG_DIR", v),
            None => std::env::remove_var("COMBO_CONFIG_DIR"),
        }
    }

    /// 开启署名时安装全局 commit-msg hook 并接管 core.hooksPath,
    /// 关闭时移除 hook、卸载 hooksPath(用 GIT_CONFIG_GLOBAL 隔离,不动真实全局配置)。
    #[test]
    fn global_hook_install_and_remove() {
        let _env = crate::paths::ENV_LOCK.lock().unwrap();
        let base = tempfile::tempdir().unwrap();
        let hooks_dir = base.path().join("git-hooks");
        let cfg_file = base.path().join("gitconfig");

        sync_attribution_hook_to(&hooks_dir, true, Some(&cfg_file)).unwrap();
        let hook_file = hooks_dir.join("commit-msg");
        assert!(hook_file.is_file(), "hook 文件未创建");
        let script = std::fs::read_to_string(&hook_file).unwrap();
        assert!(script.contains(&commit_attribution()), "hook 脚本缺少署名文本");
        assert!(script.contains(ATTRIBUTION_PREFIX), "hook 脚本缺少署名前缀");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&hook_file).unwrap().permissions().mode();
            assert_ne!(mode & 0o111, 0, "hook 缺少可执行权限");
        }
        let cur = git_config_global(&["core.hooksPath"], Some(&cfg_file)).unwrap();
        assert_eq!(FsPath::new(&cur), hooks_dir, "core.hooksPath 未指向 hook 目录");

        // 关闭:hook 移除、配置卸载
        sync_attribution_hook_to(&hooks_dir, false, Some(&cfg_file)).unwrap();
        assert!(!hook_file.exists(), "关闭后 hook 未移除");
        assert!(
            git_config_global(&["core.hooksPath"], Some(&cfg_file)).is_err(),
            "关闭后 hooksPath 未卸载"
        );
    }

    /// 接管前已存在自定义 core.hooksPath 时,关闭后恢复原值。
    #[test]
    fn global_hook_restores_previous_path() {
        let _env = crate::paths::ENV_LOCK.lock().unwrap();
        let base = tempfile::tempdir().unwrap();
        let hooks_dir = base.path().join("git-hooks");
        let cfg_file = base.path().join("gitconfig");
        let prev = "/custom/hooks";
        set_hooks_path(FsPath::new(prev), Some(&cfg_file)).unwrap();

        sync_attribution_hook_to(&hooks_dir, true, Some(&cfg_file)).unwrap();
        let cur = git_config_global(&["core.hooksPath"], Some(&cfg_file)).unwrap();
        assert_eq!(FsPath::new(&cur), hooks_dir);

        sync_attribution_hook_to(&hooks_dir, false, Some(&cfg_file)).unwrap();
        let cur = git_config_global(&["core.hooksPath"], Some(&cfg_file)).unwrap();
        assert_eq!(cur, prev, "关闭后未恢复原 hooksPath");
    }

    /// 端到端:普通 `git commit`(不经 combo 接口)也会被 hook 追加署名,已含署名不重复。
    #[test]
    fn global_hook_appends_attribution_on_plain_commit() {
        let _env = crate::paths::ENV_LOCK.lock().unwrap();
        let base = tempfile::tempdir().unwrap();
        let hooks_dir = base.path().join("git-hooks");
        let cfg_file = base.path().join("gitconfig");
        let repo = base.path().join("repo");

        sync_attribution_hook_to(&hooks_dir, true, Some(&cfg_file)).unwrap();
        // 仓库级身份 + 全局配置(GIT_CONFIG_GLOBAL 指向隔离文件)
        std::fs::create_dir_all(&repo).unwrap();
        git_output(&repo, ["init", "-q"]).unwrap();
        git_output(&repo, ["config", "user.email", "test@combo.local"]).unwrap();
        git_output(&repo, ["config", "user.name", "combo-test"]).unwrap();
        std::fs::write(repo.join("a.txt"), "v1\n").unwrap();
        git_output(&repo, ["add", "."]).unwrap();

        let output = Command::new("git")
            .current_dir(&repo)
            .env("GIT_CONFIG_GLOBAL", &cfg_file)
            .args(["commit", "-m", "纯命令行提交"])
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "commit 失败: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let body = git_output(&repo, ["log", "-1", "--pretty=%B"]).unwrap();
        assert!(body.contains("纯命令行提交"));
        assert!(body.contains(&commit_attribution()), "命令行提交缺少署名: {body}");

        // 已含署名时不重复追加
        std::fs::write(repo.join("a.txt"), "v2\n").unwrap();
        git_output(&repo, ["add", "."]).unwrap();
        let output = Command::new("git")
            .current_dir(&repo)
            .env("GIT_CONFIG_GLOBAL", &cfg_file)
            .args(["commit", "-m", format!("再次提交\n\n{}", commit_attribution()).as_str()])
            .output()
            .unwrap();
        assert!(output.status.success());
        let body = git_output(&repo, ["log", "-1", "--pretty=%B"]).unwrap();
        assert_eq!(body.matches(ATTRIBUTION_PREFIX).count(), 1, "署名重复: {body}");

        // 关闭开关后命令行提交不再署名
        sync_attribution_hook_to(&hooks_dir, false, Some(&cfg_file)).unwrap();
        std::fs::write(repo.join("a.txt"), "v3\n").unwrap();
        git_output(&repo, ["add", "."]).unwrap();
        let output = Command::new("git")
            .current_dir(&repo)
            .env("GIT_CONFIG_GLOBAL", &cfg_file)
            .args(["commit", "-m", "关闭后提交"])
            .output()
            .unwrap();
        assert!(output.status.success());
        let body = git_output(&repo, ["log", "-1", "--pretty=%B"]).unwrap();
        assert!(!body.contains(ATTRIBUTION_PREFIX), "关闭后仍署名: {body}");
    }

    /// 署名格式:以稳定前缀开头,并携带构建期版本号(vX.Y.Z)。
    #[test]
    fn attribution_includes_version() {
        let line = commit_attribution();
        assert!(line.starts_with("Generated with Combo v"), "署名前缀异常: {line}");
        let ver = line.trim_start_matches("Generated with Combo v");
        assert!(
            ver.chars().next().is_some_and(|c| c.is_ascii_digit()),
            "署名缺少版本号: {line}"
        );
    }
}
