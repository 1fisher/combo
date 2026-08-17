//! WebRTC P2P 直连:移动端经中转服务器交换信令,与桌面端建立 WebRTC
//! DataChannel,HTTP/SSE 请求直接走 P2P 通道,不再经中转转发。
//!
//! 协商流程(桌面端为 answer 方,非 trickle ICE):
//! 1. 移动端页面通过中转的 `/v1/relay/signal?token=` WS 发送 offer;
//! 2. 中转透传为 `TunnelMsg::Signal`,由隧道读循环交给 [`P2pManager`];
//! 3. 桌面端创建 PeerConnection + answer,等待 ICE 收集完成后回传;
//! 4. DataChannel 打开后,移动端把 HTTP 请求编码为 JSON 帧直发桌面端,
//!    桌面端执行后流式回传(SSE 同样支持)。
//!
//! DataChannel 单消息上限 16KB:请求体分片发送(`Body` 帧),响应分片
//! ≤8KB(见 `tunnel::execute_request`),base64 后仍在限制内。
//!
//! 失败/断开时移动端自动回退中转隧道,不影响可用性。

use crate::tunnel::{ExecEvent, execute_request};
use base64::Engine;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;
use webrtc::data_channel::{DataChannel, DataChannelEvent};
use webrtc::peer_connection::{
    MediaEngine, PeerConnection, PeerConnectionBuilder, PeerConnectionEventHandler, Registry,
    RTCConfigurationBuilder, RTCIceGatheringState, RTCIceServer, RTCPeerConnectionState,
    RTCSessionDescription, register_default_interceptors,
};
use webrtc::runtime::default_runtime;

/// 信令回传:桌面端 → 中转 → 移动端(id 为信令会话标识,data 为信令 JSON)。
pub type EmitSignal = Arc<dyn Fn(&str, &str) + Send + Sync>;

/// STUN 服务器列表(可通过 COMBO_STUN_URLS 覆盖,逗号分隔)。
fn stun_servers() -> Vec<RTCIceServer> {
    let raw = std::env::var("COMBO_STUN_URLS")
        .unwrap_or_else(|_| "stun:stun.l.google.com:19302".to_string());
    let urls: Vec<String> = raw
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    vec![RTCIceServer {
        urls,
        ..Default::default()
    }]
}

/// 信令负载(信令 WS / Signal 消息中承载的 JSON)。
#[derive(Serialize, Deserialize, Debug)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum SignalPayload {
    Offer {
        sdp: RTCSessionDescription,
    },
    Answer {
        sdp: RTCSessionDescription,
    },
    Error {
        message: String,
    },
    Closed,
}

/// DataChannel 线路帧(JSON 文本,双方共用)。
#[derive(Serialize, Deserialize, Debug)]
#[serde(tag = "t", rename_all = "snake_case")]
pub(crate) enum DcFrame {
    /// 移动端 → 桌面端:HTTP 请求(body 为 base64;more=true 表示还有分片)。
    Req {
        id: String,
        method: String,
        path: String,
        query: String,
        headers: HashMap<String, String>,
        #[serde(default)]
        body: Option<String>,
        #[serde(default)]
        more: bool,
    },
    /// 移动端 → 桌面端:请求体分片(last=true 时结束)。
    Body {
        id: String,
        d: String,
        last: bool,
    },
    /// 移动端 → 桌面端:取消请求(丢弃未完成的分片)。
    Cancel {
        id: String,
    },
    Ping,
    // ---- 桌面端 → 移动端 ----
    Start {
        id: String,
        status: u16,
        headers: HashMap<String, String>,
    },
    Chunk {
        id: String,
        d: String,
    },
    End {
        id: String,
    },
    Err {
        id: String,
        status: u16,
        message: String,
    },
    Pong,
}

/// 单条 DataChannel 帧内 base64 负载上限(16KB 消息限制留余量,前端同样遵守)。
#[allow(dead_code)]
const FRAME_B64_MAX: usize = 12 * 1024;

