use crate::protocol::{DesktopMsg, TunnelMsg};
use axum::body::Body;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, Request, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use base64::Engine;
use dashmap::DashMap;
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{mpsc, oneshot};
use tracing::{error, info, warn};

/// 浏览器侧 WS 隧道事件(中转 → 浏览器 WS)。
pub enum WsTunnelEvent {
    Data(Vec<u8>, bool),
    Close,
}

/// 中转服务器共享状态。
#[derive(Clone, Default)]
pub struct RelayState {
    /// token → 隧道连接(每个桌面客户端一个)
    /// DashMap 支持并发读写,无需手动加锁。
    pub tunnels: Arc<DashMap<String, TunnelHandle>>,
}

/// 一条已建立的隧道(桌面客户端的 WebSocket 连接)。
pub struct TunnelHandle {
    /// 向桌面客户端 WebSocket 发送消息的通道。
    pub tx: mpsc::UnboundedSender<TunnelMsg>,
    /// 待响应的请求:request_id → 响应通道。
    pub pending: Arc<DashMap<String, PendingResponse>>,
    /// 活跃的 WS 隧道:id → 浏览器 WS 发送通道。
    pub pending_ws: Arc<DashMap<String, mpsc::UnboundedSender<WsTunnelEvent>>>,
}

/// 待响应的 HTTP 请求(中转端等待桌面客户端的响应)。
pub struct PendingResponse {
    /// 响应状态和头的 oneshot(收到 ResponseStart 时触发)。
    pub headers_tx: std::sync::Mutex<Option<oneshot::Sender<(u16, HashMap<String, String>)>>>,
    /// 响应体分块通道(收到 ResponseChunk 时推入,ResponseEnd 时关闭)。
    pub body_tx: mpsc::Sender<Result<bytes::Bytes, std::io::Error>>,
}

#[derive(Deserialize)]
pub struct TunnelQuery {
    pub token: String,
}

/// WebSocket 升级:桌面客户端建立隧道。
///
/// 路由: `GET /v1/relay/tunnel?token=<access_token>`
pub async fn ws_tunnel_handler(
    ws: WebSocketUpgrade,
    Query(query): Query<TunnelQuery>,
    State(state): State<RelayState>,
) -> Response {
    ws.on_upgrade(move |socket| tunnel_task(state, query.token, socket))
}

