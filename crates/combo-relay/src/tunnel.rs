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

    let handle = TunnelHandle {
        tx,
        pending: pending.clone(),
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
        }
    }

    // 清理
    send_task.abort();
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
