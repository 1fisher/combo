//! serve 服务模式:进程守护式管理 + rune 兼容协议 + combo 自有 REST 端点。
//!
//! combo-cli 现在直接充当 combo 的完整后端(不再经 combo-proxy 反向代理):
//! - `GET /v1/health`                       → 健康检查(`{"ok":true}`)
//! - `POST /v1/control`                     → 优雅关闭(信号驱动)
//! - `POST /v1/agent`                       → 单轮问答(旧接口)
//! - `POST /v1/workspaces/{id}/agent`       → 发起一次 agent 运行
//! - `POST /v1/workspaces/{id}/agent/sessions/{sid}/cancel` → 取消运行
//! - `GET  /v1/workspaces/{id}/events`      → SSE 事件流(与 rune 双层信封一致)
//! - 其余 REST(workspaces/sessions/files/git/auth/host/skills/relay/terminal)
//!   由本地 sqlite(`MetaStore`)直接提供服务,不再转发。
//!
//! 会话/历史落在本地 sqlite(combo.db),`/agent` 请求处理时自行从
//! `MetaStore` 读取历史并还原成 rig 消息,支撑多轮上下文;运行过程中的
//! 消息事件经 broadcast 广播。

use crate::agent::{self, AskConfig, RunEvent};
use crate::auth;
use crate::config::AppConfig;
use crate::fs;
use crate::git;
use crate::host;
use crate::meta::MetaStore;
use crate::providers::{self, ProviderInfo};
use crate::relay::{self, RelayManager};
use crate::session;
use crate::skills_api;
use crate::terminal;
use crate::workspace;
use anyhow::Result;
use axum::{
    Json, Router,
    extract::{Path, State},
    http::{HeaderValue, StatusCode, header},
    middleware::from_fn_with_state,
    response::Response,
    routing::{delete, get, post},
};
use futures::stream::unfold;
use rig::completion::message::{ToolCall, ToolFunction};
use rig::completion::{AssistantContent, Message};
use rig::OneOrMany;
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::convert::Infallible;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::{Notify, broadcast, watch};
use tower_http::cors::{Any, CorsLayer};

/// 所有 axum handler 共享的应用状态。
#[derive(Clone)]
pub struct AppState {
    pub cfg: Arc<Mutex<AskConfig>>,
    pub shutdown: Arc<Notify>,
    pub runs: Arc<RunState>,
    /// workspace/session/message 的 sqlite 镜像(combo 自有数据源)。
    pub meta: Arc<MetaStore>,
    /// 服务器目录浏览的根限制(`/v1/host/*`);None 表示允许浏览整个文件系统。
    pub browse_root: Option<PathBuf>,
    /// 隧道管理器(控制桌面端到中转服务器的反向隧道)。
    pub relay: Arc<RelayManager>,
    /// 本地监听端口(隧道转发目标)。
    pub local_port: u16,
}

impl AppState {
    /// 用本地 sqlite 构建完整状态(供 `serve_listener` 内嵌调用)。
    pub fn new(cfg: AskConfig) -> anyhow::Result<Self> {
        let meta = Arc::new(MetaStore::open_default()?);
        // 存量 crush 数据迁移为 combo-cli
        workspace::reconcile_all(&meta);
        Ok(Self {
            cfg: Arc::new(Mutex::new(cfg)),
            shutdown: Arc::new(Notify::new()),
            runs: Arc::new(RunState::default()),
            meta,
            browse_root: std::env::var("COMBO_BROWSE_ROOT")
                .ok()
                .map(PathBuf::from),
            relay: RelayManager::new(),
            local_port: 0,
        })
    }

    /// 测试用最小状态(仅 meta/browse_root/relay,其余取默认)。
    #[cfg(test)]
    pub(crate) fn test_state(meta: Arc<MetaStore>, browse_root: Option<PathBuf>) -> Self {
        let provider = crate::providers::ProviderInfo {
            id: "test".into(),
            name: None,
            api_key: None,
            api_endpoint: None,
            provider_type: None,
            default_large_model_id: None,
            default_small_model_id: None,
            models: Vec::new(),
        };
        let cfg = AskConfig {
            provider,
            model: "test-model".into(),
            preamble: String::new(),
            base_preamble: String::new(),
            skills_paths: Vec::new(),
            disabled_skills: Vec::new(),
            tools: false,
            mcp_command: None,
            mcp_url: None,
            explicit_api_key: None,
            explicit_base_url: None,
            mcp_servers: Vec::new(),
        };
        Self {
            cfg: Arc::new(Mutex::new(cfg)),
            shutdown: Arc::new(Notify::new()),
            runs: Arc::new(RunState::default()),
            meta,
            browse_root,
            relay: RelayManager::new(),
            local_port: 0,
        }
    }
}

/// 运行态:按 workspace 广播事件,按 session 取消运行。
#[derive(Default)]
pub struct RunState {
    broadcasts: Mutex<HashMap<String, broadcast::Sender<Value>>>,
    cancels: Mutex<HashMap<String, watch::Sender<bool>>>,
}

impl RunState {
    fn broadcast(&self, ws_id: &str) -> broadcast::Sender<Value> {
        let mut m = self.broadcasts.lock().unwrap();
        m.entry(ws_id.to_string())
            .or_insert_with(|| broadcast::channel(1024).0)
            .clone()
    }

    fn cancel_tx(&self, session_id: &str) -> watch::Sender<bool> {
        let mut m = self.cancels.lock().unwrap();
        m.entry(session_id.to_string())
            .or_insert_with(|| watch::channel(false).0)
            .clone()
    }

    fn cancel(&self, session_id: &str) {
        if let Some(tx) = self.cancels.lock().unwrap().get(session_id) {
            let _ = tx.send(true);
        }
    }
}

/// POST /v1/workspaces/{id}/agent 请求体。
#[derive(Deserialize)]
struct AgentReq {
    session_id: String,
    run_id: Option<String>,
    prompt: String,
    /// proxy 注入的历史消息:[{ role, parts }](可选)。
    history: Option<Vec<Value>>,
    /// workspace 根目录(旧 proxy 注入字段,保留兜底),供 read/write/search 工具使用。
    workspace_dir: Option<String>,
}

pub async fn run(cfg: &agent::AskConfig, host: String, port: u16) -> Result<()> {
    let mut state = AppState::new(cfg.clone())?;
    let listener = tokio::net::TcpListener::bind(format!("{host}:{port}")).await?;
    let actual = listener.local_addr()?;
    state.local_port = actual.port();
    // 机器可读端口输出(供外部脚本解析)
    println!("COMBO_CLI_PORT={}", actual.port());
    println!("combo-cli serve 已启动:http://{actual}");
    serve_listener(listener, state, Vec::new()).await
}

/// 在指定 listener 上提供服务(可内嵌调用,如 Tauri 直接托管)。
/// 优雅关闭:调用方对 `state.shutdown.notify_one()` 后服务退出。
pub async fn serve_listener(
    listener: tokio::net::TcpListener,
    state: AppState,
    allowed_origins: Vec<String>,
) -> Result<()> {
    let app = build_router(state.clone(), allowed_origins);
    // 注入 ConnectInfo<SocketAddr> 供鉴权中间件判断请求来源是否回环。
    let shutdown_handle = state.shutdown.clone();
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .with_graceful_shutdown(async move {
        shutdown_handle.notified().await;
        tracing::info!("收到关闭信号,退出服务");
    })
    .await?;
    Ok(())
}

