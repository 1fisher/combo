//! 隧道管理器:通过 HTTP 端点控制隧道客户端的生命周期。
//!
//! 端点:
//! - `POST /v1/relay/start` `{ url, token }` — 启动隧道(自动重连)
//! - `POST /v1/relay/stop` — 停止隧道
//! - `GET /v1/relay/status` — 查询状态

use crate::p2p::P2pManager;
use crate::tunnel::{run_tunnel_client, test_connection, TunnelClientConfig};
use axum::extract::State;
use axum::Json;
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Mutex;
use tokio::task::JoinHandle;

/// 隧道状态(AppState 共享)。
pub struct RelayManager {
    task: Mutex<Option<JoinHandle<()>>>,
    config: Mutex<Option<TunnelClientConfig>>,
    /// WebSocket 是否实际已连接(区分"task 存活"与"隧道连通")。
    connected: Arc<AtomicBool>,
    /// 最近一次连接错误(透传到 RelayStatus.error 供前端显示)。
    /// 连接成功时清空。
    last_error: Arc<std::sync::Mutex<Option<String>>>,
    /// WebRTC P2P 直连管理器:信令经隧道收发,随隧道启停。
    pub p2p: Arc<P2pManager>,
    /// 系统保活子进程(macOS caffeinate;非 macOS 恒为 None)。
    /// 远程访问启用期间阻止系统休眠(允许屏幕关闭),
    /// 类似远程控制软件的保活行为。
    keep_awake: std::sync::Mutex<Option<std::process::Child>>,
}

impl RelayManager {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            task: Mutex::new(None),
            config: Mutex::new(None),
            connected: Arc::new(AtomicBool::new(false)),
            last_error: Arc::new(std::sync::Mutex::new(None)),
            p2p: P2pManager::new(),
            keep_awake: std::sync::Mutex::new(None),
        })
    }

    /// 持有系统保活断言(macOS):caffeinate -i -s -w <pid>。
    /// 阻止系统空闲休眠(允许屏幕自动关闭),子进程随本进程退出自动释放。
    fn hold_awake(&self) {
        #[cfg(target_os = "macos")]
        {
            let mut guard = self.keep_awake.lock().unwrap();
            if guard.is_some() {
                return;
            }
            match std::process::Command::new("caffeinate")
                .args([
                    "-i",
                    "-s",
                    "-w",
                    &std::process::id().to_string(),
                ])
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn()
            {
                Ok(child) => {
                    tracing::info!("[relay] 系统保活已启用(caffeinate,阻止休眠/允许息屏)");
                    *guard = Some(child);
                }
                Err(e) => {
                    tracing::warn!("[relay] caffeinate 启动失败(不影响隧道): {e}");
                }
            }
        }
        #[cfg(not(target_os = "macos"))]
        let _ = &self.keep_awake;
    }

    /// 释放系统保活断言(停止远程访问时恢复系统默认休眠策略)。
    fn release_awake(&self) {
        if let Ok(mut guard) = self.keep_awake.lock() {
            if let Some(mut child) = guard.take() {
                let _ = child.kill();
                let _ = child.wait();
                tracing::info!("[relay] 系统保活已释放");
            }
        }
    }

    pub async fn start(&self, url: String, token: String, local_proxy_url: String) {
        let mut task_guard = self.task.lock().await;
        // 停止旧隧道
        if let Some(old) = task_guard.take() {
            old.abort();
        }
        self.connected.store(false, Ordering::Relaxed);
        if let Ok(mut guard) = self.last_error.lock() {
            *guard = None;
        }

        let config = TunnelClientConfig {
            relay_url: url,
            token,
            local_proxy_url,
        };
        self.hold_awake();
        let config_clone = config.clone();
        let connected_flag = self.connected.clone();
        let last_error = self.last_error.clone();
        let p2p = self.p2p.clone();

        *task_guard = Some(tokio::spawn(async move {
            run_tunnel_client(config, connected_flag, last_error, p2p).await;
        }));

        let mut cfg_guard = self.config.lock().await;
        *cfg_guard = Some(config_clone);
    }

    /// 启动隧道并等待初始连接结果(最多 8 秒)。
    /// 返回 (connected, error):连接成功 → (true, None);
    /// 连接失败 → (false, Some(msg));超时未决 → (false, None)。
    pub async fn start_and_wait(&self, url: String, token: String, local_proxy_url: String) -> (bool, Option<String>) {
        self.start(url, token, local_proxy_url).await;
        // 轮询等待初始连接结果。
        // WS 超时 5s,这里等 8s 足够覆盖:正常连接 1-2s,失败 5s 报错,加余量。
        for _ in 0..80 {
            if self.is_connected() {
                return (true, None);
            }
            if let Some(err) = self.last_error() {
                return (false, Some(err));
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        (false, None)
    }

    pub async fn stop(&self) {
        let mut task_guard = self.task.lock().await;
        if let Some(old) = task_guard.take() {
            old.abort();
        }
        self.release_awake();
        self.connected.store(false, Ordering::Relaxed);
        if let Ok(mut guard) = self.last_error.lock() {
            *guard = None;
        }
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

    /// 最近一次连接错误(连接成功后为 None)。
    pub fn last_error(&self) -> Option<String> {
        self.last_error.lock().ok().and_then(|g| g.clone())
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

pub async fn start_relay(
    State(state): State<crate::serve::AppState>,
    Json(body): Json<StartRelayBody>,
) -> Json<RelayStatus> {
    let local = body
        .local_proxy_url
        .unwrap_or_else(|| format!("http://127.0.0.1:{}", state.local_port));

    tracing::info!("[relay] start_relay 收到请求: url={}", body.url);

    let test_config = TunnelClientConfig {
        relay_url: body.url.clone(),
        token: body.token.clone(),
        local_proxy_url: local.clone(),
    };
    match test_connection(&test_config).await {
    Ok(()) => {
        tracing::info!("[relay] 试连成功,启动后台隧道循环");
        state.relay.p2p.reset(Some(local.clone()));
        state.relay.start(body.url, body.token, local).await;
            Json(RelayStatus {
                running: true,
                connected: true,
                error: None,
            })
        }
        Err(e) => {
            tracing::error!("[relay] 试连失败: {e}");
            Json(RelayStatus {
                running: false,
                connected: false,
                error: Some(e),
            })
        }
    }
}

pub async fn stop_relay(
    State(state): State<crate::serve::AppState>,
) -> Json<RelayStatus> {
    state.relay.p2p.reset(None);
    state.relay.stop().await;
    Json(RelayStatus {
        running: false,
        connected: false,
        error: None,
    })
}

pub async fn relay_status(
    State(state): State<crate::serve::AppState>,
) -> Json<RelayStatus> {
    Json(RelayStatus {
        running: state.relay.is_running().await,
        connected: state.relay.is_connected(),
        error: state.relay.last_error(),
    })
}

#[derive(Serialize)]
pub struct P2pStatus {
    /// 隧道是否已连接(P2P 信令依赖隧道)。
    pub enabled: bool,
    /// 当前在线的 WebRTC 会话数。
    pub connected: usize,
}

/// GET /v1/p2p/status:WebRTC P2P 直连状态。
pub async fn p2p_status(State(state): State<crate::serve::AppState>) -> Json<P2pStatus> {
    let (enabled, connected) = state.relay.p2p.status();
    Json(P2pStatus { enabled, connected })
}