/// 隧道任务:管理一条桌面客户端 WebSocket 连接。
async fn tunnel_task(state: RelayState, token: String, socket: WebSocket) {
    let (mut ws_sink, mut ws_stream) = socket.split();

    // 为这条隧道创建发送通道
    let (tx, mut rx) = mpsc::unbounded_channel::<TunnelMsg>();
    let pending = Arc::new(DashMap::new());
    let pending_ws: Arc<DashMap<String, mpsc::UnboundedSender<WsTunnelEvent>>> =
        Arc::new(DashMap::new());

    let handle = TunnelHandle {
        tx,
        pending: pending.clone(),
        pending_ws: pending_ws.clone(),
    };

    // 注册隧道(覆盖同 token 旧连接)
    if state.tunnels.contains_key(&token) {
        info!("隧道重连,覆盖旧连接: token={:.8}", token);
    }
    state.tunnels.insert(token.clone(), handle);
    info!("隧道已建立: token={:.8}", token);

    // 发送循环:从通道读取消息,写入 WebSocket
    let send_task = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            let json = match serde_json::to_string(&msg) {
                Ok(j) => j,
                Err(e) => {
                    error!("序列化隧道消息失败: {e}");
                    continue;
                }
            };
            if ws_sink.send(Message::Text(json)).await.is_err() {
                break;
            }
        }
    });

    // 接收循环:从 WebSocket 读取桌面客户端的响应,分发给待响应请求
    while let Some(msg) = ws_stream.next().await {
        let msg = match msg {
            Ok(Message::Text(t)) => t,
            Ok(Message::Close(_)) | Err(_) => break,
            _ => continue,
        };

        let dm: DesktopMsg = match serde_json::from_str(&msg) {
            Ok(m) => m,
            Err(e) => {
                warn!("无法解析桌面消息: {e}");
                continue;
            }
        };

        match dm {
            DesktopMsg::ResponseStart {
                id,
                status,
                headers,
            } => {
                if let Some(entry) = pending.get(&id) {
                    let mut guard = entry.headers_tx.lock().unwrap();
                    if let Some(tx) = guard.take() {
                        let _ = tx.send((status, headers));
                    }
                }
            }
            DesktopMsg::ResponseChunk { id, body } => {
                if let Some(entry) = pending.get(&id) {
                    let bytes = base64::engine::general_purpose::STANDARD
                        .decode(&body)
                        .unwrap_or_default();
                    let _ = entry.body_tx.send(Ok(bytes::Bytes::from(bytes))).await;
                }
            }
            DesktopMsg::ResponseEnd { id } => {
                drop(pending.get(&id)); // 先释放 DashMap 引用
                pending.remove(&id);
            }
            DesktopMsg::ResponseError {
                id,
                status,
                message,
            } => {
                if let Some(entry) = pending.get(&id) {
                    {
                        let mut guard = entry.headers_tx.lock().unwrap();
                        if let Some(tx) = guard.take() {
                            let _ = tx.send((status, HashMap::from([(
                                header::CONTENT_TYPE.to_string(),
                                "application/json".into(),
                            )])));
                        }
                    }
                    let body = serde_json::json!({ "message": message }).to_string();
                    let _ = entry
                        .body_tx
                        .send(Ok(bytes::Bytes::from(body)))
                        .await;
                }
                drop(pending.get(&id));
                pending.remove(&id);
            }
            DesktopMsg::WsData { id, data, binary } => {
                if let Some(entry) = pending_ws.get(&id) {
                    let decoded = base64::engine::general_purpose::STANDARD
                        .decode(&data)
                        .unwrap_or_default();
                    let _ = entry.send(WsTunnelEvent::Data(decoded, binary));
                }
            }
            DesktopMsg::WsClose { id } => {
                if let Some(entry) = pending_ws.get(&id) {
                    let _ = entry.send(WsTunnelEvent::Close);
                }
                pending_ws.remove(&id);
            }
            DesktopMsg::WsError { id, message: _ } => {
                if let Some(entry) = pending_ws.get(&id) {
                    let _ = entry.send(WsTunnelEvent::Close);
                }
                pending_ws.remove(&id);
            }
        }
    }

    // 清理
    send_task.abort();
    // 关闭所有浏览器侧 WS 隧道
    for entry in pending_ws.iter() {
        let _ = entry.send(WsTunnelEvent::Close);
    }
    pending_ws.clear();
    state.tunnels.remove(&token);
    info!("隧道已断开: token={:.8}", token);
}

/// HTTP 转发:将请求通过隧道发送到桌面客户端。
///
/// 这是 relay 的核心 fallback handler:
/// 1. 从 Authorization header 或 ?token= 提取令牌
/// 2. 查找对应的隧道
/// 3. 将请求编码为 TunnelMsg 发送
/// 4. 等待桌面客户端的响应(支持流式 SSE)
pub async fn tunnel_forward(
    State(state): State<RelayState>,
    req: Request,
) -> Response {
    // 提取令牌(Authorization Bearer 或 query ?token=)
    let token = extract_token(&req);
    let token = match token {
        Some(t) => t,
        None => {
            return (
                StatusCode::UNAUTHORIZED,
                "{\"message\":\"缺少访问令牌\"}",
            )
                .into_response();
        }
    };

    // 查找隧道
    let handle = match state.tunnels.get(&token) {
        Some(h) => h,
        None => {
            return (
                StatusCode::BAD_GATEWAY,
                "{\"message\":\"桌面客户端未连接\"}",
            )
                .into_response();
        }
    };

    // 分配请求 ID
    let id = uuid::Uuid::new_v4().to_string();

    // 创建响应通道
    let (headers_tx, headers_rx) = oneshot::channel();
    let (body_tx, body_rx) = mpsc::channel::<Result<bytes::Bytes, std::io::Error>>(64);

    handle.pending.insert(
        id.clone(),
        PendingResponse {
            headers_tx: std::sync::Mutex::new(Some(headers_tx)),
            body_tx: body_tx.clone(),
        },
    );

    // 构造隧道请求消息
    let (parts, body) = req.into_parts();
    let body_bytes = axum::body::to_bytes(body, 1024 * 1024 * 16).await; // 16MB 上限
    let body_b64 = match body_bytes {
        Ok(b) if !b.is_empty() => Some(
            base64::engine::general_purpose::STANDARD.encode(&b),
        ),
        _ => None,
    };

    let mut headers_map = HashMap::new();
    for (k, v) in parts.headers.iter() {
        if let Ok(s) = v.to_str() {
            headers_map.insert(k.as_str().to_string(), s.to_string());
        }
    }

    let tunnel_req = TunnelMsg::Request {
        id: id.clone(),
        method: parts.method.to_string(),
        path: parts.uri.path().to_string(),
        query: parts.uri.query().unwrap_or("").to_string(),
        headers: headers_map,
        body: body_b64,
    };

    // 发送到桌面客户端
    if handle.tx.send(tunnel_req).is_err() {
        drop(state.tunnels.get(&token));
        return (
            StatusCode::BAD_GATEWAY,
            "{\"message\":\"隧道已断开\"}",
        )
            .into_response();
    }

    drop(handle); // 释放 DashMap 读锁

    // 等待响应头
    let (status, resp_headers) = match headers_rx.await {
        Ok(v) => v,
        Err(_) => {
            return (
                StatusCode::GATEWAY_TIMEOUT,
                "{\"message\":\"等待桌面客户端响应超时\"}",
            )
                .into_response();
        }
    };

    // 构建 axum 响应:将 body_rx 转为 Stream Body(支持 SSE 流式)
    let stream = tokio_stream::wrappers::ReceiverStream::new(body_rx);
    let body = Body::from_stream(stream);

    let mut response = Response::builder().status(StatusCode::from_u16(status).unwrap_or(StatusCode::OK));
    for (k, v) in &resp_headers {
        // 跳过 transfer-encoding 和 content-length(axum 会自动处理)
        let lower = k.to_lowercase();
        if lower == "transfer-encoding" || lower == "content-length" {
            continue;
        }
        if let Ok(name) = axum::http::HeaderName::from_bytes(k.as_bytes()) {
            if let Ok(val) = axum::http::HeaderValue::from_str(v) {
                response = response.header(name, val);
            }
        }
    }

    // 丢弃 pending 中残留的 body_tx(如果 ResponseEnd 已经 remove 了 entry,这里只是清理)
    drop(body_tx);

    response.body(body).unwrap_or_else(|_| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "{\"message\":\"响应构建失败\"}",
        )
            .into_response()
    })
}

