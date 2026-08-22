//! Workspace CRUD handlers。combo 自己拥有 workspace 元数据(sqlite)。

use crate::meta::WorkspaceMeta;
use crate::serve::AppState;
use crate::store::BackendType;
use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::Response;
use serde_json::{json, Value};
use std::path::Path as FsPath;

/// GET /v1/workspaces — 列出 combo 的所有 workspace(按 path 去重,按用户排序)。
pub async fn list(State(state): State<AppState>) -> Response {
    // list_workspaces 已按 sort_order(拖动排序;未排过序回退创建时间)升序返回。
    // 同 path 的重复别名行:展示位置取先出现(用户排序靠前)的,
    // 胜出 id 取后出现的(与历史「保留最新创建」语义一致,会话归属不变)。
    let workspaces = state.meta.list();
    let mut seen: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    let mut deduped: Vec<&WorkspaceMeta> = Vec::new();
    for w in &workspaces {
        let key = w.path.to_string_lossy().to_string();
        match seen.get(&key) {
            Some(&i) => deduped[i] = w,
            None => {
                seen.insert(key, deduped.len());
                deduped.push(w);
            }
        }
    }
    let arr: Vec<Value> = deduped.iter().map(|w| workspace_json(w)).collect();
    json_ok(&json!(arr))
}

/// POST /v1/workspaces/reorder — 侧边栏拖动排序落库。
///
/// 请求体:`{ order: [id1, id2, ...] }`,为完整的期望顺序;
/// 未包含的项目保持相对顺序追加在末尾。
pub async fn reorder(
    State(state): State<AppState>,
    axum::extract::Json(body): axum::extract::Json<Value>,
) -> Response {
    let Some(order) = body.get("order").and_then(|v| v.as_array()) else {
        return json_err(StatusCode::BAD_REQUEST, "缺少 order 数组");
    };
    let ids: Vec<String> = order
        .iter()
        .filter_map(|v| v.as_str().map(|s| s.to_string()))
        .collect();
    if ids.len() != order.len() {
        return json_err(StatusCode::BAD_REQUEST, "order 必须是字符串数组");
    }
    if ids.is_empty() {
        return json_err(StatusCode::BAD_REQUEST, "order 不能为空");
    }
    if let Err(e) = state.meta.reorder(&ids) {
        return json_err(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("重排项目失败: {e}"),
        );
    }
    json_ok(&json!({ "ok": true }))
}

/// POST /v1/workspaces — 创建 workspace。`name` 缺省时取目录 basename。
pub async fn create(
    State(state): State<AppState>,
    axum::extract::Json(body): axum::extract::Json<Value>,
) -> Response {
    let path = body.get("path").and_then(|v| v.as_str()).unwrap_or("");
    if path.is_empty() {
        return json_err(StatusCode::BAD_REQUEST, "缺少 path");
    }
    // 敏感目录(桌面/文稿/下载、外置卷等)首次访问前需用户授权一次
    if let Some(resp) = crate::dirperm::check(&state, path) {
        return resp;
    }
    let backend = body
        .get("backend")
        .and_then(|v| v.as_str())
        .map(BackendType::parse)
        .unwrap_or(BackendType::ComboCli);

    let ws_id = format!("ws_{}", uuid_like());
    let ws_path = path.to_string();

    let name = body
        .get("name")
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|| basename(&ws_path));

    let meta = WorkspaceMeta {
        id: ws_id.clone(),
        path: ws_path.clone().into(),
        name,
        backend_type: backend,
    };
    state.meta.insert(meta);

    json_ok(&json!({
        "id": ws_id,
        "path": ws_path,
        "name": state.meta.get(&ws_id).map(|m| m.name).unwrap_or_default(),
        "backend": backend.as_str(),
    }))
}

/// GET /v1/workspaces/{id} — 从 MetaStore 返回。
pub async fn get(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    match state.meta.get(&id) {
        Some(w) => json_ok(&workspace_json(&w)),
        None => json_err(StatusCode::NOT_FOUND, "workspace 不存在"),
    }
}

