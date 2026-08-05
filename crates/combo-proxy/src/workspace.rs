//! Workspace CRUD handlers。combo 自己拥有 workspace 元数据。
//! 对于 crush 后端,同时转发给 crush 创建(双写)。

use crate::backend::BackendType;
use crate::AppState;
use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::Response;
use serde_json::{json, Value};
use std::path::Path as FsPath;

/// GET /v1/workspaces — 列出 combo 的所有 workspace。
pub async fn list(State(state): State<AppState>) -> Response {
    let workspaces = state.meta.list();
    let arr: Vec<Value> = workspaces.iter().map(workspace_json).collect();
    json_ok(&json!(arr))
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
    let backend = body
        .get("backend")
        .and_then(|v| v.as_str())
        .map(BackendType::parse)
        .unwrap_or(BackendType::Crush);

    let (ws_id, ws_path) = if backend == BackendType::Crush {
        match state.registry.by_type(BackendType::Crush) {
            Some(crush) => {
                let crush_body = serde_json::to_vec(&json!({
                    "path": path,
                    "client_id": body.get("client_id").cloned().unwrap_or_default()
                }))
                .unwrap_or_default();
                match crush
                    .forward(
                        axum::http::Method::POST,
                        "/v1/workspaces",
                        &Default::default(),
                        crush_body,
                    )
                    .await
                {
                    Ok(resp) if resp.status().is_success() => {
                        // rune 的 workspace 响应含 config(可能很大),不能截断,
                        // 否则解析失败导致 id 为空
                        let bytes = http_body_util::BodyExt::collect(resp.into_body())
                            .await
                            .map(|c| c.to_bytes().to_vec())
                            .unwrap_or_default();
                        let v: Value = serde_json::from_slice(&bytes).unwrap_or_default();
                        let id = v.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                        let p = v.get("path").and_then(|v| v.as_str()).unwrap_or(path).to_string();
                        (id, p)
                    }
                    _ => (format!("ws_{}", uuid_like()), path.to_string()),
                }
            }
            None => (format!("ws_{}", uuid_like()), path.to_string()),
        }
    } else {
        (format!("ws_{}", uuid_like()), path.to_string())
    };

    let name = body
        .get("name")
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|| basename(&ws_path));

    let meta = crate::WorkspaceMeta {
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

/// PATCH /v1/workspaces/{id} — 重命名项目 和/或 更换绑定目录。
///
/// 请求体:`{ name?: string, path?: string }`,至少传一个。
/// - `name`:更新项目显示名。
/// - `path`:更换绑定目录。更新 sqlite 元数据后,立即调 `ensure_ws`
///   用新 path 重新注册到 crush(crush 内存态,重建后 id 可能变化,
///   `ensure_ws` 会自动迁移会话镜像并返回新 id)。
pub async fn rename(
    State(state): State<AppState>,
    Path(id): Path<String>,
    axum::extract::Json(body): axum::extract::Json<Value>,
) -> Response {
    let name = body.get("name").and_then(|v| v.as_str()).map(|s| s.trim());
    let path = body.get("path").and_then(|v| v.as_str()).map(|s| s.trim());

    match (name, path) {
        (Some(n), _) if n.is_empty() && path.is_none() => {
            return json_err(StatusCode::BAD_REQUEST, "name 不能为空");
        }
        (_, Some(p)) if p.is_empty() && name.is_none() => {
            return json_err(StatusCode::BAD_REQUEST, "path 不能为空");
        }
        (None, None) => return json_err(StatusCode::BAD_REQUEST, "需提供 name 或 path"),
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
    } else if state.meta.get(&id).is_none() && path.is_some() {
        return json_err(StatusCode::NOT_FOUND, "workspace 不存在");
    }

    // 再处理 path(若有):更新元数据 + 重新注册到 crush
    if let Some(p) = path.filter(|s| !s.is_empty()) {
        // 先校验目录存在,避免把无效 path 写进 sqlite
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
        // 用新 path 重新注册到 crush。crush 重建 workspace 会返回新 id,
        // ensure_ws 内部会把会话镜像迁移到新 id 并更新 sqlite 中的 id。
        // 这里拿到的 effective_id 可能为 None(crush 不可用):此时仍以
        // sqlite 元数据为准,在 crush 下次启动时由 reconcile_all 补齐。
        let effective_id = crate::workspace::ensure_ws(&state, &id).await;
        if let Some(new_id) = effective_id {
            if new_id != id {
                // id 变了,返回新 id 对应的 workspace
                return match state.meta.get(&new_id) {
                    Some(w) => json_ok(&workspace_json(&w)),
                    None => json_err(StatusCode::NOT_FOUND, "workspace 不存在"),
                };
            }
        }
    }

    match state.meta.get(&id) {
        Some(w) => json_ok(&workspace_json(&w)),
        None => json_err(StatusCode::NOT_FOUND, "workspace 不存在"),
    }
}

/// DELETE /v1/workspaces/{id} — 删除项目。
/// 清理 combo sqlite 元数据 + 会话镜像,并 best-effort 转发 DELETE 给 crush。
pub async fn delete(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    // best-effort:通知 crush 删除其内存中的 workspace(失败不阻断)
    if let Some(crush) = state.registry.by_type(BackendType::Crush) {
        let _ = crush
            .forward(
                axum::http::Method::DELETE,
                &format!("/v1/workspaces/{id}"),
                &Default::default(),
                Vec::new(),
            )
            .await;
    }
    // 级联清理会话镜像 + workspace 元数据
    let _ = state.meta.db().delete_conversations_by_workspace(&id);
    state.meta.remove(&id);
    json_ok(&json!({ "ok": true }))
}

fn workspace_json(w: &crate::WorkspaceMeta) -> Value {
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

fn uuid_like() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{:x}", nanos)
}

/// 代理主动(重新)注册 workspace 用的固定 client_id(UUID 格式,通过 crush 校验)。
const PROXY_CLIENT_ID: &str = "00000000-0000-4000-8000-000000000001";

/// 确保 crush 认识该 workspace。
///
/// crush 的 workspace 是纯内存态:crush 重启(桌面端重新拉起、闲置自毁)后会遗忘
/// 所有 workspace,而 combo 的元数据库仍保留记录,导致转发到 crush 的请求
/// (建会话/事件流/agent 等)全部 404「workspace not found」。
///
/// 这里先 GET 探活,404 则用元数据库里的 path 重新注册;crush 重建后 id 会变化,
/// 此时同步更新元数据库并把旧 id 下的会话镜像迁移到新 id。
/// 返回当前有效的 workspace id(None 表示注册失败)。
pub async fn ensure_ws(state: &AppState, ws_id: &str) -> Option<String> {
    // 先确保 crush 进程在运行(可能在两次后台健康检查之间崩溃了)。
    // ensure_running 在 crush 已健康时仅做一次 GET /v1/health,开销极小;
    // 若 crush 已死则自动拉起并等待就绪(最多 15s)。
    if let Some(sup) = &state.crush_supervisor {
        if let Err(e) = sup.ensure_running().await {
            eprintln!("ensure_ws: crush 进程不可用且重启失败: {e}");
            return None;
        }
    }

    let crush = state.registry.by_type(BackendType::Crush)?;
    // 快速路径:crush 已认识该 workspace
    let check = crush
        .forward(
            axum::http::Method::GET,
            &format!("/v1/workspaces/{ws_id}"),
            &Default::default(),
            Vec::new(),
        )
        .await;
    if let Ok(r) = check {
        if r.status().is_success() {
            return Some(ws_id.to_string());
        }
    }
    // crush 不认识:用元数据库里的 path 重新注册
    let meta = state.meta.get(ws_id)?;
    if meta.backend_type != BackendType::Crush {
        return Some(ws_id.to_string());
    }
    let body = serde_json::to_vec(&json!({
        "path": meta.path,
        "client_id": PROXY_CLIENT_ID,
    }))
    .unwrap_or_default();
    let resp = match crush
        .forward(
            axum::http::Method::POST,
            "/v1/workspaces",
            &Default::default(),
            body,
        )
        .await
    {
        Ok(r) if r.status().is_success() => r,
        Ok(r) => {
            eprintln!(
                "ensure_ws: crush 注册 workspace 失败(HTTP {}),path={}",
                r.status(),
                meta.path.display()
            );
            return None;
        }
        Err(e) => {
            eprintln!("ensure_ws: 转发注册请求到 crush 失败: {e}");
            return None;
        }
    };
    let bytes = match http_body_util::BodyExt::collect(resp.into_body()).await {
        Ok(c) => c.to_bytes().to_vec(),
        Err(_) => return None,
    };
    let v: Value = serde_json::from_slice(&bytes).unwrap_or_default();
    let new_id = v.get("id").and_then(|x| x.as_str()).unwrap_or("").to_string();
    if new_id.is_empty() {
        eprintln!("ensure_ws: crush 注册响应缺少 id 字段,path={}", meta.path.display());
        return None;
    }
    if new_id != ws_id {
        // crush 重建了 workspace,id 变了:更新元数据库 + 迁移会话镜像
        state.meta.remove(ws_id);
        let mut m = meta.clone();
        m.id = new_id.clone();
        state.meta.insert(m);
        let _ = state.meta.db().move_conversations(ws_id, &new_id);
    }
    Some(new_id)
}

/// 启动时把元数据库里所有 crush workspace 与 crush 对齐(重新注册/更新 id),
/// 返回失败的 workspace 数量。crush 不可用(未安装/未启动)时直接返回 0 不报错。
pub async fn reconcile_all(state: &AppState) -> usize {
    let Some(_) = state.registry.by_type(BackendType::Crush) else {
        return 0;
    };
    let ids: Vec<String> = state
        .meta
        .list()
        .into_iter()
        .filter(|m| m.backend_type == BackendType::Crush)
        .map(|m| m.id)
        .collect();
    let mut failed = 0;
    for id in ids {
        if ensure_ws(state, &id).await.is_none() {
            failed += 1;
        }
    }
    failed
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
