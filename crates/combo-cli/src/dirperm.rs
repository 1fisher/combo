//! 目录访问授权(敏感目录只询问一次)。
//!
//! macOS 的 TCC 会保护 桌面/文稿/下载、iCloud 云盘 与外置卷(移动硬盘、U 盘,
//! `/Volumes` 下的挂载点):后台进程首次触碰这些路径时系统弹出「是否允许」。
//! combo 在 **创建项目 / 更换绑定目录** 时先经过这里做应用层把关:
//!
//! - 目录不在敏感位置 → 直接放行(行为与之前完全一致);
//! - 在敏感位置但 sqlite `dir_grants` 已有覆盖该路径的授权 → 放行,不再询问;
//! - 在敏感位置且无授权 → 返回 403 `dir_permission_required`(携带规范化路径),
//!   前端弹出「是否允许访问该目录」;用户点「允许」后 `POST /v1/dir-grants`
//!   持久记住,并自动重试原请求。之后同一目录(含子目录)永不再问。
//!
//! 路径匹配全部走 **词法规范化**(不 `canonicalize`),避免检查本身触碰磁盘、
//! 提前触发系统 TCC 弹窗。已存在的旧项目不受影响(不做启动期回溯检查)。

use crate::serve::AppState;
use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::Response;
use serde_json::{Value, json};
use std::path::{Component, Path as FsPath};

/// 403 响应里的错误码,前端据此识别并弹授权对话框。
pub const ERR_CODE: &str = "dir_permission_required";

/// 词法规范化:清理 `.`/`..`/重复分隔符/末尾斜杠;相对路径基于 cwd 提升为绝对路径。
/// 故意不做 `canonicalize`——那会触碰磁盘,在敏感目录上提前触发系统 TCC 弹窗。
pub fn normalize(raw: &str) -> String {
    let p = FsPath::new(raw);
    let abs = if p.is_absolute() {
        p.to_path_buf()
    } else {
        std::env::current_dir().unwrap_or_default().join(p)
    };
    let mut normalized = FsPath::new("/").to_path_buf();
    for c in abs.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            Component::RootDir => {}
            other => normalized.push(other.as_os_str()),
        }
    }
    let s = normalized.to_string_lossy().to_string();
    if s.is_empty() {
        "/".to_string()
    } else {
        s
    }
}

/// 大小写归一(macOS/Windows 文件系统大小写不敏感,比较前统一小写;
/// Linux 保持原样)。
fn key(p: &str) -> String {
    if cfg!(any(target_os = "macos", target_os = "windows")) {
        p.to_lowercase()
    } else {
        p.to_string()
    }
}

/// 判断目录是否位于需要授权的敏感位置:
/// - 外置/移动卷:`/Volumes` 下的挂载点(移动硬盘、U 盘等);
/// - 用户主目录下的 桌面 / 文稿 / 下载;
/// - iCloud 云盘:`~/Library/Mobile Documents`。
pub fn is_protected(raw: &str) -> bool {
    let p = normalize(raw);
    let k = key(&p);
    // 外置/移动卷(macOS `/Volumes` 下的挂载点):挂载点为约定命名,大小写无关
    // 比较保证跨平台一致(Linux 上不存在的路径也要按敏感位置判断)。
    let k_lower = k.to_lowercase();
    if k_lower == "/volumes" || k_lower.starts_with("/volumes/") {
        return true;
    }
    let Some(home) = std::env::var_os("HOME") else {
        return false;
    };
    let home_k = key(&normalize(&home.to_string_lossy()));
    let Some(rest) = k.strip_prefix(&format!("{}/", home_k.trim_end_matches('/'))) else {
        return false;
    };
    let first = rest.split('/').next().unwrap_or("");
    // 敏感目录名(桌面/文稿/下载)按与 `key` 相同的大小写规则归一:mac/win
    // 大小写不敏感(全小写),Linux 保留规范大小写——`Documents` 敏感而
    // 全大写的 `DOCUMENTS` 在区分大小写的 Linux 上是不同目录、不敏感。
    let names = ["Desktop", "Documents", "Downloads"];
    if names.iter().any(|n| first == key(n)) {
        return true;
    }
    // iCloud 云盘路径同样按 `key` 规则归一后比较。
    rest.starts_with(&key("Library/Mobile Documents"))
}