/// 构建 serve router(combo 全部 REST/WS 端点 + CORS + 令牌鉴权)。
fn build_router(state: AppState, allowed_origins: Vec<String>) -> Router {
    let cors = if allowed_origins.is_empty() {
        CorsLayer::permissive()
    } else {
        let origins: Vec<HeaderValue> = allowed_origins
            .iter()
            .map(|o| {
                o.parse()
                    .expect("allowed_origins must contain valid origin values")
            })
            .collect();
        CorsLayer::new()
            .allow_origin(origins)
            .allow_methods(Any)
            .allow_headers(Any)
    };
    Router::new()
        // ---- dispose:健康检查 / 优雅关闭 ----
        .route("/v1/health", get(health))
        .route("/v1/control", post(control))
        // ---- 旧单轮接口 ----
        .route("/v1/agent", post(run_agent))
        // ---- agent 运行 / SSE / 模型 ----
        .route(
            "/v1/workspaces/:id/agent",
            get(agent_info).post(run_agent_ws),
        )
        .route(
            "/v1/workspaces/:id/agent/sessions/:sid/cancel",
            post(cancel_agent),
        )
        .route(
            "/v1/workspaces/:id/current-session",
            post(current_session),
        )
        .route(
            "/v1/workspaces/:id/permissions/skip",
            get(permission_skip_get).post(permission_skip_post),
        )
        .route(
            "/v1/workspaces/:id/permissions/grant",
            post(permission_grant),
        )
        .route(
            "/v1/workspaces/:id/questions/answer",
            post(question_answer),
        )
        .route("/v1/workspaces/:id/events", get(events))
        .route("/v1/workspaces/:id/providers", get(list_providers))
        .route(
            "/v1/workspaces/:id/providers/fetch-models",
            post(fetch_models),
        )
        .route("/v1/workspaces/:id/providers/save-key", post(save_provider_key))
        .route("/v1/providers", get(list_providers))
        .route("/v1/providers/fetch-models", post(fetch_models))
        .route("/v1/providers/save-key", post(save_provider_key))
        .route("/v1/workspaces/:id/config/model", post(config_model))
        .route(
            "/v1/workspaces/:id/config",
            get(workspace_config_get),
        )
        .route(
            "/v1/workspaces/:id/config/set",
            post(workspace_config_set),
        )
        // ---- 认证(移动端远程访问令牌) ----
        .route(
            "/v1/auth/token",
            post(auth::create_token).get(auth::list_tokens),
        )
        .route("/v1/auth/verify", get(auth::verify_token))
        .route("/v1/auth/token/revoke", delete(auth::revoke_token))
        // ---- skills / 终端 / 隧道 ----
        .route("/v1/skills", get(skills_api::list))
        .route("/v1/terminal", get(terminal::terminal_default))
        .route("/v1/workspaces/:id/terminal", get(terminal::terminal))
        .route("/v1/relay/start", post(relay::start_relay))
        .route("/v1/relay/stop", post(relay::stop_relay))
        .route("/v1/relay/status", get(relay::relay_status))
        // ---- 服务器目录浏览 ----
        .route("/v1/host/home", get(host::home))
        .route("/v1/host/dirs", get(host::dirs))
        // ---- workspaces / sessions / 文件 / git ----
        .route(
            "/v1/workspaces",
            get(workspace::list).post(workspace::create),
        )
        .route(
            "/v1/workspaces/:id",
            get(workspace::get)
                .patch(workspace::rename)
                .delete(workspace::delete),
        )
        .route(
            "/v1/workspaces/:id/sessions",
            get(session::list).post(session::create),
        )
        .route(
            "/v1/workspaces/:id/sessions/:sid",
            delete(session::delete).patch(session::rename),
        )
        .route(
            "/v1/workspaces/:id/sessions/:sid/history",
            get(session::history),
        )
        .route(
            "/v1/workspaces/:id/sessions/:sid/messages",
            post(session::upsert_msg),
        )
        .route("/v1/workspaces/:id/files/list", get(fs::list))
        .route(
            "/v1/workspaces/:id/files/content",
            get(fs::read).put(fs::write),
        )
        .route("/v1/workspaces/:id/files/raw", get(fs::raw))
        .route("/v1/workspaces/:id/git/status", get(git::status))
        .route("/v1/workspaces/:id/git/repos", get(git::repos))
        .route("/v1/workspaces/:id/git/diff", get(git::diff))
        .route("/v1/workspaces/:id/git/diff/staged", get(git::diff_staged))
        .route("/v1/workspaces/:id/git/diff/head", get(git::diff_head))
        .route("/v1/workspaces/:id/git/file", get(git::file_at_head))
        .route("/v1/workspaces/:id/git/log", get(git::git_log))
        .route("/v1/workspaces/:id/git/stage", post(git::stage))
        .route("/v1/workspaces/:id/git/unstage", post(git::unstage))
        .route("/v1/workspaces/:id/git/discard", post(git::discard))
        .route("/v1/workspaces/:id/git/commit", post(git::commit))
        .route("/v1/workspaces/:id/git/push", post(git::push))
        .route("/v1/workspaces/:id/git/pull", post(git::pull))
        .route("/v1/workspaces/:id/git/fetch", post(git::fetch))
        .route("/v1/workspaces/:id/git/branch-info", get(git::branch_info))
        .route("/v1/workspaces/:id/git/commit/files", get(git::commit_files))
        .route("/v1/workspaces/:id/git/commit/diff", get(git::commit_diff))
        .layer(from_fn_with_state(state.clone(), auth::require_token))
        .with_state(state)
        .layer(cors)
}

/// GET /v1/workspaces/{id}/config — rune 兼容的配置读取。
/// disabled_skills 从本地 sqlite 读取(技能开关持久化)。
async fn workspace_config_get(
    State(state): State<AppState>,
    Path(ws_id): Path<String>,
) -> Json<Value> {
    let disabled = state.meta.db().get_disabled_skills(&ws_id).unwrap_or_default();
    Json(json!({
        "options": {
            "disabled_skills": disabled,
            "skills_paths": [],
        },
        "models": {},
        "recent_models": {},
    }))
}

/// POST /v1/workspaces/{id}/config/set — 配置写入。
/// `disabled_skills`(技能开关)落库 sqlite,其余 key 保持 stub 回显。
async fn workspace_config_set(
    State(state): State<AppState>,
    Path(ws_id): Path<String>,
    Json(body): Json<Value>,
) -> Json<Value> {
    if body.get("key").and_then(Value::as_str) == Some("disabled_skills") {
        let skills: Vec<String> = body
            .get("value")
            .and_then(Value::as_array)
            .map(|arr| arr.iter().filter_map(Value::as_str).map(String::from).collect())
            .unwrap_or_default();
        if let Err(e) = state.meta.db().set_disabled_skills(&ws_id, &skills) {
            tracing::warn!("保存 disabled_skills 失败: {e}");
        }
    }
    Json(json!({ "ok": true, "key": body.get("key"), "value": body.get("value") }))
}

/// POST /v1/workspaces/{id}/permissions/grant — rune 兼容 stub。
/// combo-cli 工具调用自动执行、无权限拦截。
async fn permission_grant() -> Json<Value> {
    Json(json!({ "ok": true }))
}

/// POST /v1/workspaces/{id}/questions/answer — rune 兼容 stub。
/// combo-cli 无人工确认流程,恒返回成功。
async fn question_answer() -> Json<Value> {
    Json(json!({ "ok": true }))
}

async fn health() -> Json<Value> {
    Json(json!({ "ok": true, "service": "combo-cli" }))
}

async fn control(State(state): State<AppState>) -> Json<Value> {
    state.shutdown.notify_one();
    Json(json!({ "ok": true, "message": "shutting down" }))
}

/// 旧单轮问答接口(兼容)。
async fn run_agent(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let question = body
        .get("question")
        .and_then(Value::as_str)
        .ok_or_else(|| (StatusCode::BAD_REQUEST, "缺少 question 字段".into()))?
        .to_string();

    let cfg = state.cfg.lock().unwrap().clone();
    let run_id = format!("legacy-{}", uuid::Uuid::new_v4());
    crate::request_log::log_request(
        "legacy",
        "legacy",
        &run_id,
        &question,
        &cfg.provider.id,
        &cfg.model,
        0,
    );
    let answer = crate::agent::ask_answer(&cfg, &question, std::env::current_dir().ok())
        .await
        .map_err(|e| {
            let msg = friendly_error(&e);
            crate::request_log::log_response(
                &run_id,
                "legacy",
                "error",
                "",
                Some(&msg),
                None,
                &[],
            );
            (StatusCode::INTERNAL_SERVER_ERROR, msg)
        })?;

    crate::request_log::log_response(
        &run_id,
        "legacy",
        "end_turn",
        &answer,
        None,
        None,
        &[],
    );
    Ok(Json(json!({ "ok": true, "answer": answer })))
}