/// P2P 会话事件(actor 输入)。
enum SessionIn {
    /// 中转发来的信令数据。
    Signal(String),
    /// ICE 收集完成(可以回传 answer)。
    GatherComplete,
    PeerState(RTCPeerConnectionState),
    /// 收到对端创建的 DataChannel(携带引用,actor 用它回传响应帧)。
    DcReady(Arc<dyn DataChannel>),
    DcFrame(String),
    DcClosed,
}

/// 未凑齐请求体的分片请求。
struct PendingReq {
    method: String,
    path: String,
    query: String,
    headers: HashMap<String, String>,
    buf: Vec<u8>,
}

/// 会话内部状态。
struct SessionState {
    pc: Option<Arc<dyn PeerConnection>>,
    dc: Option<Arc<dyn DataChannel>>,
    pending: HashMap<String, PendingReq>,
}

/// P2P 管理器:跟踪全部信令会话,随隧道生命周期启停。
pub struct P2pManager {
    inner: std::sync::Mutex<Option<ManagerInner>>,
    connected_peers: Arc<AtomicUsize>,
}

struct ManagerInner {
    local_proxy_url: String,
    sessions: HashMap<String, mpsc::UnboundedSender<SessionIn>>,
}

impl P2pManager {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            inner: std::sync::Mutex::new(None),
            connected_peers: Arc::new(AtomicUsize::new(0)),
        })
    }

    /// 隧道启动/停止时重置(local 为 None 表示停止,关闭全部会话)。
    pub fn reset(&self, local: Option<String>) {
        let old = {
            let mut guard = self.inner.lock().unwrap();
            let old = guard.take();
            if let Some(url) = local {
                *guard = Some(ManagerInner {
                    local_proxy_url: url,
                    sessions: HashMap::new(),
                });
            }
            old
        };
        if let Some(mut inner) = old {
            for (_, tx) in inner.sessions.drain() {
                let _ = tx.send(closed_signal_in());
            }
        }
    }

    /// 隧道断开:关闭全部会话(信令通道已失效)。
    pub async fn clear(&self) {
        self.reset(None);
    }

    /// 状态:(启用, 在线会话数)。供 `/v1/p2p/status` 与前端展示。
    pub fn status(&self) -> (bool, usize) {
        let enabled = self.inner.lock().unwrap().is_some();
        (enabled, self.connected_peers.load(Ordering::Relaxed))
    }

    /// 处理一条信令:首次出现时创建会话 actor,后续信令直接入队。
    pub async fn handle_signal(&self, id: String, data: String, emit: EmitSignal) {
        let (tx, rx, local_proxy_url) = {
            let mut guard = self.inner.lock().unwrap();
            let Some(inner) = guard.as_mut() else {
                let _ = emit(&id, &error_signal("P2P 未启用(隧道未连接)"));
                return;
            };
            let local = inner.local_proxy_url.clone();
            match inner.sessions.get(&id) {
                Some(tx) => (tx.clone(), None, local),
                None => {
                    let (tx, rx) = mpsc::unbounded_channel();
                    inner.sessions.insert(id.clone(), tx.clone());
                    (tx.clone(), Some(rx), local)
                }
            }
        };
        if let Some(rx) = rx {
            let peers = self.connected_peers.clone();
            // handler_tx:PeerConnection handler 注入事件的通道(与主通道同源,保序)
            let handler_tx = tx.clone();
            tokio::spawn(session_actor(
                id.clone(),
                local_proxy_url,
                rx,
                handler_tx,
                emit,
                peers,
            ));
        }
        let _ = tx.send(SessionIn::Signal(data));
    }
}

fn closed_signal_in() -> SessionIn {
    SessionIn::Signal(serde_json::to_string(&SignalPayload::Closed).unwrap_or_default())
}

fn error_signal(message: &str) -> String {
    serde_json::to_string(&SignalPayload::Error {
        message: message.to_string(),
    })
    .unwrap_or_default()
}

/// PeerConnection 事件 → 会话 actor 通道。
struct PeerHandler {
    tx: mpsc::UnboundedSender<SessionIn>,
}