/// `grant` 是否覆盖 `path`(相等或为其祖先目录)。
fn covers(path: &str, grant: &str) -> bool {
    let pk = key(path);
    let gk = key(grant).trim_end_matches('/').to_string();
    pk == gk || pk.starts_with(&format!("{gk}/"))
}

/// 授权检查:需要用户确认时返回 403 响应,否则返回 None 放行。
/// 供 `workspace::create` / `workspace::rename`(更换目录)在落库前调用。
pub fn check(state: &AppState, raw_path: &str) -> Option<Response> {
    if !is_protected(raw_path) {
        return None;
    }
    let path = normalize(raw_path);
    let granted = state
        .meta
        .db()
        .list_dir_grants()
        .unwrap_or_default()
        .iter()
        .any(|g| covers(&path, &g.path));
    if granted {
        return None;
    }
    Some(json_gate_err(&path))
}

fn json_gate_err(path: &str) -> Response {
    Response::builder()
        .status(StatusCode::FORBIDDEN)
        .header("content-type", "application/json")
        .body(Body::from(
            json!({
                "message": "该目录位于受保护位置,需要允许后才能访问",
                "code": ERR_CODE,
                "path": path,
            })
            .to_string(),
        ))
        .unwrap()
}

fn json_status(status: StatusCode, v: &Value) -> Response {
    Response::builder()
        .status(status)
        .header("content-type", "application/json")
        .body(Body::from(v.to_string()))
        .unwrap()
}

/// GET /v1/dir-grants — 已授权目录列表。
pub async fn list(State(state): State<AppState>) -> Response {
    let grants = state.meta.db().list_dir_grants().unwrap_or_default();
    let arr: Vec<Value> = grants
        .iter()
        .map(|g| json!({ "id": g.id, "path": g.path, "created_at": g.created_at }))
        .collect();
    json_status(StatusCode::OK, &json!({ "grants": arr }))
}

/// POST /v1/dir-grants — 记住一条目录授权 `{ path }`(幂等)。
pub async fn grant(
    State(state): State<AppState>,
    axum::extract::Json(body): axum::extract::Json<Value>,
) -> Response {
    let path = body.get("path").and_then(|v| v.as_str()).unwrap_or("");
    if path.trim().is_empty() {
        return json_status(
            StatusCode::BAD_REQUEST,
            &json!({ "message": "缺少 path" }),
        );
    }
    let normalized = normalize(path);
    match state.meta.db().upsert_dir_grant(&normalized) {
        Ok(()) => json_status(StatusCode::OK, &json!({ "ok": true, "path": normalized })),
        Err(e) => json_status(
            StatusCode::INTERNAL_SERVER_ERROR,
            &json!({ "message": format!("保存目录授权失败: {e}") }),
        ),
    }
}

