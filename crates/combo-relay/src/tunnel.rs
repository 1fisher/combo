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
use std::time::Duration;
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

impl RelayState {
    /// 返回当前已连接的唯一一个隧道 token(用于 tunnel-all 单隧道模式)。
    /// 当恰好只有一条隧道时返回它;多条或无隧道时返回 None。
    pub fn single_tunnel_token(&self) -> Option<String> {
        if self.tunnels.len() == 1 {
            self.tunnels.iter().next().map(|e| e.key().clone())
        } else {
            None
        }
    }

    /// 是否有隧道在线。
    pub fn has_tunnel(&self) -> bool {
        !self.tunnels.is_empty()
    }

    /// 解析请求的目标隧道 token:
    /// 1. Authorization Bearer / ?token= / cookie → 精确匹配
    /// 2. 单隧道模式:自动选用唯一隧道
    pub fn resolve_token(&self, req: &Request) -> Option<String> {
        if let Some(t) = extract_token(req) {
            if self.tunnels.contains_key(&t) {
                return Some(t);
            }
        }
        // 单隧道模式:浏览器加载静态资源(无 Authorization header)时自动选用
        self.single_tunnel_token()
    }

    /// 移除指定 token 的隧道条目,仅当该条目属于本次连接(conn_id 匹配)。
    /// 同 token 快速重连时,旧连接的清理可能晚于新连接注册执行,
    /// 直接 remove 会误删新条目,导致中转端存在存活 WS 但 tunnels 表里
    /// 没有该 token,浏览器请求全部 502「桌面客户端未连接」。
    pub fn remove_tunnel_if_owned(&self, token: &str, conn_id: &str) {
        let is_mine = self
            .tunnels
            .get(token)
            .map(|h| h.conn_id == conn_id)
            .unwrap_or(false);
        if is_mine {
            self.tunnels.remove(token);
        }
    }
}

/// 一条已建立的隧道(桌面客户端的 WebSocket 连接)。
pub struct TunnelHandle {
    /// 本次连接的唯一标识(用于同 token 快速重连时区分新旧连接)。
    pub conn_id: String,
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