/// 从请求中提取访问令牌。
fn extract_token(req: &Request) -> Option<String> {
    // 优先:Authorization: Bearer <token>
    if let Some(auth) = req.headers().get(header::AUTHORIZATION) {
        if let Ok(s) = auth.to_str() {
            if let Some(token) = s.strip_prefix("Bearer ") {
                return Some(token.to_string());
            }
        }
    }
    // 回退:?token=<token>
    if let Some(query) = req.uri().query() {
        for pair in query.split('&') {
            if let Some(rest) = pair.strip_prefix("token=") {
                return Some(rest.to_string());
            }
        }
    }
    None
}

/// 判断请求是否为 WebSocket 升级请求。
pub fn is_ws_upgrade(req: &Request) -> bool {
    req.headers()
        .get(header::UPGRADE)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.eq_ignore_ascii_case("websocket"))
        .unwrap_or(false)
}

/// WebSocket 隧道代理:将浏览器的 WS 连接通过隧道桥接到桌面客户端。
///
/// 流程:
/// 1. 提取令牌,查找隧道
/// 2. 生成唯一 id,向桌面客户端发送 WsUpgrade
/// 3. 注册 pending_ws 条目,桥接双向数据
/// 4. 浏览器 WS 数据 → WsData 消息 → 桌面客户端
/// 5. 桌面客户端 WsData/WsClose → pending_ws → 浏览器 WS
pub async fn ws_proxy_handler(
    State(state): State<RelayState>,
    ws: WebSocketUpgrade,
    req: Request,
) -> Response {
    let token = match extract_token(&req) {
        Some(t) => t,
        None => return StatusCode::UNAUTHORIZED.into_response(),
    };

    let handle = match state.tunnels.get(&token) {
        Some(h) => h,
        None => return StatusCode::BAD_GATEWAY.into_response(),
    };

    let id = uuid::Uuid::new_v4().to_string();

    // 注册 pending_ws
    let (ws_event_tx, ws_event_rx) = mpsc::unbounded_channel::<WsTunnelEvent>();
    handle.pending_ws.insert(id.clone(), ws_event_tx);

    // 发送 WsUpgrade 到桌面客户端
    let mut headers_map = HashMap::new();
    for (k, v) in req.headers().iter() {
        let lower = k.as_str().to_lowercase();
        if lower == "upgrade" || lower == "connection" || lower == "host"
            || lower == "sec-websocket-key" || lower == "sec-websocket-version"
            || lower == "sec-websocket-extensions"
        {
            continue;
        }
        if let Ok(s) = v.to_str() {
            headers_map.insert(k.as_str().to_string(), s.to_string());
        }
    }

    let ws_upgrade_msg = TunnelMsg::WsUpgrade {
        id: id.clone(),
        path: req.uri().path().to_string(),
        query: req.uri().query().unwrap_or("").to_string(),
        headers: headers_map,
    };

    if handle.tx.send(ws_upgrade_msg).is_err() {
        drop(handle);
        state.tunnels.get(&token).map(|h| h.pending_ws.remove(&id));
        return StatusCode::BAD_GATEWAY.into_response();
    }

    let tunnel_tx = handle.tx.clone();
    let id_for_close = id.clone();
    let pending_ws = handle.pending_ws.clone();

    drop(handle);

    ws.on_upgrade(move |socket| async move {
        let (socket_sink, socket_stream) = socket.split();
        ws_bridge(socket_sink, socket_stream, tunnel_tx, pending_ws, id_for_close, ws_event_rx).await;
    })
}