/// DELETE /v1/dir-grants/:id — 撤销一条目录授权(下次访问该目录会重新询问)。
pub async fn revoke(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    let Ok(id) = id.parse::<i64>() else {
        return json_status(StatusCode::BAD_REQUEST, &json!({ "message": "id 无效" }));
    };
    match state.meta.db().delete_dir_grant(id) {
        Ok(true) => json_status(StatusCode::OK, &json!({ "ok": true })),
        Ok(false) => json_status(
            StatusCode::NOT_FOUND,
            &json!({ "message": "授权记录不存在" }),
        ),
        Err(e) => json_status(
            StatusCode::INTERNAL_SERVER_ERROR,
            &json!({ "message": format!("撤销目录授权失败: {e}") }),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn test_state() -> AppState {
        let meta = Arc::new(crate::meta::MetaStore::new());
        AppState::test_state(meta, None)
    }

    #[test]
    fn normalize_cleans_lexically() {
        assert_eq!(normalize("/Volumes/Backup/"), "/Volumes/Backup");
        assert_eq!(normalize("/Volumes/Backup/./x/../y"), "/Volumes/Backup/y");
        assert_eq!(normalize("/a//b"), "/a/b");
        // 不触碰磁盘:不存在的路径也能规范化
        assert_eq!(normalize("/Volumes/不存在"), "/Volumes/不存在");
    }

    #[test]
    fn is_protected_detects_sensitive_locations() {
        let home = std::env::var("HOME").unwrap_or_default();
        assert!(is_protected("/Volumes/Backup"));
        assert!(is_protected("/Volumes/Backup/proj"));
        assert!(is_protected(&format!("{home}/Documents")));
        assert!(is_protected(&format!("{home}/Desktop")));
        assert!(is_protected(&format!("{home}/Downloads")));
        assert!(is_protected(&format!("{home}/Library/Mobile Documents")));
        assert!(!is_protected(&format!("{home}/code")));
        assert!(!is_protected("/tmp"));
        // 大小写不敏感文件系统(mac/win)上 ~/DOCUMENTS 等同于 ~/Documents
        if cfg!(any(target_os = "macos", target_os = "windows")) {
            assert!(is_protected(&format!("{home}/DOCUMENTS")));
        } else {
            assert!(!is_protected(&format!("{home}/DOCUMENTS")));
        }
    }

    #[test]
    fn covers_matches_self_and_descendants_only() {
        assert!(covers("/Volumes/Backup", "/Volumes/Backup"));
        assert!(covers("/Volumes/Backup/proj", "/Volumes/Backup"));
        assert!(!covers("/Volumes/Backup2", "/Volumes/Backup"));
        assert!(!covers("/Volumes", "/Volumes/Backup"));
    }

    #[tokio::test]
    async fn workspace_create_gated_until_granted() {
        let state = test_state();
        let path = "/Volumes/combo-test-disk/proj";

        // 未授权:创建被 403 拦下,带错误码与规范化路径
        let resp = crate::workspace::create(
            State(state.clone()),
            axum::extract::Json(json!({ "path": path })),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::FORBIDDEN);
        let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        let v: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(v["code"], json!(ERR_CODE));
        assert_eq!(v["path"], json!(path));
        assert!(!state
            .meta
            .list()
            .iter()
            .any(|w| w.path.to_string_lossy() == path));

        // 记住授权(经 POST handler,顺带覆盖规范化)后放行
        grant(
            State(state.clone()),
            axum::extract::Json(json!({ "path": format!("{path}/") })),
        )
        .await;
        // 子目录也被同一授权覆盖
        let resp = crate::workspace::create(
            State(state.clone()),
            axum::extract::Json(json!({ "path": format!("{path}/sub") })),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);

        // 撤销授权后恢复询问
        let grants = state.meta.db().list_dir_grants().unwrap();
        assert_eq!(grants.len(), 1);
        revoke(State(state.clone()), Path(grants[0].id.to_string())).await;
        let resp = crate::workspace::create(
            State(state.clone()),
            axum::extract::Json(json!({ "path": path })),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn non_sensitive_paths_bypass_gate() {
        let state = test_state();
        let dir = std::env::temp_dir().join("combo-dirperm-plain");
        std::fs::create_dir_all(&dir).unwrap();
        let resp = crate::workspace::create(
            State(state.clone()),
            axum::extract::Json(json!({ "path": dir.to_string_lossy() })),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn rename_change_dir_is_gated() {
        let state = test_state();
        let ws_id = "ws_dirperm";
        state.meta.insert(crate::meta::WorkspaceMeta {
            id: ws_id.into(),
            path: std::env::temp_dir(),
            name: "t".into(),
            backend_type: crate::store::BackendType::ComboCli,
        });
        // 更换到敏感目录且未授权 → 403
        let resp = crate::workspace::rename(
            State(state.clone()),
            Path(ws_id.into()),
            axum::extract::Json(json!({ "path": "/Volumes/combo-test-disk" })),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::FORBIDDEN);
        // 授权后更换成功(目录不存在仍会 400,但不再是 403)
        state
            .meta
            .db()
            .upsert_dir_grant("/Volumes/combo-test-disk")
            .unwrap();
        let resp = crate::workspace::rename(
            State(state.clone()),
            Path(ws_id.into()),
            axum::extract::Json(json!({ "path": "/Volumes/combo-test-disk" })),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    }
}