    let conn_id = uuid::Uuid::new_v4().to_string();
    let handle = TunnelHandle {
        conn_id: conn_id.clone(),
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

    // 发送循环:从通道读取消息,写入 WebSocket。
    // 同时每 30s 发送一次 Ping 保活,防止中转服务器/负载均衡/运营商
    // 因空闲超时断开长连接(桌面端收到 Ping 会自动回 Pong)。
    let mut ping_interval = tokio::time::interval(Duration::from_secs(30));
    ping_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    ping_interval.tick().await; // 消耗立即触发的首拍
    let send_task = tokio::spawn(async move {
        loop {
            tokio::select! {
                msg = rx.recv() => {
                    let Some(msg) = msg else { break };
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
                _ = ping_interval.tick() => {
                    if ws_sink.send(Message::Ping(Vec::new().into())).await.is_err() {
                        break;
                    }
                }
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
            DesktopMsg::WsError { id, message } => {
                warn!("桌面端 WS 连接失败: id={:.8} message={}", id, message);
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
    // 只移除属于本次连接的条目:同 token 快速重连时,旧连接的清理可能晚于
    // 新连接注册执行,直接 remove 会误删新条目,导致中转端存在存活 WS 但
    // tunnels 表里没有该 token,浏览器请求全部 502「桌面客户端未连接」。
    state.remove_tunnel_if_owned(&token, &conn_id);
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

/// HTTP 转发(tunnel-all 模式):使用 resolve_token(支持 cookie + 单隧道回退)。
///
/// 与 `tunnel_forward` 的区别:
/// - 支持从 cookie 中提取令牌(浏览器加载静态资源时自动携带)
/// - 单隧道模式下自动选用唯一已连接的隧道(无需在请求中显式携带令牌)
/// - 无隧道连接时返回「等待桌面端连接」的 HTML 页面
pub async fn tunnel_forward_all(
    State(state): State<RelayState>,
    req: Request,
) -> Response {
    // 检查 URL 中是否有 ?token=xxx(需要在响应中设置 cookie)
    let token_from_url = req
        .uri()
        .query()
        .map(|q| q.contains("token="))
        .unwrap_or(false);

    let token = match state.resolve_token(&req) {
        Some(t) => t,
        None => {
            // 无隧道连接:返回等待页面(HTML 请求)或错误(API 请求)
            let wants_html = req
                .headers()
                .get(header::ACCEPT)
                .and_then(|v| v.to_str().ok())
                .map(|v| v.contains("text/html"))
                .unwrap_or(false);
            if wants_html || req.uri().path() == "/" {
                return waiting_page();
            }
            return (
                StatusCode::BAD_GATEWAY,
                "{\"message\":\"桌面客户端未连接\"}",
            )
                .into_response();
        }
    };

    // 如果令牌来自 URL,记录下来用于设置 cookie
    let cookie_token = if token_from_url { Some(token.clone()) } else { None };

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
    let body_bytes = axum::body::to_bytes(body, 1024 * 1024 * 16).await;
    let body_b64 = match body_bytes {
        Ok(b) if !b.is_empty() => {
            Some(base64::engine::general_purpose::STANDARD.encode(&b))
        }
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
        drop(handle);
        return (
            StatusCode::BAD_GATEWAY,
            "{\"message\":\"隧道已断开\"}",
        )
            .into_response();
    }

    drop(handle);

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

    // 构建 axum 响应
    let stream = tokio_stream::wrappers::ReceiverStream::new(body_rx);
    let body = Body::from_stream(stream);

    let mut response = Response::builder()
        .status(StatusCode::from_u16(status).unwrap_or(StatusCode::OK));
    for (k, v) in &resp_headers {
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

    // 令牌来自 URL 时设置 cookie,后续静态资源请求自动携带
    if let Some(tok) = cookie_token {
        let cookie_val = format!(
            "combo.token={}; Path=/; Max-Age=604800; SameSite=Lax",
            tok
        );
        if let Ok(val) = axum::http::HeaderValue::from_str(&cookie_val) {
            response = response.header("set-cookie", val);
        }
    }

    drop(body_tx);

    response.body(body).unwrap_or_else(|_| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "{\"message\":\"响应构建失败\"}",
        )
            .into_response()
    })
}

/// 「等待桌面端连接」HTML 页面:隧道未建立时给浏览器看的友好提示。
///
/// 页面每 3 秒自动刷新,桌面端连接后即可正常加载。
pub fn waiting_page() -> Response {
    let html = r##"<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>combo — 等待桌面端连接</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
       background:#0a0a0b;color:#e4e4e7;display:flex;align-items:center;
       justify-content:center;min-height:100vh}
  .card{text-align:center;max-width:420px;padding:48px 32px}
  .icon{width:56px;height:56px;margin:0 auto 24px;border-radius:16px;
        background:rgba(99,102,241,.15);display:flex;align-items:center;
        justify-content:center;animation:pulse 2s ease-in-out infinite}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.5}}
  h1{font-size:20px;font-weight:600;margin-bottom:8px}
  p{font-size:14px;color:#a1a1aa;line-height:1.6}
  code{background:rgba(255,255,255,.08);padding:2px 6px;border-radius:4px;
       font-size:13px;color:#d4d4d8}
</style>
</head>
<body>
<div class="card">
  <div class="icon">
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#818cf8"
         stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83
               M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>
    </svg>
  </div>
  <h1>等待桌面端连接</h1>
  <p>中转服务器已就绪,正在等待桌面客户端建立隧道连接。<br>
     请在桌面端打开「移动端远程控制」生成连接。<br>
     页面将在连接建立后自动刷新。</p>
</div>
<script>setTimeout(()=>location.reload(),3000);</script>
</body>
</html>"##;
    Response::builder()
        .status(StatusCode::SERVICE_UNAVAILABLE)
        .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
        .header(header::REFRESH, "3")
        .body(Body::from(html))
        .unwrap()
}

/// 如果 URL 中含 `?token=xxx`,在响应中设置 cookie(供后续静态资源请求使用)。
///
/// 在 tunnel-all 模式下,浏览器首次访问带 token 的 URL 后,
/// 后续加载 JS/CSS 等静态资源不再携带 Authorization header,
/// 需通过 cookie 关联到正确的隧道。
pub fn token_cookie_headers(req: &Request) -> Option<[(axum::http::HeaderName, axum::http::HeaderValue); 1]> {
    let token = extract_token(req)?;
    let cookie_val = format!(
        "combo.token={}; Path=/; Max-Age=604800; SameSite=Lax",
        token
    );
    let val = axum::http::HeaderValue::from_str(&cookie_val).ok()?;
    Some([(axum::http::HeaderName::from_static("set-cookie"), val)])
}
///
/// 查找顺序:Authorization Bearer header → ?token= query → combo.token cookie。
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
    // 回退:combo.token cookie(浏览器加载静态资源时自动携带)
    if let Some(cookie) = req.headers().get(header::COOKIE) {
        if let Ok(s) = cookie.to_str() {
            for kv in s.split(';') {
                let kv = kv.trim();
                if let Some(rest) = kv.strip_prefix("combo.token=") {
                    return Some(rest.to_string());
                }
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
    // 与 HTTP 转发(tunnel_forward_all)保持一致:优先精确匹配令牌,
    // 单隧道场景下回退到唯一隧道,避免多令牌/令牌不一致时 WS 被 502。
    let token = match state.resolve_token(&req) {
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

#[cfg(test)]
mod tests {
    use super::*;

    fn make_request_with_headers(
        headers: &[(&str, &str)],
        uri: &str,
    ) -> Request {
        let mut builder = Request::builder().uri(uri);
        for (k, v) in headers {
            builder = builder.header(*k, *v);
        }
        builder.body(axum::body::Body::empty()).unwrap()
    }

    #[test]
    fn extract_token_from_authorization() {
        let req = make_request_with_headers(
            &[("authorization", "Bearer abc123")],
            "/v1/health",
        );
        assert_eq!(extract_token(&req), Some("abc123".to_string()));
    }

    #[test]
    fn extract_token_from_query() {
        let req = make_request_with_headers(&[], "/v1/health?token=xyz789");
        assert_eq!(extract_token(&req), Some("xyz789".to_string()));
    }

    #[test]
    fn extract_token_from_cookie() {
        let req = make_request_with_headers(
            &[("cookie", "other=val; combo.token=cookie_tok; foo=bar")],
            "/assets/index.js",
        );
        assert_eq!(extract_token(&req), Some("cookie_tok".to_string()));
    }

    #[test]
    fn extract_token_none_when_missing() {
        let req = make_request_with_headers(&[], "/v1/health");
        assert_eq!(extract_token(&req), None);
    }

    #[test]
    fn extract_token_authorization_priority() {
        // Authorization header 应优先于 query 和 cookie
        let req = make_request_with_headers(
            &[
                ("authorization", "Bearer from_header"),
                ("cookie", "combo.token=from_cookie"),
            ],
            "/v1/health?token=from_query",
        );
        assert_eq!(extract_token(&req), Some("from_header".to_string()));
    }

    #[test]
    fn single_tunnel_token_returns_one() {
        let state = RelayState::default();
        let (tx, _rx) = mpsc::unbounded_channel::<TunnelMsg>();
        let pending = Arc::new(DashMap::new());
        let pending_ws = Arc::new(DashMap::new());
        state.tunnels.insert(
            "tok1".to_string(),
            TunnelHandle {
                conn_id: "conn-1".to_string(),
                tx,
                pending,
                pending_ws,
            },
        );
        assert_eq!(state.single_tunnel_token(), Some("tok1".to_string()));
    }

    #[test]
    fn single_tunnel_token_none_when_multiple() {
        let state = RelayState::default();
        let (tx1, _rx1) = mpsc::unbounded_channel::<TunnelMsg>();
        let (tx2, _rx2) = mpsc::unbounded_channel::<TunnelMsg>();
        let make_handle = || TunnelHandle {
            conn_id: uuid::Uuid::new_v4().to_string(),
            tx: mpsc::unbounded_channel().0,
            pending: Arc::new(DashMap::new()),
            pending_ws: Arc::new(DashMap::new()),
        };
        state.tunnels.insert("tok1".to_string(), make_handle());
        state.tunnels.insert("tok2".to_string(), make_handle());
        let _ = (tx1, tx2);
        assert_eq!(state.single_tunnel_token(), None);
    }

    #[test]
    fn resolve_token_falls_back_to_single_tunnel() {
        let state = RelayState::default();
        let make_handle = || TunnelHandle {
            conn_id: uuid::Uuid::new_v4().to_string(),
            tx: mpsc::unbounded_channel().0,
            pending: Arc::new(DashMap::new()),
            pending_ws: Arc::new(DashMap::new()),
        };
        state.tunnels.insert("only_token".to_string(), make_handle());

        // 无令牌请求 → 单隧道回退
        let req = make_request_with_headers(&[], "/index.html");
        assert_eq!(
            state.resolve_token(&req),
            Some("only_token".to_string())
        );
    }

    #[test]
    fn resolve_token_none_when_no_tunnel() {
        let state = RelayState::default();
        let req = make_request_with_headers(&[], "/index.html");
        assert_eq!(state.resolve_token(&req), None);
    }

    #[test]
    fn remove_tunnel_only_when_owned() {
        let state = RelayState::default();
        let make_handle = || TunnelHandle {
            conn_id: uuid::Uuid::new_v4().to_string(),
            tx: mpsc::unbounded_channel().0,
            pending: Arc::new(DashMap::new()),
            pending_ws: Arc::new(DashMap::new()),
        };
        // 注册旧连接条目
        state.tunnels.insert("tok".to_string(), make_handle());
        let old_conn_id = state.tunnels.get("tok").unwrap().conn_id.clone();
        // 同 token 快速重连:新连接覆盖注册
        state.tunnels.insert("tok".to_string(), make_handle());
        // 旧连接清理:conn_id 不匹配 → 不得误删新条目
        state.remove_tunnel_if_owned("tok", &old_conn_id);
        assert!(state.tunnels.contains_key("tok"));
        // 当前连接清理:conn_id 匹配 → 正常移除
        let new_conn_id = state.tunnels.get("tok").unwrap().conn_id.clone();
        state.remove_tunnel_if_owned("tok", &new_conn_id);
        assert!(!state.tunnels.contains_key("tok"));
    }

    #[test]
    fn token_cookie_headers_set_when_token_in_url() {
        let req = make_request_with_headers(&[], "/?token=abc123");
        let headers = token_cookie_headers(&req);
        assert!(headers.is_some());
        let [(name, val)] = headers.unwrap();
        assert_eq!(name, "set-cookie");
        assert!(val.to_str().unwrap().contains("combo.token=abc123"));
    }

    #[test]
    fn token_cookie_headers_none_when_no_token() {
        let req = make_request_with_headers(&[], "/");
        assert!(token_cookie_headers(&req).is_none());
    }

    #[test]
    fn waiting_page_returns_html() {
        let resp = waiting_page();
        assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(
            resp.headers().get(header::CONTENT_TYPE).unwrap(),
            "text/html; charset=utf-8"
        );
    }
}
