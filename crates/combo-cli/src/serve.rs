//! serve 服务模式:RuneManager 式进程管理 + rune 兼容协议。
//!
//! 供 combo-proxy 直接托管的 HTTP 端点:
//! - `GET /v1/health`                       → 健康检查(`{"ok":true}`)
//! - `POST /v1/control`                     → 优雅关闭(信号驱动)
//! - `POST /v1/agent`                       → 单轮问答(旧接口)
//! - `POST /v1/workspaces/{id}/agent`       → 发起一次 agent 运行
//! - `POST /v1/workspaces/{id}/agent/sessions/{sid}/cancel` → 取消运行
//! - `GET  /v1/workspaces/{id}/events`      → SSE 事件流(与 rune 双层信封一致)
//!
//! 会话/历史由 combo-proxy 的 sqlite 镜像负责(combo 自有数据源),
//! 因此 serve 侧无状态:`/agent` 请求体可携带 `history`(proxy 注入的
//! `[{role, parts}]` 历史消息),运行过程中的消息事件经 broadcast 广播。
//! 这样 combo-cli 可被 combo-proxy 当作一个受管的 agent 后端进程。

use crate::agent::{self, AskConfig, RunEvent};
use crate::config::AppConfig;
use crate::providers::{self, ProviderInfo};
use anyhow::Result;
use axum::{
    Json, Router,
    extract::{Path, State},
    http::{StatusCode, header},
    response::Response,
    routing::{get, post},
};
use futures::stream::unfold;
use rig::completion::message::{ToolCall, ToolFunction};
use rig::completion::{AssistantContent, Message};
use rig::OneOrMany;
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::convert::Infallible;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::{Notify, broadcast, watch};

#[derive(Clone)]
struct AppState {
    cfg: Arc<Mutex<AskConfig>>,
    shutdown: Arc<Notify>,
    runs: Arc<RunState>,
}

/// 运行态:按 workspace 广播事件,按 session 取消运行。
#[derive(Default)]
struct RunState {
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
    /// workspace 根目录(combo-proxy 注入),供 read/write/search 工具使用。
    workspace_dir: Option<String>,
}