/// POST /v1/workspaces/{id}/agent — 发起一次 agent 运行。
///
/// 立即回传用户消息事件(前端据此清除乐观插入),随后在后台任务中
/// 流式运行,事件经 workspace 的 broadcast 广播给 SSE 订阅者。
async fn run_agent_ws(
    State(state): State<AppState>,
    Path(ws_id): Path<String>,
    Json(body): Json<AgentReq>,
) -> Result<Json<Value>, (StatusCode, String)> {
    if body.session_id.is_empty() || body.prompt.is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            "session_id 与 prompt 不能为空".into(),
        ));
    }
    let run_id = body.run_id.clone().unwrap_or_else(|| body.session_id.clone());
    let run_id_for_task = run_id.clone();
    let tx = state.runs.broadcast(&ws_id);
    let cancel_rx = state.runs.cancel_tx(&body.session_id).subscribe();

    // 1. 回传用户消息(created),前端据此移除乐观插入的 local- 消息
    //    同时按该 workspace 的禁用技能重建 preamble(技能开关生效)。
    let cfg = {
        let base = state.cfg.lock().unwrap().clone();
        let ws_disabled = state.meta.db().get_disabled_skills(&ws_id).unwrap_or_default();
        base.with_disabled_skills(&ws_disabled)
    };
    let user_msg = user_message_json(&body.session_id, &body.prompt, &cfg);
    let _ = tx.send(msg_env("created", user_msg));

    // 2. 会话历史与 workspace 根目录从本地 sqlite 解析(多轮上下文)。
    //    body 里旧客户端注入的 history/workspace_dir 仅在 sqlite 无数据时兜底。
    let history: Vec<Value> = match &body.history {
        Some(h) if !h.is_empty() => h.clone(),
        _ => state
            .meta
            .db()
            .list_messages(&ws_id, &body.session_id)
            .unwrap_or_default()
            .iter()
            .map(|m| {
                let parts: Value =
                    serde_json::from_str(&m.parts).unwrap_or(Value::Array(vec![]));
                json!({ "role": m.role, "parts": parts })
            })
            .collect(),
    };
    let workspace_dir = state
        .meta
        .get(&ws_id)
        .map(|m| m.path)
        .or_else(|| body.workspace_dir.as_deref().map(std::path::PathBuf::from));

    // 3. 记录请求日志(发送给 agent 的内容)
    let provider_id = cfg.provider.id.clone();
    let model_name = cfg.model.clone();
    crate::request_log::log_request(
        &ws_id,
        &body.session_id,
        &run_id,
        &body.prompt,
        &provider_id,
        &model_name,
        history.len(),
    );

    // 4. 后台运行 agent,事件经广播流出
    let state2 = state.clone();
    tokio::spawn(async move {
        let session_id = body.session_id.clone();
        let prompt = body.prompt.clone();
        let run_id2 = run_id_for_task.clone();
        let assistant_id = uuid::Uuid::new_v4().to_string();
        let created_at = now_secs();

        // 初始空 assistant 消息(created)
        let _ = tx.send(msg_env(
            "created",
            assistant_message_json(&session_id, &assistant_id, &cfg, Vec::new(), created_at),
        ));

        let rig_history = history_to_messages(&history);
        let mut sparts = StreamParts::default();
        let mut usage: Option<(u64, u64)> = None;
        let tx_ev = tx.clone();
        // 收集工具调用摘要供响应日志使用
        let mut tool_call_summaries: Vec<crate::request_log::ToolCallSummary> = Vec::new();
        let result =
            crate::agent::stream_run(&cfg, &prompt, &rig_history, workspace_dir, cancel_rx, |ev| {
            match ev {
                RunEvent::TextDelta(t) => {
                    crate::request_log::log_event(
                        &run_id_for_task,
                        &session_id,
                        "text_delta",
                        json!({ "delta": &t }),
                    );
                    sparts.text_delta(&t);
                }
                RunEvent::ToolCall { id, name, input } => {
                    crate::request_log::log_event(
                        &run_id_for_task,
                        &session_id,
                        "tool_call",
                        json!({ "id": &id, "name": &name, "input": &input }),
                    );
                    tool_call_summaries.push(crate::request_log::ToolCallSummary {
                        name: name.clone(),
                        input: input.clone(),
                    });
                    sparts.tool_call(&id, &name, &input);
                }
                RunEvent::ToolResult { id, name, content } => {
                    crate::request_log::log_event(
                        &run_id_for_task,
                        &session_id,
                        "tool_result",
                        json!({ "id": &id, "name": &name, "content_preview": content.chars().take(2000).collect::<String>() }),
                    );
                    let msg = tool_result_message_json(&session_id, &id, &name, &content);
                    let _ = tx_ev.send(msg_env("created", msg));
                }
                RunEvent::Usage { input, output } => usage = Some((input, output)),
            }
            let _ = tx_ev.send(msg_env(
                "updated",
                assistant_message_json(
                    &session_id,
                    &assistant_id,
                    &cfg,
                    sparts.parts.clone(),
                    created_at,
                ),
            ));
        })
        .await;

        let (reason, error, text) = match &result {
            Ok(Some(t)) => ("end_turn", None, t.clone()),
            Ok(None) => ("cancelled", None, String::new()),
            Err(e) => {
                let msg = friendly_error(e);
                ("error", Some(msg.clone()), msg)
            }
        };
        sparts.finish(reason, now_secs(), usage);
        let _ = tx.send(msg_env(
            "updated",
            assistant_message_json(
                &session_id,
                &assistant_id,
                &cfg,
                sparts.into_parts(),
                created_at,
            ),
        ));
        let _ = tx.send(run_complete_env(
            &session_id,
            &run_id2,
            &assistant_id,
            &text,
            error.as_deref(),
            usage,
        ));

        // 记录响应日志(agent 返回的内容)
        crate::request_log::log_response(
            &run_id2,
            &session_id,
            reason,
            &text,
            error.as_deref(),
            usage,
            &tool_call_summaries,
        );

        // 累加 token 用量与花费到会话
        if let Some((input, output)) = usage {
            let (pin, pout) =
                crate::providers::get_model_pricing(&cfg.provider, &cfg.model);
            let cost =
                (input as f64 / 1_000_000.0) * pin + (output as f64 / 1_000_000.0) * pout;
            let _ = state2.meta.db().add_usage(&session_id, input as i64, output as i64, cost);
        }
    });

    Ok(Json(json!({ "ok": true, "run_id": run_id })))
}

/// POST /v1/workspaces/{id}/agent/sessions/{sid}/cancel — 取消运行。
async fn cancel_agent(
    State(state): State<AppState>,
    Path((_ws_id, sid)): Path<(String, String)>,
) -> Json<Value> {
    state.runs.cancel(&sid);
    Json(json!({ "ok": true, "cancelled": true }))
}

/// POST /v1/workspaces/{id}/current-session — rune 兼容 stub。
/// combo 的当前会话由前端 Zustand 管理,serve 侧无需记录。
async fn current_session() -> Json<Value> {
    Json(json!({ "ok": true }))
}

/// GET /v1/workspaces/{id}/permissions/skip — rune 兼容 stub。
/// combo-cli 工具调用自动执行、无权限拦截,恒返回未跳过。
async fn permission_skip_get() -> Json<Value> {
    Json(json!({ "skip": false }))
}

