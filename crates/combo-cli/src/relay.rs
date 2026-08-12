//! 隧道管理器:通过 HTTP 端点控制隧道客户端的生命周期。
//!
//! 端点:
//! - `POST /v1/relay/start` `{ url, token }` — 启动隧道(自动重连)
//! - `POST /v1/relay/stop` — 停止隧道
//! - `GET /v1/relay/status` — 查询状态

use crate::tunnel::{run_tunnel_client, TunnelClientConfig};
use axum::extract::State;
use axum::Json;
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::sync::Mutex;
use tokio::task::JoinHandle;

/// 隧道状态(AppState 共享)。
pub struct RelayManager {
    task: Mutex<Option<JoinHandle<()>>>,
    config: Mutex<Option<TunnelClientConfig>>,
    /// WebSocket 是否实际已连接(区分"task 存活"与"隧道连通")。
    connected: Arc<AtomicBool>,
}

impl RelayManager {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            task: Mutex::new(None),
            config: Mutex::new(None),
            connected: Arc::new(AtomicBool::new(false)),
        })
    }

    pub async fn start(&self, url: String, token: String, local_proxy_url: String) {
        let mut task_guard = self.task.lock().await;
        // 停止旧隧道
        if let Some(old) = task_guard.take() {
            old.abort();
        }
        self.connected.store(false, Ordering::Relaxed);

        let config = TunnelClientConfig {
            relay_url: url,
            token,
            local_proxy_url,
        };
        let config_clone = config.clone();
        let connected_flag = self.connected.clone();

        *task_guard = Some(tokio::spawn(async move {
            run_tunnel_client(config, connected_flag).await;
        }));

        let mut cfg_guard = self.config.lock().await;
        *cfg_guard = Some(config_clone);
    }

    pub async fn stop(&self) {
        let mut task_guard = self.task.lock().await;
        if let Some(old) = task_guard.take() {
            old.abort();
        }
        self.connected.store(false, Ordering::Relaxed);
        let mut cfg_guard = self.config.lock().await;
        *cfg_guard = None;
    }

    /// task 是否存活(不代表 WebSocket 已连通)。
    pub async fn is_running(&self) -> bool {
        let guard = self.task.lock().await;
        guard.as_ref().is_some_and(|h| !h.is_finished())
    }

    /// WebSocket 是否实际已连接到中转服务器。
    pub fn is_connected(&self) -> bool {
        self.connected.load(Ordering::Relaxed)
    }
}

#[derive(Deserialize)]
pub struct StartRelayBody {
    pub url: String,
    pub token: String,
    #[serde(default)]
    pub local_proxy_url: Option<String>,
}

#[derive(Serialize)]
pub struct RelayStatus {
    pub running: bool,
    pub connected: bool,
}

pub async fn start_relay(
    State(state): State<crate::serve::AppState>,
    Json(body): Json<StartRelayBody>,
) -> Json<RelayStatus> {
    // local_proxy_url 未指定时使用 AppState 中的本地端口
    let local = body
        .local_proxy_url
        .unwrap_or_else(|| format!("http://127.0.0.1:{}", state.local_port));
    state.relay.start(body.url, body.token, local).await;
    Json(RelayStatus {
        running: true,
        connected: false,
    })
}

pub async fn stop_relay(
    State(state): State<crate::serve::AppState>,
) -> Json<RelayStatus> {
    state.relay.stop().await;
    Json(RelayStatus {
        running: false,
        connected: false,
    })
}

pub async fn relay_status(
    State(state): State<crate::serve::AppState>,
) -> Json<RelayStatus> {
    Json(RelayStatus {
        running: state.relay.is_running().await,
        connected: state.relay.is_connected(),
    })
}