#[async_trait::async_trait]
impl PeerConnectionEventHandler for PeerHandler {
    async fn on_ice_gathering_state_change(&self, state: RTCIceGatheringState) {
        if state == RTCIceGatheringState::Complete {
            let _ = self.tx.send(SessionIn::GatherComplete);
        }
    }

    async fn on_connection_state_change(&self, state: RTCPeerConnectionState) {
        let _ = self.tx.send(SessionIn::PeerState(state));
    }

    async fn on_data_channel(&self, dc: Arc<dyn DataChannel>) {
        let _ = self.tx.send(SessionIn::DcReady(dc.clone()));
        let tx = self.tx.clone();
        // 必须立即返回(spawn),阻塞会拖住 webrtc 内部 driver。
        tokio::spawn(async move {
            loop {
                match dc.poll().await {
                    Some(DataChannelEvent::OnMessage(msg)) => {
                        let text = String::from_utf8_lossy(&msg.data).into_owned();
                        let _ = tx.send(SessionIn::DcFrame(text));
                    }
                    Some(DataChannelEvent::OnClose) | None => {
                        let _ = tx.send(SessionIn::DcClosed);
                        break;
                    }
                    _ => {}
                }
            }
        });
    }
}

/// 会话 actor:串行处理信令与 DataChannel 帧,保证同会话内顺序确定。
async fn session_actor(
    id: String,
    local_proxy_url: String,
    mut rx: mpsc::UnboundedReceiver<SessionIn>,
    handler_tx: mpsc::UnboundedSender<SessionIn>,
    emit: EmitSignal,
    peers: Arc<AtomicUsize>,
) {
    let mut state = SessionState {
        pc: None,
        dc: None,
        pending: HashMap::new(),
    };
    let mut answered = false;
    let mut connected = false;
    let mut done = false;

    while let Some(evt) = rx.recv().await {
        match evt {
            SessionIn::Signal(data) => {
                let payload: SignalPayload = match serde_json::from_str(&data) {
                    Ok(p) => p,
                    Err(e) => {
                        let _ = emit(&id, &error_signal(&format!("信令解析失败: {e}")));
                        continue;
                    }
                };
                match payload {
                    SignalPayload::Offer { sdp } if !answered => {
                        answered = true;
                        if let Err(e) =
                            handle_offer(&id, &emit, &mut state, sdp, &mut rx, &handler_tx, &local_proxy_url)
                                .await
                        {
                            let _ = emit(&id, &error_signal(&format!("协商失败: {e}")));
                            done = true;
                        }
                    }
                    SignalPayload::Offer { .. } | SignalPayload::Answer { .. } => {}
                    SignalPayload::Error { .. } | SignalPayload::Closed => {
                        done = true;
                    }
                }
            }
            SessionIn::GatherComplete => {}
            SessionIn::PeerState(s) => {
                if matches!(
                    s,
                    RTCPeerConnectionState::Failed | RTCPeerConnectionState::Closed
                ) {
                    done = true;
                }
            }
            SessionIn::DcReady(dc) => {
                if state.dc.is_none() {
                    state.dc = Some(dc);
                    if !connected {
                        connected = true;
                        peers.fetch_add(1, Ordering::Relaxed);
                        tracing::info!("[p2p] DataChannel 已建立: {}", &id[..id.len().min(8)]);
                    }
                }
            }
            SessionIn::DcFrame(text) => {
                handle_dc_frame(&local_proxy_url, &mut state, text).await;
            }
            SessionIn::DcClosed => {
                done = true;
            }
        }
        if done {
            break;
        }
    }

    if connected {
        peers.fetch_sub(1, Ordering::Relaxed);
    }
    if let Some(dc) = state.dc.take() {
        let _ = dc.close().await;
    }
    if let Some(pc) = state.pc.take() {
        let _ = pc.close().await;
    }
    // 通知移动端:会话已关闭(触发其回退中转)
    let _ = emit(
        &id,
        &serde_json::to_string(&SignalPayload::Closed).unwrap_or_default(),
    );
    tracing::info!("[p2p] 会话结束: {}", &id[..id.len().min(8)]);
}