/// POST /v1/workspaces/{id}/permissions/skip — rune 兼容 stub,接受并回显。
async fn permission_skip_post(Json(body): Json<Value>) -> Json<Value> {
    Json(json!({ "skip": body.get("skip").and_then(Value::as_bool).unwrap_or(false) }))
}

/// GET /v1/workspaces/{id}/events — SSE 事件流(双层信封,与 rune 一致)。
///
/// 长连接:无事件时每 15s 发送 `: ping` 注释帧保活;broadcast 关闭时
/// 保持连接(等待重连),前端断线重连由 sse.ts 处理。
async fn events(
    State(state): State<AppState>,
    Path(ws_id): Path<String>,
) -> Response {
    let rx = state.runs.broadcast(&ws_id).subscribe();
    let stream = unfold(rx, |mut rx| async move {
        // 注意:unfold 每产出一个元素会重建 async block,因此不能用
        // interval.tick()(首 tick 立即就绪会造成 ping 洪泛);用 sleep 保活。
        loop {
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_secs(15)) => {
                    return Some((
                        Ok::<_, Infallible>(bytes::Bytes::from_static(b": ping\n\n")),
                        rx,
                    ));
                }
                res = rx.recv() => match res {
                    Ok(v) => {
                        let frame = format!("data: {v}\n\n");
                        return Some((Ok::<_, Infallible>(bytes::Bytes::from(frame)), rx));
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => {
                        tokio::time::sleep(Duration::from_secs(1)).await;
                        continue;
                    }
                }
            }
        }
    });
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/event-stream")
        .header(header::CACHE_CONTROL, "no-cache")
        .body(axum::body::Body::from_stream(stream))
        .unwrap()
}

// ---------- 事件/消息 JSON 构造(rune 兼容 wire 格式) ----------

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn text_part(text: &str) -> Value {
    json!({ "type": "text", "data": { "text": text } })
}

fn tool_call_part(id: &str, name: &str, input: &str) -> Value {
    json!({
        "type": "tool_call",
        "data": { "id": id, "name": name, "input": input, "finished": true },
    })
}

fn tool_result_part(tool_call_id: &str, name: &str, content: &str) -> Value {
    json!({
        "type": "tool_result",
        "data": { "tool_call_id": tool_call_id, "name": name, "content": content, "is_error": false },
    })
}

fn tool_result_message_json(
    session_id: &str,
    tool_call_id: &str,
    name: &str,
    content: &str,
) -> Value {
    json!({
        "id": uuid::Uuid::new_v4().to_string(),
        "session_id": session_id,
        "role": "user",
        "parts": [tool_result_part(tool_call_id, name, content)],
        "created_at": now_secs(),
        "updated_at": now_secs(),
    })
}

fn finish_part(reason: &str, time: i64, usage: Option<(u64, u64)>) -> Value {
    let mut data = json!({ "reason": reason, "time": time });
    if let Some((input, output)) = usage {
        data["usage"] = json!({ "input_tokens": input, "output_tokens": output });
    }
    json!({ "type": "finish", "data": data })
}

/// 把运行错误转成对用户友好的中文提示;原始错误附在第二行便于排查。
/// 覆盖常见场景:余额不足(402)、密钥无效(401)、限流(429),其余原样返回。
/// 服务商返回体若是 JSON,解析并提取其中的 message 展示,而非整段原始 JSON。
fn friendly_error(e: &anyhow::Error) -> String {
    let raw = e.to_string();
    let low = raw.to_ascii_lowercase();
    let hint = if low.contains("402") || low.contains("insufficient balance") || low.contains("payment required") {
        "余额不足:当前 API 服务商账户余额不足或已欠费,充值后即可继续对话。"
    } else if low.contains("401") || low.contains("invalid api key") || low.contains("unauthorized") || low.contains("authentication") {
        "API 密钥无效或已过期:请在「设置」中检查当前 provider 的 API Key。"
    } else if low.contains("429") || low.contains("rate limit") || low.contains("too many requests") {
        "请求过于频繁(限流):请稍等片刻再试。"
    } else {
        return raw;
    };
    let detail = match extract_api_message(&raw) {
        Some(m) => format!("服务商返回:{m}"),
        None => format!("原始错误:{raw}"),
    };
    format!("{hint}\n{detail}")
}

/// 从 rig HttpError 的 `with message: <body>` 中提取服务商返回的 message 字段。
/// 逐层深入 error 对象找 message,兼容 openai(`{"error":{"message":...}}`)、
/// anthropic(`{"error":{"error":{"message":...}}}`)、opencode(`{"error":{"code":...,"message":...}}`)等结构;
/// body 非 JSON 时返回 None。
fn extract_api_message(raw: &str) -> Option<String> {
    const MARKER: &str = "with message: ";
    let idx = raw.find(MARKER)?;
    let body = raw[idx + MARKER.len()..].trim();
    let v: serde_json::Value = serde_json::from_str(body).ok()?;
    let mut cur = &v;
    for _ in 0..4 {
        if let Some(m) = cur.get("message").and_then(serde_json::Value::as_str) {
            return Some(m.to_string());
        }
        match cur.get("error") {
            Some(e) => cur = e,
            None => break,
        }
    }
    None
}

/// rune 双层信封:`{ type, payload: { type: created|updated|deleted, payload } }`。
fn msg_env(kind: &str, msg: Value) -> Value {
    json!({ "type": "message", "payload": { "type": kind, "payload": msg } })
}

fn run_complete_env(
    session_id: &str,
    run_id: &str,
    message_id: &str,
    text: &str,
    error: Option<&str>,
    usage: Option<(u64, u64)>,
) -> Value {
    let mut payload = json!({
        "session_id": session_id,
        "run_id": run_id,
        "message_id": message_id,
        "text": text,
    });
    if let Some(e) = error {
        payload["error"] = Value::String(e.to_string());
    }
    if let Some((input, output)) = usage {
        payload["usage"] = json!({ "input_tokens": input, "output_tokens": output });
    }
    json!({ "type": "run_complete", "payload": { "type": "updated", "payload": payload } })
}

fn user_message_json(session_id: &str, text: &str, cfg: &AskConfig) -> Value {
    json!({
        "id": uuid::Uuid::new_v4().to_string(),
        "session_id": session_id,
        "role": "user",
        "parts": [text_part(text)],
        "model": cfg.model,
        "provider": cfg.provider.id,
        "created_at": now_secs(),
        "updated_at": now_secs(),
    })
}

fn assistant_message_json(
    session_id: &str,
    id: &str,
    cfg: &AskConfig,
    parts: Vec<Value>,
    created_at: i64,
) -> Value {
    json!({
        "id": id,
        "session_id": session_id,
        "role": "assistant",
        "parts": parts,
        "model": cfg.model,
        "provider": cfg.provider.id,
        "created_at": created_at,
        "updated_at": now_secs(),
    })
}

/// 流式 assistant 消息的 parts 构建状态机。
///
/// 文本增量原地更新当前 text part;工具调用另起一行。工具调用后若模型
/// 继续输出文本,从空缓冲新开一个 text part——若直接复用整次 run 的累积
/// 缓冲,会把调用前的文本重复带入消息(前段文本重复显示)。
#[derive(Default)]
struct StreamParts {
    parts: Vec<Value>,
    /// 当前文本段缓冲(遇到工具调用后清空,使新文本段只含调用后的内容)
    text_buf: String,
}

impl StreamParts {
    fn text_delta(&mut self, t: &str) {
        self.text_buf.push_str(t);
        // 更新唯一的 text part(而非每个 delta 各建一个)
        let text_val = text_part(&self.text_buf);
        if self.parts.last().and_then(|p| p.get("type")).and_then(Value::as_str) == Some("text") {
            self.parts.last_mut().unwrap()["data"] = text_val["data"].clone();
        } else {
            self.parts.push(text_val);
        }
    }