/// 双向桥接:浏览器 WS ↔ 隧道。
async fn ws_bridge(
    mut socket_sink: futures_util::stream::SplitSink<WebSocket, Message>,
    mut socket_stream: futures_util::stream::SplitStream<WebSocket>,
    tunnel_tx: mpsc::UnboundedSender<TunnelMsg>,
    pending_ws: Arc<DashMap<String, mpsc::UnboundedSender<WsTunnelEvent>>>,
    id: String,
    mut ws_event_rx: mpsc::UnboundedReceiver<WsTunnelEvent>,
) {
    let id_fwd = id.clone();
    let tunnel_tx_fwd = tunnel_tx.clone();

    // 任务:浏览器 WS → 隧道 → 桌面客户端
    let mut fwd_task = tokio::spawn(async move {
        while let Some(msg) = socket_stream.next().await {
            match msg {
                Ok(Message::Text(t)) => {
                    let data =
                        base64::engine::general_purpose::STANDARD.encode(t.as_bytes());
                    if tunnel_tx_fwd
                        .send(TunnelMsg::WsData {
                            id: id_fwd.clone(),
                            data,
                            binary: false,
                        })
                        .is_err()
                    {
                        break;
                    }
                }
                Ok(Message::Binary(b)) => {
                    let data = base64::engine::general_purpose::STANDARD.encode(&b);
                    if tunnel_tx_fwd
                        .send(TunnelMsg::WsData {
                            id: id_fwd.clone(),
                            data,
                            binary: true,
                        })
                        .is_err()
                    {
                        break;
                    }
                }
                Ok(Message::Close(_)) | Err(_) => {
                    let _ = tunnel_tx_fwd.send(TunnelMsg::WsClose {
                        id: id_fwd.clone(),
                    });
                    break;
                }
                Ok(_) => {} // ping/pong
            }
        }
    });

    // 任务:桌面客户端 → 隧道 → 浏览器 WS(读取 ws_event_rx)
    let mut bwd_task = tokio::spawn(async move {
        while let Some(event) = ws_event_rx.recv().await {
            match event {
                WsTunnelEvent::Data(data, binary) => {
                    if binary {
                        if socket_sink.send(Message::Binary(data.into())).await.is_err() {
                            break;
                        }
                    } else {
                        if socket_sink
                            .send(Message::Text(
                                String::from_utf8_lossy(&data).into_owned().into(),
                            ))
                            .await
                            .is_err()
                        {
                            break;
                        }
                    }
                }
                WsTunnelEvent::Close => {
                    let _ = socket_sink.send(Message::Close(None)).await;
                    break;
                }
            }
        }
    });

    // 等任一方向结束
    tokio::select! {
        _ = &mut fwd_task => {
            bwd_task.abort();
        }
        _ = &mut bwd_task => {
            fwd_task.abort();
        }
    }

    pending_ws.remove(&id);
}

/// 中转级隧道状态:检查指定 token 是否有已连接的隧道。
///
/// 路由: `GET /v1/relay/status?token=<access_token>`
/// 此端点由中转服务器直接处理(不经过隧道转发),供移动端验证隧道连通性。
pub async fn tunnel_status_handler(
    State(state): State<RelayState>,
    req: Request,
) -> Response {
    let token = extract_token(&req);
    let connected = match token {
        Some(ref t) => state.tunnels.contains_key(t),
        None => false,
    };
    let active_tunnels = state.tunnels.len();
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(
            serde_json::json!({
                "connected": connected,
                "active_tunnels": active_tunnels,
            })
            .to_string(),
        ))
        .unwrap()
}