/// 处理 offer:建 PeerConnection → answer → 等 ICE 收齐 → 回传 answer。
/// 等待期间到达的 DataChannel 帧/信令缓存回放,不丢事件。
async fn handle_offer(
    id: &str,
    emit: &EmitSignal,
    state: &mut SessionState,
    offer: RTCSessionDescription,
    rx: &mut mpsc::UnboundedReceiver<SessionIn>,
    handler_tx: &mpsc::UnboundedSender<SessionIn>,
    local_proxy_url: &str,
) -> anyhow::Result<()> {
    let mut media = MediaEngine::default();
    media.register_default_codecs()?;
    let registry = register_default_interceptors(Registry::new(), &mut media)?;
    let runtime = default_runtime().ok_or_else(|| anyhow::anyhow!("webrtc runtime 不可用"))?;

    let pc = PeerConnectionBuilder::new()
        .with_configuration(RTCConfigurationBuilder::new().with_ice_servers(stun_servers()).build())
        .with_media_engine(media)
        .with_interceptor_registry(registry)
        .with_handler(Arc::new(PeerHandler {
            tx: handler_tx.clone(),
        }))
        .with_runtime(runtime)
        .with_udp_addrs(vec!["0.0.0.0:0"])
        .build()
        .await?;
    let pc: Arc<dyn PeerConnection> = Arc::new(pc);

    pc.set_remote_description(offer).await?;
    let answer = pc.create_answer(None).await?;
    pc.set_local_description(answer).await?;

    // 非 trickle:等 ICE 收集完成再回传 answer(最多 5s,超时也回传已有候选)。
    // 等待期间可能收到 DcReady / DcFrame / 新信令:缓存或就地处理,保证不丢。
    let mut replay: Vec<SessionIn> = Vec::new();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        let evt = match tokio::time::timeout_at(deadline, rx.recv()).await {
            Ok(evt) => evt,
            Err(_) => break, // 超时:按已有候选回传
        };
        match evt {
            Some(SessionIn::GatherComplete) | None => break,
            Some(SessionIn::PeerState(s)) => {
                if matches!(
                    s,
                    RTCPeerConnectionState::Failed | RTCPeerConnectionState::Closed
                ) {
                    anyhow::bail!("连接状态: {s:?}");
                }
            }
            Some(SessionIn::DcReady(dc)) => {
                if state.dc.is_none() {
                    state.dc = Some(dc);
                }
            }
            Some(other) => replay.push(other),
        }
    }

    let local = pc
        .local_description()
        .await
        .ok_or_else(|| anyhow::anyhow!("本地描述未就绪"))?;
    state.pc = Some(pc);
    let _ = emit(
        id,
        &serde_json::to_string(&SignalPayload::Answer { sdp: local }).unwrap_or_default(),
    );
    tracing::info!("[p2p] answer 已回传: {}", &id[..id.len().min(8)]);

    // 回放等待期间缓存的事件(信令/帧)
    for evt in replay {
        match evt {
            SessionIn::Signal(data) => {
                let _ = handler_tx.send(SessionIn::Signal(data));
            }
            SessionIn::DcFrame(text) => {
                handle_dc_frame(local_proxy_url, state, text).await;
            }
            _ => {}
        }
    }
    Ok(())
}