    fn tool_call(&mut self, id: &str, name: &str, input: &str) {
        self.parts.push(tool_call_part(id, name, input));
        self.text_buf.clear();
    }

    fn finish(&mut self, reason: &str, time: i64, usage: Option<(u64, u64)>) {
        self.parts.push(finish_part(reason, time, usage));
    }

    fn into_parts(self) -> Vec<Value> {
        self.parts
    }
}

/// 把 proxy 注入的历史消息([{ role, parts }])还原为 rig Message 列表。
/// text/tool_call/tool_result 各成一跳,便于 provider 正确消费多轮上下文。
/// 孤立 tool_call(上次 run 失败残留、无配对 tool_result)直接丢弃,
/// 否则 OpenAI 兼容 provider 会报 400(assistant tool_calls 必须有 tool 消息跟随)。
///
/// 同一 assistant 消息内的多个 part 会合并输出,而不是逐 part 拆成独立消息:
/// - 全部 text part 合并为一条 assistant 文本消息,排在 tool_call 之前;
/// - 全部 tool_call part 合并进同一条 assistant 消息(OneOrMany::many)。
/// 原因:流式运行中模型常先输出文本、再调工具、最后补充文本,单条 wire 消息
/// 形如 [text, tool_call, text, finish];若逐 part 拆开会得到
/// assistant(text) → assistant(tool_calls) → assistant(text) 的序列,
/// OpenAI 兼容 provider 报 400("tool_calls must be followed by tool messages"),
/// 导致同一会话的跟进消息失败(UI 表现为 agent 无响应)。
fn history_to_messages(history: &[Value]) -> Vec<Message> {
    // 预扫描:收集有 tool_result 配对的 tool_call_id
    let mut answered: HashSet<String> = HashSet::new();
    for h in history {
        let role = h.get("role").and_then(Value::as_str).unwrap_or("assistant");
        if role != "user" && role != "tool" {
            continue;
        }
        let Some(parts) = h.get("parts").and_then(Value::as_array) else {
            continue;
        };
        for p in parts {
            if p.get("type").and_then(Value::as_str) != Some("tool_result") {
                continue;
            }
            if let Some(data) = p.get("data") {
                if let Some(id) = data.get("tool_call_id").and_then(Value::as_str) {
                    answered.insert(id.to_string());
                }
            }
        }
    }
    let mut out = Vec::new();
    for h in history {
        let role = h.get("role").and_then(Value::as_str).unwrap_or("assistant");
        let Some(parts) = h.get("parts").and_then(Value::as_array) else {
            continue;
        };
        // 用户/工具消息:按 part 直出
        if role == "user" || role == "tool" {
            for p in parts {
                let ptype = p.get("type").and_then(Value::as_str).unwrap_or("");
                let Some(data) = p.get("data") else { continue };
                match ptype {
                    "text" => {
                        let t = data.get("text").and_then(Value::as_str).unwrap_or("");
                        out.push(Message::user(t));
                    }
                    "tool_result" => {
                        let id = data
                            .get("tool_call_id")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string();
                        let content = data
                            .get("content")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string();
                        out.push(Message::tool_result(id, content));
                    }
                    _ => {}
                }
            }
            continue;
        }
        // assistant 消息:文本合并为一条(置于 tool_call 前),tool_call 合并为一条
        let mut texts: Vec<String> = Vec::new();
        let mut calls: Vec<AssistantContent> = Vec::new();
        for p in parts {
            let ptype = p.get("type").and_then(Value::as_str).unwrap_or("");
            let Some(data) = p.get("data") else { continue };
            match ptype {
                "text" => {
                    let t = data.get("text").and_then(Value::as_str).unwrap_or("");
                    texts.push(t.to_string());
                }
                "tool_call" => {
                    let id = data.get("id").and_then(Value::as_str).unwrap_or("").to_string();
                    // 无配对 tool_result 的孤立 tool_call 丢弃(会导致 provider 400)
                    if !answered.contains(&id) {
                        continue;
                    }
                    let name = data.get("name").and_then(Value::as_str).unwrap_or("").to_string();
                    let raw = data.get("input").and_then(Value::as_str).unwrap_or("{}");
                    let arguments: Value =
                        serde_json::from_str(raw).unwrap_or_else(|_| json!({}));
                    calls.push(AssistantContent::ToolCall(ToolCall::new(
                        id,
                        ToolFunction::new(name, arguments),
                    )));
                }
                _ => {}
            }
        }
        if !texts.is_empty() {
            out.push(Message::assistant(texts.join("\n")));
        }
        if !calls.is_empty() {
            // calls 非空由上面的分支保证,unwrap 安全
            out.push(Message::Assistant {
                id: None,
                content: OneOrMany::many(calls).expect("calls 非空"),
            });
        }
    }
    out
}

// ---------- providers / model 切换 ----------

/// GET /v1/workspaces/{id}/providers — 返回可用 provider 列表(含模型)。
///
/// 以内置 provider 为基准列表,再合并配置文件和 combo providers.json
/// 中对应 provider 的 key/models 覆盖;不在内置列表中的 provider 不返回。
async fn list_providers(State(state): State<AppState>) -> Json<Value> {
    let cfg = state.cfg.lock().unwrap().clone();
    let config_path = AppConfig::load_or_create(&crate::config::default_config_path())
        .unwrap_or_default();

    // 内置 provider 作为基准(保持顺序)
    let mut all: Vec<ProviderInfo> = providers::builtin_providers();

    // 合并配置文件中的 providers(仅内置列表中已有的 id)
    for p in &mut all {
        if let Some(pc) = config_path.providers.get(&p.id) {
            let from_cfg = ProviderInfo::from_config(&p.id, pc);
            // 覆盖 key/endpoint/type/默认模型
            if from_cfg.api_key.is_some() { p.api_key = from_cfg.api_key; }
            if from_cfg.api_endpoint.is_some() { p.api_endpoint = from_cfg.api_endpoint; }
            if from_cfg.provider_type.is_some() { p.provider_type = from_cfg.provider_type; }
            if from_cfg.default_large_model_id.is_some() { p.default_large_model_id = from_cfg.default_large_model_id; }
            // 合并而非替换:from_config 会用 default_large/small id 自动生成
            // 裸模型(无 context_window/name),整体替换会丢掉内置定义里的
            // 真实 context_window;这里只补配置里出现的新模型 id
            if !from_cfg.models.is_empty() {
                for cm in from_cfg.models {
                    if !p.models.iter().any(|m| m.id == cm.id) {
                        p.models.push(cm);
                    }
                }
            }
        }
    }

    // 合并 combo providers.json(仅内置列表中已有的 id)
    if let Ok(combo) = providers::load_combo_providers() {
        for p in &mut all {
            if let Some(cp) = combo.iter().find(|cp| cp.id == p.id) {
                if p.api_key.is_none() && cp.api_key.is_some() { p.api_key = cp.api_key.clone(); }
                if p.api_endpoint.is_none() && cp.api_endpoint.is_some() { p.api_endpoint = cp.api_endpoint.clone(); }
                if p.default_large_model_id.is_none() && cp.default_large_model_id.is_some() {
                    p.default_large_model_id = cp.default_large_model_id.clone();
                }
                if p.models.is_empty() && !cp.models.is_empty() { p.models = cp.models.clone(); }
            }
        }
    }

    // 追加配置文件中自定义的 provider(不在内置列表中的 id)
    for (id, pc) in &config_path.providers {
        if !all.iter().any(|p| &p.id == id) {
            all.push(ProviderInfo::from_config(id, pc));
        }
    }

    // 合并本地缓存的拉取模型(优先级最高:覆盖配置/内置)
    if let Ok(cached) = providers::load_cached_models() {
        for p in &mut all {
            if let Some(cp) = cached.iter().find(|c| c.id == p.id) {
                if !cp.models.is_empty() { p.models = cp.models.clone(); }
            }
        }
    }

    // 若当前运行时 provider 不在内置列表中,也加入(兼容旧配置)
    if !all.iter().any(|p| p.id == cfg.provider.id) {
        all.insert(0, cfg.provider.clone());
    }

    // 内置模型定义的 context_window 兜底表(按 provider+model id);opencode-zen
    // 配置条目没有内置定义,沿用内置 opencode 的模型信息
    let builtin_ctx = builtin_context_map();
    let builtin_price = builtin_pricing_map();

    let arr: Vec<Value> = all
        .iter()
        .map(|p| {
            // 已配置的 key 仅回传脱敏结果,不回传明文
            let masked = p.resolved_api_key().map(|k| mask_api_key(&k));
            json!({
                "id": p.id,
                "name": p.name.as_deref().unwrap_or(&p.id),
                "type": p.provider_type.as_deref().unwrap_or(""),
                "has_api_key": masked.is_some(),
                "api_key_masked": masked.unwrap_or_default(),
                "default_large_model_id": p.default_large_model_id,
                "default_small_model_id": p.default_small_model_id,
                "models": p.models.iter().map(|m| {
                    let (builtin_pin, builtin_pout) = builtin_price
                        .get(&p.id)
                        .and_then(|map| map.get(&m.id))
                        .copied()
                        .unwrap_or((None, None));
                    let pin = m.cost_per_1m_in.or(builtin_pin);
                    let pout = m.cost_per_1m_out.or(builtin_pout);
                    json!({
                        "id": m.id,
                        "name": m.name.as_deref().unwrap_or(&m.id),
                        "context_window": m.context_window.or_else(|| {
                            builtin_ctx.get(&p.id).and_then(|map| map.get(&m.id)).copied()
                        }),
                        "cost_per_1m_in": pin,
                        "cost_per_1m_out": pout,
                    })
                }).collect::<Vec<_>>(),
            })
        })
        .collect();
    Json(Value::Array(arr))
}

