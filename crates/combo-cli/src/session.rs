//! 会话管理:combo 自己接管 `/v1/workspaces/{id}/sessions` 的
//! 列表/创建/删除,数据持久化在本地 sqlite(conversations 表)。

use crate::serve::AppState;
use crate::store::ConversationMeta;
use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::Response;
use serde_json::{json, Value};

/// GET /v1/workspaces/{id}/sessions — 从 sqlite 读会话列表。
/// 同一 path 可能有多个别名 ID,会话可能挂在任一别名下,
/// 因此按 path 解析全部别名 ID 后合并查询。
pub async fn list(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    let ws_ids = alias_ws_ids(&state, &id);
    match state.meta.db().list_conversations_multi(&ws_ids) {
        Ok(convs) => {
            let arr: Vec<Value> = convs
                .iter()
                .map(|c| session_json(c, state.runs.is_busy(&c.id)))
                .collect();
            json_ok(&json!(arr))
        }
        Err(e) => json_err(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("读取会话列表失败: {e}"),
        ),
    }
}

/// 解析 workspace 的全部别名 ID(同一 path 在后端重启后可能产生多个
/// workspace ID,会话可能挂在任一别名下):按 path 反查所有同路径 ID,
/// 找不到 workspace 时退回传入 ID 本身。
fn alias_ws_ids(state: &AppState, id: &str) -> Vec<String> {
    match state.meta.get(id) {
        Some(meta) => {
            let target_path = meta.path.to_string_lossy().to_string();
            state
                .meta
                .list()
                .into_iter()
                .filter(|w| w.path.to_string_lossy() == target_path)
                .map(|w| w.id)
                .collect()
        }
        None => vec![id.to_string()],
    }
}

/// `/sessions/page` 与 `/sessions/summary` 的查询参数。
#[derive(serde::Deserialize, Default)]
pub struct PageQuery {
    limit: Option<i64>,
    offset: Option<i64>,
}

/// GET /v1/workspaces/{id}/sessions/page?limit=&offset= — 分页会话列表
/// (侧边栏任务分页加载,每页 80)。按 created_at 倒序返回当前页,
/// `total` 为该项目全部会话数,前端据此判断是否还有下一页。
pub async fn list_page(
    State(state): State<AppState>,
    Path(id): Path<String>,
    axum::extract::Query(q): axum::extract::Query<PageQuery>,
) -> Response {
    let Some(limit) = q.limit else {
        return json_err(StatusCode::BAD_REQUEST, "缺少 limit 参数");
    };
    if !(1..=500).contains(&limit) {
        return json_err(StatusCode::BAD_REQUEST, "limit 需在 1..=500 之间");
    }
    let offset = q.offset.unwrap_or(0);
    if offset < 0 {
        return json_err(StatusCode::BAD_REQUEST, "offset 不能为负数");
    }
    let ws_ids = alias_ws_ids(&state, &id);
    match state.meta.db().list_conversations_paged(&ws_ids, limit, offset) {
        Ok((convs, total)) => {
            let arr: Vec<Value> = convs
                .iter()
                .map(|c| session_json(c, state.runs.is_busy(&c.id)))
                .collect();
            json_ok(&json!({
                "sessions": arr,
                "total": total,
                "limit": limit,
                "offset": offset,
            }))
        }
        Err(e) => json_err(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("读取会话列表失败: {e}"),
        ),
    }
}

/// GET /v1/workspaces/{id}/sessions/summary — 项目级会话汇总:
/// token/花费 SUM、busy 会话数与总数。任务列表分页加载后,前端项目
/// 徽章/费用栏不能再遍历全量列表求和,由该端点提供准确口径。
pub async fn summary(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    let ws_ids = alias_ws_ids(&state, &id);
    let busy = ws_ids
        .iter()
        .map(|w| state.runs.workspace_active_runs(w).len())
        .sum::<usize>();
    match state.meta.db().conversation_totals(&ws_ids) {
        Ok((prompt, completion, cost, total)) => json_ok(&json!({
            "prompt_tokens": prompt,
            "completion_tokens": completion,
            "cost": cost,
            "busy_sessions": busy,
            "total_sessions": total,
        })),
        Err(e) => json_err(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("读取会话汇总失败: {e}"),
        ),
    }
}

