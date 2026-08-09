//! serve 服务模式:RuneManager 式进程管理。
//!
//! 提供 combo-proxy 可直接托管的 HTTP 端点:
//! - `GET /v1/health`   → 健康检查(`{"ok":true}`)
//! - `POST /v1/control` → 优雅关闭(信号驱动,与 combo-proxy 的 control 约定一致)
//! - `POST /v1/agent`   → 单轮问答(`{"question":"..."}` → `{"answer":"..."}`)
//!
//! 对应 combo-proxy 的 RuneManager 模式:启动 → 轮询 health → 失败自动重启,
//! 关闭时通过 `/v1/control` 优雅退出。这样 combo-cli 可被 combo-proxy 当作
//! 一个受管的 agent 后端进程。

use crate::agent::{self, AskConfig};
use anyhow::Result;
use axum::{
    Json, Router,
    extract::State,
    http::StatusCode,
    routing::{get, post},
};
use serde_json::{Value, json};
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::sync::Notify;

#[derive(Clone)]
struct AppState {
    cfg: AskConfig,
    shutdown: Arc<Notify>,
}

pub async fn run(cfg: &agent::AskConfig, host: String, port: u16) -> Result<()> {
    let state = AppState {
        cfg: cfg.clone(),
        shutdown: Arc::new(Notify::new()),
    };

    let app = Router::new()
        .route("/v1/health", get(health))
        .route("/v1/control", post(control))
        .route("/v1/agent", post(run_agent))
        .with_state(state.clone());

    let addr: SocketAddr = format!("{host}:{port}").parse()?;
    let listener = tokio::net::TcpListener::bind(addr).await?;
    let actual = listener.local_addr()?;
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

async fn run_agent(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let question = body
        .get("question")
        .and_then(Value::as_str)
        .ok_or_else(|| (StatusCode::BAD_REQUEST, "缺少 question 字段".into()))?
        .to_string();

    let answer = crate::agent::ask_answer(&state.cfg, &question)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(Json(json!({ "ok": true, "answer": answer })))
}