/// 脱敏 API Key:保留首尾各 4 个字符,中间用 `****` 替代;过短则整体 `****`。
fn mask_api_key(key: &str) -> String {
    let chars: Vec<char> = key.chars().collect();
    if chars.len() <= 8 {
        return "****".to_string();
    }
    let head: String = chars[..4].iter().collect();
    let tail: String = chars[chars.len() - 4..].iter().collect();
    format!("{head}****{tail}")
}

/// 内置模型定义的 context_window 兜底表:provider id → (model id → context_window)。
/// 配置/缓存 providers 覆盖 models 列表时经常丢失该字段(如拉取模型缓存里全为
/// null),按此表回填真实值;`opencode-zen` 配置条目无内置定义,沿用内置
/// `opencode` 的模型信息。
fn builtin_context_map() -> HashMap<String, HashMap<String, i64>> {
    let mut map: HashMap<String, HashMap<String, i64>> = HashMap::new();
    for p in providers::builtin_providers() {
        let models: HashMap<String, i64> = p
            .models
            .iter()
            .filter_map(|m| m.context_window.map(|c| (m.id.clone(), c)))
            .collect();
        map.insert(p.id.clone(), models.clone());
        if p.id == "opencode" {
            map.entry("opencode-zen".into()).or_insert(models);
        }
    }
    map
}

/// 内置模型定义的定价兜底表:provider id → (model id → (in, out))。
/// 配置/缓存 providers 覆盖 models 列表时经常丢失定价字段,按此表回填。
fn builtin_pricing_map() -> HashMap<String, HashMap<String, (Option<f64>, Option<f64>)>> {
    let mut map: HashMap<String, HashMap<String, (Option<f64>, Option<f64>)>> = HashMap::new();
    for p in providers::builtin_providers() {
        let models: HashMap<String, (Option<f64>, Option<f64>)> = p
            .models
            .iter()
            .map(|m| {
                (
                    m.id.clone(),
                    (m.cost_per_1m_in, m.cost_per_1m_out),
                )
            })
            .collect();
        map.insert(p.id.clone(), models.clone());
        if p.id == "opencode" {
            map.entry("opencode-zen".into()).or_insert(models);
        }
    }
    map
}

// ---------- 远程模型拉取 / API Key 保存 ----------

/// POST /v1/workspaces/{id}/providers/fetch-models
/// 请求体:`{ provider_id, api_key?, api_endpoint?, provider_type? }`
/// 用提供的或已配置的 key 拉取 provider 支持的模型列表。
#[derive(Deserialize)]
struct FetchModelsReq {
    provider_id: String,
    api_key: Option<String>,
    api_endpoint: Option<String>,
    provider_type: Option<String>,
}

async fn fetch_models(
    State(state): State<AppState>,
    Json(body): Json<FetchModelsReq>,
) -> Result<Json<Value>, (StatusCode, String)> {
    // 从配置文件中获取 provider 基础信息
    let config_path = AppConfig::load_or_create(&crate::config::default_config_path())
        .unwrap_or_default();
    let provider = providers::find_provider(&body.provider_id, &config_path.providers)
        .map_err(|e| (StatusCode::BAD_REQUEST, format!("未知 provider: {e}")))?;

    let ptype = body
        .provider_type
        .or_else(|| provider.provider_type.clone())
        .unwrap_or_else(|| "openai".to_string());

    // api_key:请求体 > provider 解析(combo providers.json / 内置 $ENV)
    let api_key = body
        .api_key
        .filter(|k| !k.is_empty())
        .or_else(|| provider.resolved_api_key())
        .ok_or_else(|| {
            (
                StatusCode::BAD_REQUEST,
                format!("provider `{}` 未配置 API Key", body.provider_id),
            )
        })?;

    // api_endpoint:请求体 > provider 解析 > 内置默认
    let api_endpoint = body
        .api_endpoint
        .filter(|e| !e.is_empty())
        .or_else(|| provider.resolved_endpoint());

    let models = providers::fetch_remote_models(&ptype, &api_key, api_endpoint.as_deref(), &body.provider_id)
        .await
        .map_err(|e| (StatusCode::SERVICE_UNAVAILABLE, format!("拉取模型失败: {e}")))?;

    // 同时更新运行时 config(若拉取的是当前 provider)
    {
        let mut cfg = state.cfg.lock().unwrap();
        if cfg.provider.id == body.provider_id {
            cfg.provider.models = models.clone();
        }
    }

    // 持久化到本地缓存,重启后 Composer 仍可直接查询/选中
    if let Err(e) = providers::save_cached_models(&body.provider_id, &models) {
        tracing::warn!("保存 provider `{}` 的模型缓存失败: {e}", body.provider_id);
    }

    let arr: Vec<Value> = models
        .iter()
        .map(|m| {
            json!({
                "id": m.id,
                "name": m.name.as_deref().unwrap_or(&m.id),
            })
        })
        .collect();
    Ok(Json(json!({ "provider": body.provider_id, "models": arr })))
}

/// POST /v1/workspaces/{id}/providers/save-key
/// 请求体:`{ provider_id, api_key, provider_type?, base_url? }`
/// 将 API Key 持久化到配置文件。
#[derive(Deserialize)]
struct SaveKeyReq {
    provider_id: String,
    api_key: String,
    provider_type: Option<String>,
    base_url: Option<String>,
}

async fn save_provider_key(
    _state: State<AppState>,
    Json(body): Json<SaveKeyReq>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let path = crate::config::default_config_path();
    crate::config::save_provider_key(
        &path,
        &body.provider_id,
        &body.api_key,
        body.provider_type.as_deref(),
        body.base_url.as_deref(),
    )
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("保存失败: {e}")))?;

    tracing::info!("已保存 provider `{}` 的 API Key", body.provider_id);
    Ok(Json(json!({ "ok": true, "provider": body.provider_id })))
}