/// 处理一条 DataChannel 帧:ping 应答 / 请求分发 / 请求体分片 / 取消。
async fn handle_dc_frame(local_proxy_url: &str, state: &mut SessionState, text: String) {
    let frame: DcFrame = match serde_json::from_str(&text) {
        Ok(f) => f,
        Err(e) => {
            tracing::warn!("[p2p] 帧解析失败: {e}");
            return;
        }
    };
    match frame {
        DcFrame::Ping => {
            if let Some(dc) = &state.dc {
                let _ = dc
                    .send_text(&serde_json::to_string(&DcFrame::Pong).unwrap_or_default())
                    .await;
            }
        }
        DcFrame::Req {
            id,
            method,
            path,
            query,
            headers,
            body,
            more,
        } => {
            let body_bytes = body
                .and_then(|b64| base64::engine::general_purpose::STANDARD.decode(&b64).ok());
            if more {
                state.pending.insert(
                    id,
                    PendingReq {
                        method,
                        path,
                        query,
                        headers,
                        buf: body_bytes.unwrap_or_default(),
                    },
                );
                return;
            }
            dispatch_request(local_proxy_url, state, id, method, path, query, headers, body_bytes);
        }
        DcFrame::Body { id, d, last } => {
            let Some(mut req) = state.pending.remove(&id) else {
                return;
            };
            if let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(&d) {
                req.buf.extend_from_slice(&bytes);
            }
            if last {
                let PendingReq {
                    method,
                    path,
                    query,
                    headers,
                    buf,
                } = req;
                dispatch_request(local_proxy_url, state, id, method, path, query, headers, Some(buf));
            } else {
                state.pending.insert(id, req);
            }
        }
        DcFrame::Cancel { id } => {
            state.pending.remove(&id);
        }
        DcFrame::Start { .. }
        | DcFrame::Chunk { .. }
        | DcFrame::End { .. }
        | DcFrame::Err { .. }
        | DcFrame::Pong => {}
    }
}

/// 分发请求:spawn execute_request,事件映射为 DcFrame 回传。
fn dispatch_request(
    local_proxy_url: &str,
    state: &SessionState,
    id: String,
    method: String,
    path: String,
    query: String,
    headers: HashMap<String, String>,
    body: Option<Vec<u8>>,
) {
    let Some(dc) = state.dc.clone() else {
        return;
    };
    let (ev_tx, mut ev_rx) = mpsc::unbounded_channel::<ExecEvent>();
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .tcp_keepalive(Some(Duration::from_secs(60)))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap_or_default();
    let local = local_proxy_url.to_string();
    tokio::spawn(execute_request(
        client,
        local,
        method,
        path,
        query,
        headers,
        body,
        ev_tx,
    ));
    tokio::spawn(async move {
        while let Some(ev) = ev_rx.recv().await {
            let frame = match ev {
                ExecEvent::Start { status, headers } => DcFrame::Start {
                    id: id.clone(),
                    status,
                    headers,
                },
                ExecEvent::Chunk(bytes) => DcFrame::Chunk {
                    id: id.clone(),
                    d: base64::engine::general_purpose::STANDARD.encode(bytes),
                },
                ExecEvent::End => DcFrame::End { id: id.clone() },
                ExecEvent::Error { status, message } => DcFrame::Err {
                    id: id.clone(),
                    status,
                    message,
                },
            };
            if dc.send_text(&serde_json::to_string(&frame).unwrap_or_default())
                .await
                .is_err()
            {
                break;
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dc_frame_serde_roundtrip() {
        let f = DcFrame::Req {
            id: "r1".into(),
            method: "GET".into(),
            path: "/v1/health".into(),
            query: String::new(),
            headers: HashMap::new(),
            body: None,
            more: false,
        };
        let json = serde_json::to_string(&f).unwrap();
        assert!(json.contains("\"t\":\"req\""));
        let back: DcFrame = serde_json::from_str(&json).unwrap();
        match back {
            DcFrame::Req {
                id,
                method,
                path,
                body,
                more,
                ..
            } => {
                assert_eq!(id, "r1");
                assert_eq!(method, "GET");
                assert_eq!(path, "/v1/health");
                assert!(body.is_none());
                assert!(!more);
            }
            _ => panic!("类型错误"),
        }
    }

    #[test]
    fn signal_payload_closed_roundtrip() {
        let json = serde_json::to_string(&SignalPayload::Closed).unwrap();
        assert!(json.contains("\"kind\":\"closed\""));
        let back: SignalPayload = serde_json::from_str(&json).unwrap();
        assert!(matches!(back, SignalPayload::Closed));
    }

    #[test]
    fn stun_urls_parse_from_env_shape() {
        let servers = stun_servers();
        assert!(!servers.is_empty());
        assert!(!servers[0].urls.is_empty());
    }

    /// 分片协议冒烟:Req(more) + Body(last) 组装语义(纯数据结构层)。
    #[test]
    fn frame_b64_limit_kept_under_dc_message_cap() {
        assert!(FRAME_B64_MAX < 16 * 1024);
    }
}