/// PATCH /v1/workspaces/{id} — 重命名项目、更换绑定目录 和/或 切换后端。
///
/// 请求体:`{ name?: string, path?: string, backend?: string }`,至少传一个。
/// - `name`:更新项目显示名。
/// - `path`:更换绑定目录。更新 sqlite 元数据。
/// - `backend`:切换后端类型(combo-cli/opencode/claude_code/codex)。
pub async fn rename(
    State(state): State<AppState>,
    Path(id): Path<String>,
    axum::extract::Json(body): axum::extract::Json<Value>,
) -> Response {
    let name = body.get("name").and_then(|v| v.as_str()).map(|s| s.trim());
    let path = body.get("path").and_then(|v| v.as_str()).map(|s| s.trim());
    let backend = body.get("backend").and_then(|v| v.as_str()).map(|s| s.trim());

    match (name, path, backend) {
        (Some(n), _, _) if n.is_empty() && path.is_none() && backend.is_none() => {
            return json_err(StatusCode::BAD_REQUEST, "name 不能为空");
        }
        (_, Some(p), _) if p.is_empty() && name.is_none() && backend.is_none() => {
            return json_err(StatusCode::BAD_REQUEST, "path 不能为空");
        }
        (None, None, None) => return json_err(StatusCode::BAD_REQUEST, "需提供 name、path 或 backend"),
        _ => {}
    }

    // 先更新 name(若有)
    if let Some(n) = name.filter(|s| !s.is_empty()) {
        match state.meta.rename(&id, n) {
            Ok(true) => {}
            Ok(false) => return json_err(StatusCode::NOT_FOUND, "workspace 不存在"),
            Err(e) => {
                return json_err(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    &format!("重命名失败: {e}"),
                );
            }
        }
    } else if state.meta.get(&id).is_none() && (path.is_some() || backend.is_some()) {
        return json_err(StatusCode::NOT_FOUND, "workspace 不存在");
    }

    // 切换后端类型(若有)
    if let Some(b) = backend.filter(|s| !s.is_empty()) {
        let bt = BackendType::parse(b);
        if let Err(e) = state.meta.update_backend(&id, bt) {
            return json_err(
                StatusCode::INTERNAL_SERVER_ERROR,
                &format!("切换后端失败: {e}"),
            );
        }
    }

    // 再处理 path(若有):更新元数据
    if let Some(p) = path.filter(|s| !s.is_empty()) {
        // 敏感目录(桌面/文稿/下载、外置卷等)首次访问前需用户授权一次
        if let Some(resp) = crate::dirperm::check(&state, p) {
            return resp;
        }
        if !FsPath::new(p).is_dir() {
            return json_err(
                StatusCode::BAD_REQUEST,
                &format!("目录不存在或不是一个目录: {p}"),
            );
        }
        if let Err(e) = state.meta.update_path(&id, p) {
            return json_err(
                StatusCode::INTERNAL_SERVER_ERROR,
                &format!("更新绑定目录失败: {e}"),
            );
        }
    }

    match state.meta.get(&id) {
        Some(w) => json_ok(&workspace_json(&w)),
        None => json_err(StatusCode::NOT_FOUND, "workspace 不存在"),
    }
}

/// DELETE /v1/workspaces/{id} — 删除项目。
/// 清理 combo sqlite 元数据 + 会话镜像。
/// 同时清理同 path 的别名 ID。
pub async fn delete(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    let target_path = state.meta.get(&id).map(|m| m.path.clone());
    let all = state.meta.list();
    let aliases: Vec<String> = all
        .iter()
        .filter(|w| {
            if w.id == id {
                return true;
            }
            target_path
                .as_ref()
                .map(|p| *p == w.path)
                .unwrap_or(false)
        })
        .map(|w| w.id.clone())
        .collect();

    for alias_id in &aliases {
        let _ = state.meta.db().delete_conversations_by_workspace(alias_id);
        let _ = state.meta.db().delete_messages_by_workspace(alias_id);
        // 级联清理该项目的自动化任务与运行历史
        let _ = state.meta.db().delete_automations_by_workspace(alias_id);
        state.meta.remove(alias_id);
        // 回收该项目的广播 channel,避免随项目增删无限累积。
        state.runs.remove_broadcast(alias_id);
    }
    json_ok(&json!({ "ok": true }))
}

fn workspace_json(w: &WorkspaceMeta) -> Value {
    json!({
        "id": w.id,
        "path": w.path,
        "name": w.name,
        "backend": w.backend_type.as_str(),
    })
}

/// 取路径最后一段作为项目名;根目录/末尾斜杠等情况兜底为路径本身。
fn basename(p: &str) -> String {
    FsPath::new(p)
        .file_name()
        .and_then(|n| n.to_str())
        .filter(|n| !n.is_empty())
        .map(|n| n.to_string())
        .unwrap_or_else(|| p.to_string())
}

fn json_ok(v: &Value) -> Response {
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "application/json")
        .body(Body::from(v.to_string()))
        .unwrap()
}

fn json_err(status: StatusCode, msg: &str) -> Response {
    Response::builder()
        .status(status)
        .header("content-type", "application/json")
        .body(Body::from(json!({ "message": msg }).to_string()))
        .unwrap()
}

pub(crate) fn uuid_like() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{:x}", nanos)
}

/// 启动时把元数据库里遗留的 "crush" 类型 workspace 迁移到 combo-cli。
/// crush 后端已移除,存量数据(旧版本写入的 backend=crush)自动迁移为 ComboCli。
pub fn reconcile_all(meta: &crate::meta::MetaStore) {
    let legacy = meta
        .db()
        .list_workspaces()
        .unwrap_or_default()
        .into_iter()
        .filter(|w| w.backend_type.as_str() == "crush")
        .map(|w| w.id)
        .collect::<Vec<_>>();
    if legacy.is_empty() {
        return;
    }
    for id in &legacy {
        if let Err(e) = meta.update_backend(id, BackendType::ComboCli) {
            eprintln!("reconcile_all: 迁移 workspace {id} 到 combo-cli 失败: {e}");
        }
    }
    eprintln!(
        "COMBO_MIGRATE_INFO={} workspaces migrated from crush to combo-cli",
        legacy.len()
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn basename_extracts_last_segment() {
        assert_eq!(basename("/a/b/project"), "project");
        assert_eq!(basename("project"), "project");
        assert_eq!(basename("/a/b/"), "b");
        assert_eq!(basename("/"), "/");
    }
}