/// POST /v1/workspaces/{id}/sessions — 本地 sqlite 直接创建会话。
pub async fn create(
    State(state): State<AppState>,
    Path(id): Path<String>,
    axum::extract::Json(body): axum::extract::Json<Value>,
) -> Response {
    // 确保 workspace 存在
    if state.meta.get(&id).is_none() {
        return json_err(StatusCode::NOT_FOUND, "workspace 不存在");
    }

    let title = body
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or("会话")
        .to_string();
    let now = now_secs();
    let conv = ConversationMeta {
        id: crate::workspace::uuid_like(),
        workspace_id: id.clone(),
        title,
        message_count: 0,
        created_at: now,
        updated_at: now,
        prompt_tokens: 0,
        completion_tokens: 0,
        cost: 0.0,
        context_tokens: 0,
        context_window: 0,
        api_calls: 0,
    };
    match state.meta.db().upsert_conversation(&conv) {
        Ok(_) => json_ok(&session_json(&conv, false)),
        Err(e) => json_err(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("创建会话失败: {e}"),
        ),
    }
}

/// DELETE /v1/workspaces/{id}/sessions/{sid} — 删除本地 sqlite 镜像 + 该会话的消息。
pub async fn delete(
    State(state): State<AppState>,
    Path((id, sid)): Path<(String, String)>,
) -> Response {
    let _ = state.meta.db().delete_conversation(&sid);
    let _ = state.meta.db().delete_messages_by_session(&id, &sid);
    // 回收该会话的服务端内存态:任务清单与未被回答的问题条目
    // (否则会随会话增删无限累积)。
    state.todos.clear(&sid);
    state.questions.cancel_pending(&sid);
    json_ok(&json!({ "deleted": true }))
}

/// PATCH /v1/workspaces/{id}/sessions/{sid} — 重命名会话标题(仅更新 sqlite)。
pub async fn rename(
    State(state): State<AppState>,
    Path((id, sid)): Path<(String, String)>,
    axum::extract::Json(body): axum::extract::Json<Value>,
) -> Response {
    let title = body.get("title").and_then(|v| v.as_str()).map(|s| s.trim());
    let Some(title) = title.filter(|s| !s.is_empty()) else {
        return json_err(StatusCode::BAD_REQUEST, "title 不能为空");
    };
    match state.meta.db().rename_conversation(&sid, title) {
        Ok(()) => match state.meta.db().list_conversations(&id) {
            Ok(convs) => {
                if let Some(c) = convs.iter().find(|c| c.id == sid) {
                    json_ok(&session_json(c, state.runs.is_busy(&sid)))
                } else {
                    json_err(StatusCode::NOT_FOUND, "会话不存在")
                }
            }
            Err(e) => json_err(
                StatusCode::INTERNAL_SERVER_ERROR,
                &format!("读取会话失败: {e}"),
            ),
        },
        Err(e) => json_err(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("重命名会话失败: {e}"),
        ),
    }
}