/// GET /v1/workspaces/{id}/agent — 返回 agent 信息(含当前模型与其 context_window)。
async fn agent_info(State(state): State<AppState>) -> Json<Value> {
    let cfg = state.cfg.lock().unwrap().clone();

    // 当前模型的 context_window:优先 provider 模型列表,其次内置定义兜底
    let mut context_window: Option<i64> = None;
    for m in &cfg.provider.models {
        if m.id == cfg.model {
            context_window = m.context_window;
            break;
        }
    }
    if context_window.is_none() {
        context_window = builtin_context_map()
            .get(&cfg.provider.id)
            .and_then(|map| map.get(&cfg.model))
            .copied();
    }

    let mut model = json!({ "id": cfg.model, "name": cfg.model });
    if let Some(cw) = context_window {
        model["context_window"] = json!(cw);
    }
    Json(json!({
        "is_ready": true,
        "model": model,
        "model_cfg": { "model": cfg.model, "provider": cfg.provider.id },
    }))
}

/// POST /v1/workspaces/{id}/config/model — 运行时切换模型。
#[derive(Deserialize)]
struct ConfigModelReq {
    model: Option<ConfigModelRef>,
}

#[derive(Deserialize)]
struct ConfigModelRef {
    model: Option<String>,
    provider: Option<String>,
}