pub async fn run(cfg: &agent::AskConfig, host: String, port: u16) -> Result<()> {
    let state = AppState {
        cfg: Arc::new(Mutex::new(cfg.clone())),
        shutdown: Arc::new(Notify::new()),
        runs: Arc::new(RunState::default()),
    };

    let app = Router::new()
        .route("/v1/health", get(health))
        .route("/v1/control", post(control))
        .route("/v1/agent", post(run_agent))
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
        .route("/v1/workspaces/:id/events", get(events))
        .route("/v1/workspaces/:id/providers", get(list_providers))
        .route("/v1/workspaces/:id/providers/fetch-models", post(fetch_models))
        .route("/v1/workspaces/:id/providers/save-key", post(save_provider_key))
        .route("/v1/providers", get(list_providers))
        .route("/v1/providers/fetch-models", post(fetch_models))
        .route("/v1/providers/save-key", post(save_provider_key))
        .route("/v1/workspaces/:id/config/model", post(config_model))
        .with_state(state.clone());

    let addr: SocketAddr = format!("{host}:{port}").parse()?;
    let listener = tokio::net::TcpListener::bind(addr).await?;
    let actual = listener.local_addr()?;
    // 机器可读端口输出(combo-proxy 的 ComboCliManager 解析此行为准)。
    println!("COMBO_CLI_PORT={}", actual.port());
    println!("combo-cli serve 已启动:http://{actual}");

    // 收到 control 通知后优雅退出:在 axum serve 的 graceful_shutdown 里等待
    let shutdown_handle = state.shutdown.clone();
    axum::serve(listener, app)
        .with_graceful_shutdown(async move {
            shutdown_handle.notified().await;
            tracing::info!("收到关闭信号,退出服务");
        })
        .await?;
    Ok(())
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
    let answer = crate::agent::ask_answer(&cfg, &question, std::env::current_dir().ok())
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

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
    let cfg = state.cfg.lock().unwrap().clone();
    let user_msg = user_message_json(&body.session_id, &body.prompt, &cfg);
    let _ = tx.send(msg_env("created", user_msg));

    // 2. 后台运行 agent,事件经广播流出
    let history = body.history.clone().unwrap_or_default();
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
        let mut parts: Vec<Value> = Vec::new();
        let mut text_buf = String::new();
        let tx_ev = tx.clone();
        let workspace_dir = body
            .workspace_dir
            .as_deref()
            .map(std::path::PathBuf::from);
        let result =
            crate::agent::stream_run(&cfg, &prompt, &rig_history, workspace_dir, cancel_rx, |ev| {
            match ev {
                RunEvent::TextDelta(t) => {
                    text_buf.push_str(&t);
                    // 更新唯一的 text part(而非每个 delta 各建一个)
                    let text_val = text_part(&text_buf);
                    if parts.last().and_then(|p| p.get("type")).and_then(Value::as_str) == Some("text") {
                        parts.last_mut().unwrap()["data"] = text_val["data"].clone();
                    } else {
                        parts.push(text_val);
                    }
                }
                RunEvent::ToolCall { id, name, input } => {
                    parts.push(tool_call_part(&id, &name, &input));
                }
                RunEvent::ToolResult { id, content } => {
                    let msg = tool_result_message_json(&session_id, &id, &content);
                    let _ = tx_ev.send(msg_env("created", msg));
                }
            }
            let _ = tx_ev.send(msg_env(
                "updated",
                assistant_message_json(
                    &session_id,
                    &assistant_id,
                    &cfg,
                    parts.clone(),
                    created_at,
                ),
            ));
        })
        .await;

        let (reason, error, text) = match &result {
            Ok(Some(t)) => ("end_turn", None, t.clone()),
            Ok(None) => ("cancelled", None, String::new()),
            Err(e) => ("error", Some(e.to_string()), e.to_string()),
        };
        parts.push(finish_part(reason, now_secs()));
        let _ = tx.send(msg_env(
            "updated",
            assistant_message_json(&session_id, &assistant_id, &cfg, parts, created_at),
        ));
        let _ = tx.send(run_complete_env(
            &session_id,
            &run_id2,
            &assistant_id,
            &text,
            error.as_deref(),
        ));
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

fn tool_result_part(tool_call_id: &str, content: &str) -> Value {
    json!({
        "type": "tool_result",
        "data": { "tool_call_id": tool_call_id, "content": content, "is_error": false },
    })
}

fn tool_result_message_json(session_id: &str, tool_call_id: &str, content: &str) -> Value {
    json!({
        "id": uuid::Uuid::new_v4().to_string(),
        "session_id": session_id,
        "role": "user",
        "parts": [tool_result_part(tool_call_id, content)],
        "created_at": now_secs(),
        "updated_at": now_secs(),
    })
}

fn finish_part(reason: &str, time: i64) -> Value {
    json!({ "type": "finish", "data": { "reason": reason, "time": time } })
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

/// 把 proxy 注入的历史消息([{ role, parts }])还原为 rig Message 列表。
/// text/tool_call/tool_result 各成一跳,便于 provider 正确消费多轮上下文。
fn history_to_messages(history: &[Value]) -> Vec<Message> {
    let mut out = Vec::new();
    for h in history {
        let role = h.get("role").and_then(Value::as_str).unwrap_or("assistant");
        let Some(parts) = h.get("parts").and_then(Value::as_array) else {
            continue;
        };
        for p in parts {
            let ptype = p.get("type").and_then(Value::as_str).unwrap_or("");
            let Some(data) = p.get("data") else { continue };
            match (role, ptype) {
                ("user", "text") => {
                    let t = data.get("text").and_then(Value::as_str).unwrap_or("");
                    out.push(Message::user(t));
                }
                ("assistant", "text") => {
                    let t = data.get("text").and_then(Value::as_str).unwrap_or("");
                    out.push(Message::assistant(t));
                }
                ("assistant", "tool_call") => {
                    let id = data.get("id").and_then(Value::as_str).unwrap_or("").to_string();
                    let name = data.get("name").and_then(Value::as_str).unwrap_or("").to_string();
                    let raw = data.get("input").and_then(Value::as_str).unwrap_or("{}");
                    let arguments: Value =
                        serde_json::from_str(raw).unwrap_or_else(|_| json!({}));
                    out.push(Message::Assistant {
                        id: Some(id.clone()),
                        content: OneOrMany::one(AssistantContent::ToolCall(ToolCall::new(
                            id,
                            ToolFunction::new(name, arguments),
                        ))),
                    });
                }
                ("user" | "tool", "tool_result") => {
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
    }
    out
}

// ---------- providers / model 切换 ----------

/// GET /v1/workspaces/{id}/providers — 返回可用 provider 列表(含模型)。
///
/// 以内置 provider 为基准列表,再合并配置文件和 crush providers.json
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
            if !from_cfg.models.is_empty() { p.models = from_cfg.models; }
        }
    }

    // 合并 crush providers.json(仅内置列表中已有的 id)
    if let Ok(crush) = providers::load_crush_providers() {
        for p in &mut all {
            if let Some(cp) = crush.iter().find(|cp| cp.id == p.id) {
                if p.api_key.is_none() && cp.api_key.is_some() { p.api_key = cp.api_key.clone(); }
                if p.api_endpoint.is_none() && cp.api_endpoint.is_some() { p.api_endpoint = cp.api_endpoint.clone(); }
                if p.default_large_model_id.is_none() && cp.default_large_model_id.is_some() {
                    p.default_large_model_id = cp.default_large_model_id.clone();
                }
                if p.models.is_empty() && !cp.models.is_empty() { p.models = cp.models.clone(); }
            }
        }
    }

    // 若当前运行时 provider 不在内置列表中,也加入(兼容旧配置)
    if !all.iter().any(|p| p.id == cfg.provider.id) {
        all.insert(0, cfg.provider.clone());
    }

    let arr: Vec<Value> = all
        .iter()
        .map(|p| {
            json!({
                "id": p.id,
                "name": p.name.as_deref().unwrap_or(&p.id),
                "type": p.provider_type.as_deref().unwrap_or(""),
                "models": p.models.iter().map(|m| {
                    json!({
                        "id": m.id,
                        "name": m.name.as_deref().unwrap_or(&m.id),
                    })
                }).collect::<Vec<_>>(),
            })
        })
        .collect();
    Json(Value::Array(arr))
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

    // api_key:请求体 > provider 解析(crush.json / providers.json / 内置 $ENV)
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

/// GET /v1/workspaces/{id}/agent — 返回 agent 信息(含当前模型)。
async fn agent_info(State(state): State<AppState>) -> Json<Value> {
    let cfg = state.cfg.lock().unwrap().clone();
    Json(json!({
        "is_ready": true,
        "model": { "id": cfg.model, "name": cfg.model },
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
                // 切换 provider
                match providers::find_provider(provider_id, &std::collections::BTreeMap::new()) {
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
    fn msg_env_uses_double_envelope() {
        let env = msg_env("created", json!({ "id": "x" }));
        assert_eq!(env["type"], "message");
        assert_eq!(env["payload"]["type"], "created");
        assert_eq!(env["payload"]["payload"]["id"], "x");
    }
}