fn session_json(c: &ConversationMeta, is_busy: bool) -> Value {
    json!({
        "id": c.id,
        "title": c.title,
        "message_count": c.message_count,
        "prompt_tokens": c.prompt_tokens,
        "completion_tokens": c.completion_tokens,
        "cost": c.cost,
        "context_tokens": c.context_tokens,
        "context_window": c.context_window,
        "api_calls": c.api_calls,
        "created_at": c.created_at,
        "updated_at": c.updated_at,
        "is_busy": is_busy,
    })
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// GET /v1/workspaces/{id}/sessions/{sid}/history — 从 sqlite 读消息历史。
pub async fn history(
    State(state): State<AppState>,
    Path((id, sid)): Path<(String, String)>,
) -> Response {
    match state.meta.db().list_messages(&id, &sid) {
        Ok(msgs) => {
            let arr: Vec<Value> = msgs
                .iter()
                .map(|m| {
                    let parts: Value =
                        serde_json::from_str(&m.parts).unwrap_or(Value::Array(vec![]));
                    json!({
                        "id": m.id,
                        "session_id": sid,
                        "role": m.role,
                        "parts": parts,
                        "model": "",
                        "provider": "",
                        "created_at": m.created_at,
                        "updated_at": m.updated_at,
                    })
                })
                .collect();
            json_ok(&json!(arr))
        }
        Err(e) => json_err(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("读取消息历史失败: {e}"),
        ),
    }
}

/// POST /v1/workspaces/{id}/sessions/{sid}/messages — 写入/更新单条消息到 sqlite。
/// 前端在收到 SSE message 事件后 fire-and-forget 调用此端点做持久化。
pub async fn upsert_msg(
    State(state): State<AppState>,
    Path((id, sid)): Path<(String, String)>,
    axum::extract::Json(msg): axum::extract::Json<Value>,
) -> Response {
    let mid = msg.get("id").and_then(|x| x.as_str()).unwrap_or_default().to_string();
    if mid.is_empty() {
        return json_err(StatusCode::BAD_REQUEST, "消息缺少 id");
    }
    let role = msg
        .get("role")
        .and_then(|x| x.as_str())
        .unwrap_or("assistant")
        .to_string();
    let parts = msg.get("parts").unwrap_or(&Value::Array(vec![])).to_string();
    let created_at = msg.get("created_at").and_then(|x| x.as_i64()).unwrap_or_else(now_secs);
    let updated_at = msg.get("updated_at").and_then(|x| x.as_i64()).unwrap_or_else(now_secs);

    match state
        .meta
        .db()
        .upsert_message(&id, &sid, &mid, &role, &parts, created_at, updated_at)
    {
        Ok(_) => json_ok(&json!({ "ok": true })),
        Err(e) => json_err(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("保存消息失败: {e}"),
        ),
    }
}

/// POST /v1/workspaces/{id}/sessions/{sid}/clear — 清空会话消息(Composer `/clear` 命令)。
/// 删除 sqlite 里的全部消息并重置上下文相关计数(context_tokens/api_calls),
/// 会话本身保留(标题与 token 账目不变)。run 进行中返回 409:历史会在
/// run 收尾时被服务端写回,清空无意义。清理成功后广播 session updated
/// 事件(payload 带 `cleared: true`),其他端据此清内存消息并刷新列表。
pub async fn clear(
    State(state): State<AppState>,
    Path((id, sid)): Path<(String, String)>,
) -> Response {
    if state.runs.is_busy(&sid) {
        return json_err(
            StatusCode::CONFLICT,
            "该会话有正在进行的任务,请先停止再清空",
        );
    }
    if let Err(e) = state.meta.db().delete_messages_by_session(&id, &sid) {
        return json_err(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("清空会话失败: {e}"),
        );
    }
    let _ = state.meta.db().reset_session_usage(&sid);
    // 回收服务端内存态:任务清单与未答问题(同删除会话的做法)
    state.todos.clear(&sid);
    state.questions.cancel_pending(&sid);
    let tx = state.runs.broadcast(&id);
    let _ = tx.send(json!({
        "type": "session",
        "payload": {
            "type": "updated",
            "payload": { "id": sid, "cleared": true, "message_count": 0, "api_calls": 0, "is_busy": false }
        }
    }));
    json_ok(&json!({ "cleared": true }))
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn session_test_state() -> AppState {
        let meta = Arc::new(crate::meta::MetaStore::new());
        meta.insert(crate::meta::WorkspaceMeta {
            id: "ws_s".into(),
            path: std::env::temp_dir(),
            name: "t".into(),
            backend_type: crate::store::BackendType::ComboCli,
        });
        AppState::test_state(meta, None)
    }

    fn seed_conv(state: &AppState) {
        state
            .meta
            .db()
            .upsert_conversation(&crate::store::ConversationMeta {
                id: "s1".into(),
                workspace_id: "ws_s".into(),
                title: "t".into(),
                message_count: 0,
                created_at: 1,
                updated_at: 2,
                prompt_tokens: 3_000,
                completion_tokens: 800,
                cost: 0.42,
                context_tokens: 9_000,
                context_window: 128_000,
                api_calls: 12,
            })
            .unwrap();
    }

    async fn body_json(resp: Response) -> Value {
        let bytes = axum::body::to_bytes(resp.into_body(), 64 * 1024)
            .await
            .unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    #[tokio::test]
    async fn clear_removes_messages_and_resets_usage() {
        let state = session_test_state();
        seed_conv(&state);
        let db = state.meta.db();
        db.upsert_message("ws_s", "s1", "m1", "user", r#"[{"type":"text"}]"#, 1, 1)
            .unwrap();
        db.upsert_message("ws_s", "s1", "m2", "assistant", r#"[]"#, 2, 2)
            .unwrap();

        let resp = clear(
            State(state.clone()),
            Path(("ws_s".to_string(), "s1".to_string())),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(body_json(resp).await["cleared"], json!(true));

        // 消息清空;上下文相关计数归零;会话本身与 token 账目保留
        assert_eq!(db.list_messages("ws_s", "s1").unwrap().len(), 0);
        let convs = db.list_conversations("ws_s").unwrap();
        assert_eq!(convs.len(), 1);
        assert_eq!(convs[0].context_tokens, 0);
        assert_eq!(convs[0].api_calls, 0);
        assert_eq!(convs[0].prompt_tokens, 3_000);
        assert_eq!(convs[0].completion_tokens, 800);
    }

    #[tokio::test]
    async fn clear_rejects_busy_session() {
        let state = session_test_state();
        seed_conv(&state);
        let db = state.meta.db();
        db.upsert_message("ws_s", "s1", "m1", "user", r#"[{"type":"text"}]"#, 1, 1)
            .unwrap();
        // 预置一个进行中的 run(同 serve.rs 并发测试的做法)
        assert!(state.runs.start_run("ws_s", "s1", "run-1").is_some());

        let resp = clear(
            State(state.clone()),
            Path(("ws_s".to_string(), "s1".to_string())),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::CONFLICT);
        // 消息未被删除
        assert_eq!(db.list_messages("ws_s", "s1").unwrap().len(), 1);
    }

    #[tokio::test]
    async fn list_page_paginates_by_created_at_desc() {
        let state = session_test_state();
        let db = state.meta.db();
        for i in 0..3 {
            let mut c = crate::store::ConversationMeta {
                id: format!("s{i}"),
                workspace_id: "ws_s".into(),
                title: format!("任务{i}"),
                message_count: 0,
                created_at: 100 + i,
                updated_at: 100 + i,
                prompt_tokens: 0,
                completion_tokens: 0,
                cost: 0.0,
                context_tokens: 0,
                context_window: 0,
                api_calls: 0,
            };
            c.created_at = 100 + i;
            db.upsert_conversation(&c).unwrap();
        }

        let page = |limit: i64, offset: i64| {
            list_page(
                State(state.clone()),
                Path("ws_s".to_string()),
                axum::extract::Query(PageQuery {
                    limit: Some(limit),
                    offset: Some(offset),
                }),
            )
        };

        // 第一页:最新两条 + total=3
        let v = body_json(page(2, 0).await).await;
        assert_eq!(v["total"], json!(3));
        assert_eq!(
            v["sessions"]
                .as_array()
                .unwrap()
                .iter()
                .map(|s| s["id"].as_str().unwrap())
                .collect::<Vec<_>>(),
            ["s2", "s1"]
        );
        // 第二页:最旧一条
        let v = body_json(page(2, 2).await).await;
        assert_eq!(
            v["sessions"]
                .as_array()
                .unwrap()
                .iter()
                .map(|s| s["id"].as_str().unwrap())
                .collect::<Vec<_>>(),
            ["s0"]
        );
        // 缺 limit → 400;越界 limit → 400
        let resp = list_page(
            State(state.clone()),
            Path("ws_s".to_string()),
            axum::extract::Query(PageQuery::default()),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
        let resp = list_page(
            State(state.clone()),
            Path("ws_s".to_string()),
            axum::extract::Query(PageQuery {
                limit: Some(0),
                offset: None,
            }),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn summary_reports_totals_and_busy() {
        let state = session_test_state();
        seed_conv(&state); // prompt 3000 / completion 800 / cost 0.42
        let mut other = crate::store::ConversationMeta {
            id: "s2".into(),
            workspace_id: "ws_s".into(),
            title: "t".into(),
            message_count: 0,
            created_at: 2,
            updated_at: 2,
            prompt_tokens: 1_000,
            completion_tokens: 200,
            cost: 0.08,
            context_tokens: 0,
            context_window: 0,
            api_calls: 0,
        };
        other.created_at = 2;
        state.meta.db().upsert_conversation(&other).unwrap();
        // s1 正在运行 → busy_sessions=1
        assert!(state.runs.start_run("ws_s", "s1", "run-1").is_some());

        let v = body_json(
            summary(State(state.clone()), Path("ws_s".to_string())).await,
        )
        .await;
        assert_eq!(v["prompt_tokens"], json!(4_000));
        assert_eq!(v["completion_tokens"], json!(1_000));
        assert_eq!(v["cost"], json!(0.5));
        assert_eq!(v["busy_sessions"], json!(1));
        assert_eq!(v["total_sessions"], json!(2));

        // run 结束后 busy 归零
        state.runs.finish_run("s1", "run-1");
        let v = body_json(summary(State(state), Path("ws_s".to_string())).await).await;
        assert_eq!(v["busy_sessions"], json!(0));
    }
}