async fn config_model(
    State(state): State<AppState>,
    Json(body): Json<ConfigModelReq>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let mut cfg = state.cfg.lock().unwrap().clone();
    if let Some(m) = &body.model {
        if let Some(provider_id) = &m.provider {
            if provider_id != &cfg.provider.id {
                // 切换 provider:合并配置文件内嵌 providers,与 list_providers 口径一致
                let config_path = AppConfig::load_or_create(&crate::config::default_config_path())
                    .unwrap_or_default();
                match providers::find_provider(provider_id, &config_path.providers) {
                    Ok(p) => cfg.provider = p,
                    Err(e) => {
                        return Err((
                            StatusCode::BAD_REQUEST,
                            format!("未知 provider `{provider_id}`: {e}"),
                        ))
                    }
                }
            }
        }
        if let Some(model_id) = &m.model {
            if !model_id.is_empty() {
                cfg.model = model_id.clone();
            }
        }
    }
    *state.cfg.lock().unwrap() = cfg.clone();
    tracing::info!("模型已切换:{} @ {}", cfg.model, cfg.provider.id);
    Ok(Json(json!({ "ok": true })))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn part(t: &str, text: &str) -> Value {
        json!({ "type": t, "data": serde_json::from_str::<Value>(text).unwrap() })
    }

    #[test]
    fn history_to_messages_reconstructs_turns() {
        let history = vec![
            json!({ "role": "user", "parts": [part("text", r#"{"text":"你好"}"#)] }),
            json!({
                "role": "assistant",
                "parts": [
                    part("text", r#"{"text":"你好!"}"#),
                    part("tool_call", r#"{"id":"c1","name":"bash","input":"{\"command\":\"pwd\"}"}"#),
                ],
            }),
            json!({
                "role": "user",
                "parts": [part("tool_result", r#"{"tool_call_id":"c1","content":"/tmp"}"#)],
            }),
        ];
        let msgs = history_to_messages(&history);
        assert_eq!(msgs.len(), 4);
        // user text
        match &msgs[0] {
            Message::User { content } => {
                assert!(matches!(
                    content.first_ref(),
                    &rig::completion::message::UserContent::Text(_)
                ));
            }
            _ => panic!("expected user message"),
        }
        // assistant text
        match &msgs[1] {
            Message::Assistant { id, .. } => assert!(id.is_none()),
            _ => panic!("expected assistant message"),
        }
        // assistant tool call
        match &msgs[2] {
            Message::Assistant { content, .. } => {
                assert!(matches!(
                    content.first_ref(),
                    &rig::completion::AssistantContent::ToolCall(_)
                ));
            }
            _ => panic!("expected assistant tool_call message"),
        }
        // user tool result
        match &msgs[3] {
            Message::User { content } => {
                assert!(matches!(
                    content.first_ref(),
                    &rig::completion::message::UserContent::ToolResult(_)
                ));
            }
            _ => panic!("expected user tool_result message"),
        }
    }

    #[test]
    fn friendly_error_maps_common_status_codes() {
        let cases = [
            // JSON 返回体:解析并展示服务商 message,不再贴原始 JSON
            (
                "CompletionError: HttpError: Invalid status code 402 Payment Required with message: {\"error\":{\"message\":\"Insufficient Balance\"}}",
                "余额不足",
                Some("Insufficient Balance"),
            ),
            (
                "CompletionError: HttpError: Invalid status code 429 Too Many Requests with message: {\"error\":{\"code\":\"1310\",\"message\":\"您已达到每周/每月使用上限,限额将在 2026-08-11 16:45:24 重置。\"}}",
                "限流",
                Some("您已达到每周/每月使用上限"),
            ),
            // anthropic 双层 error 嵌套
            (
                "CompletionError: HttpError: Invalid status code 429 Too Many Requests with message: {\"type\":\"error\",\"error\":{\"type\":\"rate_limit_error\",\"message\":\"Rate limit reached for test\"}}",
                "限流",
                Some("Rate limit reached for test"),
            ),
            // 非 JSON 返回体:保留原始错误
            (
                "CompletionError: HttpError: Invalid status code 401 Unauthorized with message: invalid api key",
                "API 密钥无效",
                None,
            ),
            (
                "CompletionError: HttpError: Invalid status code 429 Too Many Requests with message: rate limit exceeded",
                "限流",
                None,
            ),
            ("Connection refused (os error 61)", "Connection refused", None),
        ];
        for (raw, expect, parsed) in cases {
            let msg = friendly_error(&anyhow::anyhow!("{raw}"));
            assert!(msg.contains(expect), "raw={raw} msg={msg}");
            if let Some(p) = parsed {
                assert!(msg.contains(p), "raw={raw} msg={msg}");
                assert!(!msg.contains("原始错误"), "raw={raw} msg={msg}");
            } else if msg != raw {
                assert!(msg.contains("原始错误"), "raw={raw} msg={msg}");
            }
        }
    }

    #[test]
    fn history_to_messages_drops_orphan_tool_call() {
        // 上次 run 失败残留:assistant tool_call 没有配对 tool_result
        let history = vec![
            json!({ "role": "user", "parts": [part("text", r#"{"text":"今天是什么日子"}"#)] }),
            json!({
                "role": "assistant",
                "parts": [
                    part("tool_call", r#"{"id":"orphan1","name":"current_date","input":"{}"}"#),
                ],
            }),
            json!({ "role": "user", "parts": [part("text", r#"{"text":"明天呢"}"#)] }),
            // 正常的一对:tool_call + tool_result 都要保留
            json!({
                "role": "assistant",
                "parts": [
                    part("tool_call", r#"{"id":"ok1","name":"bash","input":"{\"command\":\"pwd\"}"}"#),
                ],
            }),
            json!({
                "role": "user",
                "parts": [part("tool_result", r#"{"tool_call_id":"ok1","content":"/tmp"}"#)],
            }),
        ];
        let msgs = history_to_messages(&history);
        // orphan1 被丢弃,ok1 的 tool_call + tool_result 保留
        assert_eq!(msgs.len(), 4);
        // user text(今天是什么日子)
        assert!(matches!(&msgs[0], Message::User { .. }));
        // user text(明天呢)
        assert!(matches!(&msgs[1], Message::User { .. }));
        // ok1 的 assistant tool_call
        match &msgs[2] {
            Message::Assistant { content, .. } => {
                assert!(matches!(
                    content.first_ref(),
                    &rig::completion::AssistantContent::ToolCall(_)
                ));
            }
            _ => panic!("expected assistant tool_call message"),
        }
        // ok1 的 tool_result
        assert!(matches!(&msgs[3], Message::User { .. }));
    }

    #[test]
    fn history_to_messages_merges_text_after_tool_call() {
        // 流式运行常见的 wire 形态:assistant 消息 = [text, tool_call, text, finish],
        // 工具结果紧随其后单独成条。逐 part 拆分会把 tool_call 之后的那段文本
        // 插到 tool_call 与 tool_result 之间,触发 OpenAI 400,这里必须合并。
        let history = vec![
            json!({ "role": "user", "parts": [part("text", r#"{"text":"现在几点"}"#)] }),
            json!({
                "role": "assistant",
                "parts": [
                    part("text", r#"{"text":"让我查一下"}"#),
                    part("tool_call", r#"{"id":"t1","name":"current_time","input":"{}"}"#),
                    part("text", r#"{"text":"当前时间:13:34:12"}"#),
                    part("finish", r#"{"reason":"end_turn","time":1}"#),
                ],
            }),
            json!({
                "role": "user",
                "parts": [part("tool_result", r#"{"tool_call_id":"t1","content":"13:34:12"}"#)],
            }),
            json!({ "role": "user", "parts": [part("text", r#"{"text":"再查日期"}"#)] }),
        ];
        let msgs = history_to_messages(&history);
        assert_eq!(msgs.len(), 5);
        // 0: user text
        assert!(matches!(&msgs[0], Message::User { .. }));
        // 1: assistant 文本(调用前 + 调用后的文本合并为一条)
        match &msgs[1] {
            Message::Assistant { id, content } => {
                assert!(id.is_none());
                let texts: Vec<&str> = content
                    .iter()
                    .filter_map(|c| match c {
                        AssistantContent::Text(t) => Some(t.text.as_str()),
                        _ => None,
                    })
                    .collect();
                assert_eq!(texts, vec!["让我查一下\n当前时间:13:34:12"]);
            }
            _ => panic!("expected assistant text message"),
        }
        // 2: assistant tool_call(合并后仍只有 t1)
        match &msgs[2] {
            Message::Assistant { content, .. } => {
                assert!(matches!(
                    content.first_ref(),
                    &rig::completion::AssistantContent::ToolCall(_)
                ));
            }
            _ => panic!("expected assistant tool_call message"),
        }
        // 3: tool_result
        assert!(matches!(&msgs[3], Message::User { .. }));
        // 4: 跟进消息 user text
        assert!(matches!(&msgs[4], Message::User { .. }));
    }

    #[test]
    fn history_to_messages_groups_multiple_tool_calls_into_one_message() {
        // 一次 run 内多次工具调用:wire 消息为 [text, tcA, text, tcB, finish],
        // 两个 tool_call 必须合并进同一条 assistant 消息,否则 tool_calls
        // 消息之间夹 assistant 文本同样会触发 OpenAI 400。
        let history = vec![
            json!({ "role": "user", "parts": [part("text", r#"{"text":"现在几点几分"}"#)] }),
            json!({
                "role": "assistant",
                "parts": [
                    part("tool_call", r#"{"id":"a","name":"current_time","input":"{}"}"#),
                    part("text", r#"{"text":"时间是"}"#),
                    part("tool_call", r#"{"id":"b","name":"current_date","input":"{}"}"#),
                ],
            }),
            json!({
                "role": "user",
                "parts": [part("tool_result", r#"{"tool_call_id":"a","content":"13:34"}"#)],
            }),
            json!({
                "role": "user",
                "parts": [part("tool_result", r#"{"tool_call_id":"b","content":"2026-08-10"}"#)],
            }),
        ];
        let msgs = history_to_messages(&history);
        // user text / assistant 文本 / assistant{tcA+tcB} / tool_result a / tool_result b
        assert_eq!(msgs.len(), 5);
        assert!(matches!(&msgs[0], Message::User { .. }));
        match &msgs[1] {
            Message::Assistant { id, content } => {
                assert!(id.is_none());
                assert!(matches!(
                    content.first_ref(),
                    &rig::completion::AssistantContent::Text(_)
                ));
            }
            _ => panic!("expected assistant text message"),
        }
        match &msgs[2] {
            Message::Assistant { content, .. } => {
                let calls: Vec<_> = content
                    .iter()
                    .filter(|c| matches!(c, AssistantContent::ToolCall(_)))
                    .collect();
                assert_eq!(calls.len(), 2, "两个 tool_call 应合并进同一条 assistant 消息");
            }
            _ => panic!("expected assistant tool_call message"),
        }
        // 两个 tool_result 紧随其后
        assert!(matches!(&msgs[3], Message::User { .. }));
        assert!(matches!(&msgs[4], Message::User { .. }));
    }

    #[test]
    fn stream_parts_does_not_duplicate_text_after_tool_call() {
        // 模型先输出文本 → 调用工具 → 再输出文本:工具调用后的新文本段
        // 只含调用后的内容,不能把调用前的文本重复带入(前段文本重复显示)。
        let mut sp = StreamParts::default();
        sp.text_delta("先看看当前时间");
        sp.tool_call("t1", "bash", r#"{"cmd":"date"}"#);
        sp.text_delta("现在是 13:34");
        sp.text_delta(", 请确认无误");
        sp.finish("end_turn", 1, None);
        let parts = sp.into_parts();
        let kinds: Vec<&str> = parts
            .iter()
            .map(|p| p.get("type").and_then(Value::as_str).unwrap_or(""))
            .collect();
        assert_eq!(kinds, vec!["text", "tool_call", "text", "finish"]);
        let texts: Vec<&str> = parts
            .iter()
            .filter(|p| p.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|p| p["data"]["text"].as_str())
            .collect();
        assert_eq!(texts, vec!["先看看当前时间", "现在是 13:34, 请确认无误"]);
    }

    #[test]
    fn stream_parts_updates_text_part_in_place() {
        let mut sp = StreamParts::default();
        sp.text_delta("a");
        sp.text_delta("b");
        assert_eq!(sp.parts.len(), 1);
        assert_eq!(sp.parts[0]["data"]["text"], "ab");
        // 连续工具调用后,文本缓冲已清空,后续文本新开 part 且只含新内容
        sp.tool_call("t1", "bash", "{}");
        sp.tool_call("t2", "bash", "{}");
        assert_eq!(sp.parts.len(), 3);
        sp.text_delta("c");
        assert_eq!(sp.parts.len(), 4);
        assert_eq!(sp.parts[3]["data"]["text"], "c");
    }

    #[test]
    fn msg_env_uses_double_envelope() {
        let env = msg_env("created", json!({ "id": "x" }));
        assert_eq!(env["type"], "message");
        assert_eq!(env["payload"]["type"], "created");
        assert_eq!(env["payload"]["payload"]["id"], "x");
    }

    #[test]
    fn finish_part_carries_real_usage_when_reported() {
        // provider 上报 usage 时,finish part 的 data 内嵌 input/output tokens
        let with_usage = finish_part("end_turn", 1, Some((128_000, 2048)));
        assert_eq!(with_usage["type"], "finish");
        assert_eq!(with_usage["data"]["usage"]["input_tokens"], 128_000);
        assert_eq!(with_usage["data"]["usage"]["output_tokens"], 2048);
        // 未上报时不出现 usage 字段(保持旧 wire 形状)
        let without_usage = finish_part("cancelled", 1, None);
        assert!(without_usage["data"].get("usage").is_none());
    }

    #[test]
    fn run_complete_env_carries_usage_when_reported() {
        let env = run_complete_env("s1", "r1", "m1", "hi", None, Some((100, 20)));
        assert_eq!(env["type"], "run_complete");
        assert_eq!(env["payload"]["payload"]["usage"]["input_tokens"], 100);
        assert_eq!(env["payload"]["payload"]["usage"]["output_tokens"], 20);
        let plain = run_complete_env("s1", "r1", "m1", "hi", Some("err"), None);
        assert!(plain["payload"]["payload"].get("usage").is_none());
    }

    #[test]
    fn mask_api_key_keeps_edges_only() {
        assert_eq!(mask_api_key("sk-abcdefghijkl1234"), "sk-a****1234");
        assert_eq!(mask_api_key("short"), "****");
        assert_eq!(mask_api_key(""), "****");
    }
}
