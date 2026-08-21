//! 桌面端隧道客户端。
//!
//! 桌面客户端(combo-cli serve)通过 WebSocket 连出到中转服务器(combo-relay),
//! 建立**反向隧道**。中转服务器收到手机/Web 的 HTTP 请求后,通过隧道转发到桌面端,
//! 桌面端在本地处理(转发给自己 serve 的 /v1/*)后将响应通过隧道返回。
//!
//! 连接: `wss://proxy.apesoft.cn/v1/relay/tunnel?token=<access_token>`
//! 断线自动重连(指数退避)。

use base64::Engine;
use futures::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Once};
use std::time::Duration;
use tokio::sync::{mpsc, Mutex};
use tokio_tungstenite::tungstenite::Message;

/// 活跃的 WS 隧道连接:每个 id 对应一个发送端,用于向本地 WS 推送数据。
type WsTunnelMap = Arc<Mutex<HashMap<String, mpsc::UnboundedSender<Message>>>>;

/// 线路协议:中转服务器 → 桌面客户端。
#[derive(Serialize, Deserialize, Debug)]
#[serde(tag = "type", rename_all = "snake_case")]
enum TunnelMsg {
    Request {
        id: String,
        method: String,
        path: String,
        query: String,
        headers: HashMap<String, String>,
        #[serde(default)]
        body: Option<String>, // base64
    },
    /// WebSocket 隧道:浏览器发起新的 WS 连接(如终端)。
    WsUpgrade {
        id: String,
        path: String,
        query: String,
        #[serde(default)]
        headers: HashMap<String, String>,
    },
    /// WebSocket 隧道:浏览器 → 桌面端的 WS 数据。
    WsData {
        id: String,
        data: String, // base64
        binary: bool,
    },
    /// WebSocket 隧道:浏览器关闭了 WS 连接。
    WsClose {
        id: String,
    },
    /// WebRTC P2P 信令:移动端经中转发来的 offer/关闭等信令(JSON 字符串)。
    /// 中转服务器只透传,不解析。`id` 为信令会话标识(浏览器 signal WS 连接 id)。
    Signal {
        id: String,
        data: String,
    },
}

/// 线路协议:桌面客户端 → 中转服务器。
#[derive(Serialize, Deserialize, Debug)]
#[serde(tag = "type", rename_all = "snake_case")]
enum DesktopMsg {
    ResponseStart {
        id: String,
        status: u16,
        headers: HashMap<String, String>,
    },
    ResponseChunk {
        id: String,
        body: String, // base64
    },
    ResponseEnd {
        id: String,
    },
    ResponseError {
        id: String,
        status: u16,
        message: String,
    },
    /// WebSocket 隧道:桌面端 → 浏览器的 WS 数据(如 PTY 输出)。
    WsData {
        id: String,
        data: String, // base64
        binary: bool,
    },
    /// WebSocket 隧道:桌面端关闭了 WS 连接。
    WsClose {
        id: String,
    },
    /// WebSocket 隧道:桌面端连接本地 WS 失败。
    WsError {
        id: String,
        message: String,
    },
    /// WebRTC P2P 信令:桌面端 → 移动端(answer/错误/关闭)。
    Signal {
        id: String,
        data: String,
    },
}

/// 隧道客户端配置。
#[derive(Clone)]
pub struct TunnelClientConfig {
    /// 中转服务器 WebSocket 地址。
    pub relay_url: String,
    /// 访问令牌。
    pub token: String,
    /// 本地 serve 地址。
    pub local_proxy_url: String,
}

/// 确保 rustls crypto provider 被安装。
/// rustls 0.23 不再自动安装默认 crypto provider,
/// 未安装时 TLS 连接会 panic("no process-level CryptoProvider available")。
/// 在 Tauri 内嵌模式下 tokio-tungstenite 可能是第一个使用 rustls 的组件,
/// 此时 crypto provider 尚未安装 → panic → axum worker 崩溃 → 前端 "network error"。
static CRYPTO_PROVIDER_INIT: Once = Once::new();
fn ensure_crypto_provider() {
    CRYPTO_PROVIDER_INIT.call_once(|| {
        rustls::crypto::ring::default_provider()
            .install_default()
            .ok();
    });
}

/// 仅测试 WebSocket 连接能否建立(不启动 serve 循环)。
/// 供 start_relay 同步试连,失败时立即把具体错误返回给前端。
pub async fn test_connection(config: &TunnelClientConfig) -> Result<(), String> {
    ensure_crypto_provider();

    let normalized = config.relay_url.trim();
    let ws_base = if normalized.to_ascii_lowercase().starts_with("https://") {
        format!("wss://{}", &normalized[8..])
    } else if normalized.to_ascii_lowercase().starts_with("http://") {
        format!("ws://{}", &normalized[7..])
    } else {
        normalized.to_string()
    };
    let ws_url = format!("{}?token={}", ws_base, config.token);
    tracing::info!("[tunnel] test_connection 开始: {}", ws_base);
    let result = tokio::time::timeout(
        Duration::from_secs(5),
        tokio_tungstenite::connect_async(&ws_url),
    )
    .await;
    match result {
        Ok(Ok(_)) => {
            tracing::info!("[tunnel] test_connection 成功: {}", ws_base);
            Ok(())
        }
        Ok(Err(e)) => {
            tracing::error!("[tunnel] test_connection 失败: {e}");
            Err(format!("{e}"))
        }
        Err(_) => {
            tracing::error!("[tunnel] test_connection 超时(5s): {}", ws_base);
            Err(format!("连接中转服务器超时(5s):{ws_base}"))
        }
    }
}

/// 启动隧道客户端(阻塞运行,含自动重连)。
///
/// `last_error` 用于将最近一次连接错误透传给前端(RelayStatus.error),
/// 便于在 UI 上显示具体原因(TLS 失败 / DNS 解析 / 连接拒绝等)。
/// `p2p` 为 WebRTC 直连管理器:信令经本隧道收发,P2P 连接与隧道同生共死。
pub async fn run_tunnel_client(
    config: TunnelClientConfig,
    connected: Arc<AtomicBool>,
    last_error: Arc<std::sync::Mutex<Option<String>>>,
    p2p: Arc<crate::p2p::P2pManager>,
) {
    let mut backoff = Duration::from_secs(1);
    let max_backoff = Duration::from_secs(30);

    loop {
        println!("COMBO_TUNNEL_CONNECT={}", config.relay_url);
        match connect_and_serve(&config, &connected, &p2p).await {
            Ok(()) => {
                eprintln!("COMBO_TUNNEL_DISCONNECTED=正常关闭");
                backoff = Duration::from_secs(1);
            }
            Err(e) => {
                let msg = format!("{e}");
                eprintln!("COMBO_TUNNEL_ERROR={msg}");
                if let Ok(mut guard) = last_error.lock() {
                    *guard = Some(msg);
                }
            }
        }
        connected.store(false, Ordering::Relaxed);
        eprintln!("COMBO_TUNNEL_RECONNECT={}s", backoff.as_secs());
        tokio::time::sleep(backoff).await;
        backoff = (backoff * 2).min(max_backoff);
    }
}

async fn connect_and_serve(
    config: &TunnelClientConfig,
    connected: &AtomicBool,
    p2p: &Arc<crate::p2p::P2pManager>,
) -> anyhow::Result<()> {
    ensure_crypto_provider();
    // 归一化 scheme:Https:// → wss://, https:// → wss://, Http:// → ws://
    // 防御性处理前端传入的大小写不一致
    let normalized = config.relay_url.trim();
    let ws_base = if normalized.to_ascii_lowercase().starts_with("https://") {
        format!("wss://{}", &normalized[8..])
    } else if normalized.to_ascii_lowercase().starts_with("http://") {
        format!("ws://{}", &normalized[7..])
    } else {
        normalized.to_string()
    };
    let ws_url = format!("{}?token={}", ws_base, config.token);
    // connect_async 没有内置超时,网络不通时会永久挂起。
    // 5s 超时:start_and_wait 等待 8s,足够在放弃前拿到错误。
    let (ws_stream, _response) = match tokio::time::timeout(
        Duration::from_secs(5),
        tokio_tungstenite::connect_async(&ws_url),
    )
    .await
    {
        Ok(result) => result?,
        Err(_) => anyhow::bail!("连接中转服务器超时(5s):{ws_base}"),
    };
    connected.store(true, Ordering::Relaxed);
    println!("COMBO_TUNNEL_CONNECTED=1");

    let (mut ws_sink, mut ws_stream_rx) = ws_stream.split();

    // 共享的 WebSocket 发送通道:各 handler task 通过它回传响应。
    let (ws_tx, mut ws_rx) = mpsc::unbounded_channel::<Message>();

    // 信令回传闭包:P2P 会话通过它把 answer/错误/关闭信令发回中转服务器。
    let emit: crate::p2p::EmitSignal = {
        let ws_tx = ws_tx.clone();
        Arc::new(move |id: &str, data: &str| {
            let _ = ws_tx.send(Message::text(signal_frame(id, data)));
        })
    };

    // 写入任务:从通道读取消息写入 WebSocket。
    // 同时每 20s 主动发一次 Ping:保持 NAT/防火墙映射 + 尽早发现半开连接
    // (系统休眠唤醒后 TCP 已死但可能收不到 RST,靠写失败/读超时兜底)。
    let mut ping_interval = tokio::time::interval(Duration::from_secs(20));
    ping_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    ping_interval.tick().await; // 消耗立即触发的首拍
    let write_task = tokio::spawn(async move {
        loop {
            tokio::select! {
                msg = ws_rx.recv() => {
                    let Some(msg) = msg else { break };
                    if ws_sink.send(msg).await.is_err() {
                        break;
                    }
                }
                _ = ping_interval.tick() => {
                    if ws_sink.send(Message::Ping(Default::default())).await.is_err() {
                        break;
                    }
                }
            }
        }
    });

    let http_client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .tcp_keepalive(Some(Duration::from_secs(60)))
        .redirect(reqwest::redirect::Policy::none())
        .build()?;

    // 活跃的 WS 隧道连接表:relay 下发的 WsData/WsClose 通过 id 路由到对应的本地 WS。
    let ws_tunnels: WsTunnelMap = Arc::new(Mutex::new(HashMap::new()));

    // 读取循环:解析中转发来的请求,分发到独立 task 处理。
    // 读空闲超时:中转每 30s 发 Ping,超过 75s 无任何帧说明连接已死
    // (休眠唤醒/NAT 失效的半开连接),主动断开交给外层重连循环。
    loop {
        let msg = match tokio::time::timeout(Duration::from_secs(75), ws_stream_rx.next()).await {
            Ok(m) => m,
            Err(_) => {
                eprintln!("COMBO_TUNNEL_IDLE=75s 未收到任何帧,判定连接失效");
                break;
            }
        };
        let Some(msg) = msg else { break };
        let text = match msg {
            Ok(Message::Text(t)) => t.to_string(),
            Ok(Message::Binary(d)) => String::from_utf8_lossy(&d).into_owned(),
            Ok(Message::Ping(p)) => {
                let _ = ws_tx.send(Message::Pong(p));
                continue;
            }
            Ok(Message::Close(_)) | Err(_) => break,
            _ => continue,
        };

        let req_msg: TunnelMsg = match serde_json::from_str(&text) {
            Ok(m) => m,
            Err(e) => {
                eprintln!("COMBO_TUNNEL_WARN=无法解析隧道消息: {e}");
                continue;
            }
        };

        match req_msg {
            TunnelMsg::Request {
                id,
                method,
                path,
                query,
                headers,
                body,
            } => {
                let ws_tx = ws_tx.clone();
                let config = config.clone();
                let http_client = http_client.clone();
                tokio::spawn(handle_request(
                    ws_tx, config, http_client, id, method, path, query, headers, body,
                ));
            }
            TunnelMsg::WsUpgrade {
                id,
                path,
                query,
                headers,
            } => {
                let ws_tx = ws_tx.clone();
                let config = config.clone();
                let ws_tunnels = ws_tunnels.clone();
                tokio::spawn(handle_ws_upgrade(
                    ws_tx, config, ws_tunnels, id, path, query, headers,
                ));
            }
            TunnelMsg::WsData { id, data, binary } => {
                let ws_tunnels = ws_tunnels.clone();
                tokio::spawn(handle_ws_data(ws_tunnels, id, data, binary));
            }
            TunnelMsg::WsClose { id } => {
                let ws_tunnels = ws_tunnels.clone();
                tokio::spawn(async move {
                    let _ = handle_ws_close(ws_tunnels, id).await;
                });
            }
            TunnelMsg::Signal { id, data } => {
                let p2p = p2p.clone();
                let emit = emit.clone();
                tokio::spawn(async move {
                    p2p.handle_signal(id, data, emit).await;
                });
            }
        }
    }

    write_task.abort();
    // 隧道断开 → 信令通道失效 → 关闭全部 WebRTC 会话。
    p2p.clear().await;
    eprintln!("COMBO_TUNNEL_DISCONNECTED=1");
    Ok(())
}

/// 请求执行事件流:隧道(WS)与 P2P(DataChannel)两种出口共用同一执行核心。
#[derive(Debug)]
pub(crate) enum ExecEvent {
    Start {
        status: u16,
        headers: HashMap<String, String>,
    },
    /// 响应体分片(原始字节,已按 ≤8KB 切片:8KB base64 后 ~11KB,
    /// 低于 WebRTC DataChannel 单消息 16KB 上限)。
    Chunk(Vec<u8>),
    End,
    Error {
        status: u16,
        message: String,
    },
}

/// 单条响应体分片的最大原始字节数(base64 后仍在 DataChannel 单消息限制内)。
pub(crate) const CHUNK_RAW_MAX: usize = 8 * 1024;

/// 请求执行核心:把请求转发到本地 serve,事件流式回传(支持 SSE)。
/// 隧道(DesktopMsg)与 WebRTC DataChannel 各自适配事件格式。
pub(crate) async fn execute_request(
    client: reqwest::Client,
    local_proxy_url: String,
    method: String,
    path: String,
    query: String,
    headers: HashMap<String, String>,
    body: Option<Vec<u8>>,
    ev_tx: mpsc::UnboundedSender<ExecEvent>,
) {
    let url = if query.is_empty() {
        format!("{}{}", local_proxy_url, path)
    } else {
        format!("{}{}?{}", local_proxy_url, path, query)
    };

    let mut builder = client.request(method.parse().unwrap_or(reqwest::Method::GET), &url);

    // 透传请求头
    for (k, v) in &headers {
        let lower = k.to_lowercase();
        // 跳过 host(serve 会自己设置)
        if lower == "host" || lower == "content-length" {
            continue;
        }
        if let (Ok(name), Ok(val)) = (
            reqwest::header::HeaderName::from_bytes(k.as_bytes()),
            reqwest::header::HeaderValue::from_str(v),
        ) {
            builder = builder.header(name, val);
        }
    }

    if let Some(bytes) = body {
        builder = builder.body(bytes);
    }

    let resp = match builder.send().await {
        Ok(r) => r,
        Err(e) => {
            let _ = ev_tx.send(ExecEvent::Error {
                status: 502,
                message: format!("本地代理不可达: {e}"),
            });
            return;
        }
    };

    // Start: 状态 + 响应头
    let status = resp.status().as_u16();
    let mut resp_headers = HashMap::new();
    for (k, v) in resp.headers().iter() {
        if let Ok(s) = v.to_str() {
            let lower = k.as_str().to_lowercase();
            // 跳过这些(中转端会自动处理)
            if lower == "transfer-encoding" || lower == "content-length" {
                continue;
            }
            resp_headers.insert(k.as_str().to_string(), s.to_string());
        }
    }

    let _ = ev_tx.send(ExecEvent::Start {
        status,
        headers: resp_headers,
    });

    // 流式读取响应体(支持 SSE 长连接),按 CHUNK_RAW_MAX 切片
    use futures::TryStreamExt;
    let mut stream = resp.bytes_stream();
    while let Ok(Some(chunk)) = stream.try_next().await {
        if chunk.is_empty() {
            continue;
        }
        let mut offset = 0;
        while offset < chunk.len() {
            let end = (offset + CHUNK_RAW_MAX).min(chunk.len());
            let _ = ev_tx.send(ExecEvent::Chunk(chunk[offset..end].to_vec()));
            offset = end;
        }
    }

    let _ = ev_tx.send(ExecEvent::End);
}

/// 序列化一条桌面端 → 中转服务器的 P2P 信令消息。
pub(crate) fn signal_frame(id: &str, data: &str) -> String {
    serde_json::to_string(&DesktopMsg::Signal {
        id: id.to_string(),
        data: data.to_string(),
    })
    .unwrap_or_default()
}

/// 处理单个隧道请求:转发到本地 serve,流式回传响应(DesktopMsg 适配层)。
async fn handle_request(
    ws_tx: mpsc::UnboundedSender<Message>,
    config: TunnelClientConfig,
    client: reqwest::Client,
    id: String,
    method: String,
    path: String,
    query: String,
    headers: HashMap<String, String>,
    body: Option<String>,
) {
    let body_bytes = body.and_then(|b64| base64::engine::general_purpose::STANDARD.decode(&b64).ok());
    let (ev_tx, mut ev_rx) = mpsc::unbounded_channel::<ExecEvent>();
    let exec = execute_request(
        client,
        config.local_proxy_url.clone(),
        method,
        path,
        query,
        headers,
        body_bytes,
        ev_tx,
    );
    tokio::spawn(exec);
    while let Some(ev) = ev_rx.recv().await {
        let msg = match ev {
            ExecEvent::Start { status, headers } => DesktopMsg::ResponseStart {
                id: id.clone(),
                status,
                headers,
            },
            ExecEvent::Chunk(bytes) => DesktopMsg::ResponseChunk {
                id: id.clone(),
                body: base64::engine::general_purpose::STANDARD.encode(bytes),
            },
            ExecEvent::End => DesktopMsg::ResponseEnd { id: id.clone() },
            ExecEvent::Error { status, message } => DesktopMsg::ResponseError {
                id: id.clone(),
                status,
                message,
            },
        };
        if send_desktop_msg(&ws_tx, msg).is_err() {
            break;
        }
    }
}

/// 处理 WS 隧道升级:连接本地 WS 端点,桥接双向数据。
async fn handle_ws_upgrade(
    ws_tx: mpsc::UnboundedSender<Message>,
    config: TunnelClientConfig,
    ws_tunnels: WsTunnelMap,
    id: String,
    path: String,
    query: String,
    headers: HashMap<String, String>,
) {
    // 构建本地 WS URL
    let ws_base = config
        .local_proxy_url
        .replacen("http://", "ws://", 1)
        .replacen("https://", "wss://", 1);
    let local_url = if query.is_empty() {
        format!("{}{}", ws_base, path)
    } else {
        format!("{}{}?{}", ws_base, path, query)
    };

    let req = match build_local_ws_request(&local_url, &headers) {
        Ok(r) => r,
        Err(e) => {
            let _ = send_desktop_msg(
                &ws_tx,
                DesktopMsg::WsError {
                    id: id.clone(),
                    message: format!("构建 WS 请求失败: {e}"),
                },
            );
            return;
        }
    };

    let local_ws = match tokio_tungstenite::connect_async(req).await {
        Ok((stream, _)) => stream,
        Err(e) => {
            eprintln!("COMBO_TUNNEL_WARN=本地 WS 连接失败 path={path}: {e}");
            let _ = send_desktop_msg(
                &ws_tx,
                DesktopMsg::WsError {
                    id: id.clone(),
                    message: format!("本地 WS 连接失败: {e}"),
                },
            );
            return;
        }
    };

    let (mut local_sink, mut local_rx) = local_ws.split();

    // 数据通道:relay → 本地 WS
    let (data_tx, mut data_rx) = mpsc::unbounded_channel::<Message>();

    // 注册到连接表
    ws_tunnels.lock().await.insert(id.clone(), data_tx);

    // 任务 1:relay → 本地 WS
    let id_fwd = id.clone();
    let mut fwd_task = tokio::spawn(async move {
        while let Some(msg) = data_rx.recv().await {
            if local_sink.send(msg).await.is_err() {
                break;
            }
        }
        let _ = local_sink.close().await;
        id_fwd
    });

    // 任务 2:本地 WS → relay
    let ws_tx_bwd = ws_tx.clone();
    let id_bwd = id.clone();
    let mut bwd_task = tokio::spawn(async move {
        while let Some(msg) = local_rx.next().await {
            match msg {
                Ok(Message::Text(t)) => {
                    let _ = send_desktop_msg(
                        &ws_tx_bwd,
                        DesktopMsg::WsData {
                            id: id_bwd.clone(),
                            data: base64::engine::general_purpose::STANDARD.encode(t.as_bytes()),
                            binary: false,
                        },
                    );
                }
                Ok(Message::Binary(b)) => {
                    let _ = send_desktop_msg(
                        &ws_tx_bwd,
                        DesktopMsg::WsData {
                            id: id_bwd.clone(),
                            data: base64::engine::general_purpose::STANDARD.encode(&b),
                            binary: true,
                        },
                    );
                }
                Ok(Message::Close(_)) => {
                    let _ = send_desktop_msg(&ws_tx_bwd, DesktopMsg::WsClose { id: id_bwd });
                    break;
                }
                Ok(_) => {} // ping/pong 由 tokio-tungstenite 自动处理
                Err(e) => {
                    let _ = send_desktop_msg(
                        &ws_tx_bwd,
                        DesktopMsg::WsError {
                            id: id_bwd,
                            message: format!("本地 WS 读取错误: {e}"),
                        },
                    );
                    break;
                }
            }
        }
    });

    // 等任一方向结束
    tokio::select! {
        res = &mut fwd_task => {
            if let Ok(id) = res {
                let _ = send_desktop_msg(&ws_tx, DesktopMsg::WsClose { id });
            }
            bwd_task.abort();
        }
        _ = &mut bwd_task => {
            fwd_task.abort();
        }
    }

    ws_tunnels.lock().await.remove(&id);
}

/// 处理 relay 转发的 WS 数据:解码并写入对应的本地 WS。
async fn handle_ws_data(
    ws_tunnels: WsTunnelMap,
    id: String,
    data: String,
    binary: bool,
) {
    let decoded = match base64::engine::general_purpose::STANDARD.decode(&data) {
        Ok(d) => d,
        Err(_) => return,
    };
    let msg = if binary {
        Message::binary(decoded)
    } else {
        Message::text(String::from_utf8_lossy(&decoded).into_owned())
    };
    let map = ws_tunnels.lock().await;
    if let Some(tx) = map.get(&id) {
        let _ = tx.send(msg);
    }
}

/// 处理 relay 转发的 WS 关闭:关闭对应的本地 WS 连接。
async fn handle_ws_close(ws_tunnels: WsTunnelMap, id: String) {
    ws_tunnels.lock().await.remove(&id);
}

fn send_desktop_msg(tx: &mpsc::UnboundedSender<Message>, msg: DesktopMsg) -> Result<(), ()> {
    let json = serde_json::to_string(&msg).map_err(|_| ())?;
    tx.send(Message::text(json)).map_err(|_| ())
}

/// 生成本地 WS 握手的 Sec-WebSocket-Key 原始字节(16 随机字节)。
/// 优先读 /dev/urandom,不可用时回退到 uuid v4(32 hex 字节取前 16)。
fn generate_ws_key() -> [u8; 16] {
    let mut buf = [0u8; 16];
    if let Ok(mut f) = std::fs::File::open("/dev/urandom") {
        use std::io::Read;
        if f.read_exact(&mut buf).is_ok() {
            return buf;
        }
    }
    let hex = uuid::Uuid::new_v4().simple().to_string();
    for (i, b) in buf.iter_mut().enumerate() {
        *b = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).unwrap_or(0);
    }
    buf
}

/// 构建发往本地 serve 的 WS 握手请求。
///
/// 透传必要的请求头(如 Authorization / Cookie),但逐跳握手头
/// (host / upgrade / connection / sec-websocket-*)一律丢弃后重新生成:
/// tungstenite 对自定义 Request 不会自动补握手头,缺少 Sec-WebSocket-Key 时
/// connect_async 直接报 InvalidHeader,本地 WS 永远连不上
/// (移动端经中转打开终端秒断 code 1005 的根因)。
fn build_local_ws_request(
    local_url: &str,
    headers: &HashMap<String, String>,
) -> Result<tokio_tungstenite::tungstenite::http::Request<()>, String> {
    let host = local_url.splitn(4, '/').nth(2).unwrap_or("127.0.0.1");
    let mut req_builder = tokio_tungstenite::tungstenite::http::Request::builder()
        .uri(local_url)
        .header("host", host);
    for (k, v) in headers {
        let lower = k.to_lowercase();
        if lower == "host"
            || lower == "content-length"
            || lower == "upgrade"
            || lower == "connection"
            || lower.starts_with("sec-websocket-")
        {
            continue;
        }
        req_builder = req_builder.header(k.as_str(), v.as_str());
    }
    let ws_key = base64::engine::general_purpose::STANDARD.encode(generate_ws_key());
    req_builder
        .header("upgrade", "websocket")
        .header("connection", "upgrade")
        .header("sec-websocket-key", ws_key)
        .header("sec-websocket-version", "13")
        .body(())
        .map_err(|e| format!("{e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 中转剥离 sec-websocket-key/version 后转发的浏览器握手头,
    /// 本地重建的请求必须能通过 tungstenite 的握手校验。
    /// 回归:此前缺少 Sec-WebSocket-Key 导致 connect_async 报
    /// InvalidHeader,移动端终端经中转秒断(code 1005)。
    #[test]
    fn local_ws_request_passes_tungstenite_handshake_validation() {
        let mut headers = HashMap::new();
        headers.insert(
            "authorization".to_string(),
            "Bearer 749675f7f8e0".to_string(),
        );
        headers.insert("cookie".to_string(), "combo.token=abc".to_string());
        headers.insert("origin".to_string(), "https://proxy.apesoft.cn".to_string());
        // 中转剥离 key/version/extensions,但防御性假设它们被透传:
        headers.insert("sec-websocket-key".to_string(), "browser-key".to_string());
        headers.insert(
            "sec-websocket-version".to_string(),
            "13".to_string(),
        );
        headers.insert("host".to_string(), "proxy.apesoft.cn".to_string());
        headers.insert("upgrade".to_string(), "websocket".to_string());
        headers.insert("connection".to_string(), "Upgrade".to_string());

        let req =
            build_local_ws_request("ws://127.0.0.1:18237/v1/terminal?token=abc", &headers)
                .expect("构建本地 WS 请求失败");
        let (raw, key) =
            tokio_tungstenite::tungstenite::handshake::client::generate_request(req)
                .expect("tungstenite 握手校验失败");
        let raw = String::from_utf8(raw).unwrap();
        assert!(raw.contains("GET /v1/terminal?token=abc "), "原始请求行异常: {raw}");
        assert!(
            raw.to_ascii_lowercase().contains("sec-websocket-version: 13"),
            "原始请求缺少 version 头: {raw}"
        );
        // key 必须是本地新生成的(16 字节 base64,24 字符),而不是浏览器侧透传值
        assert_eq!(key.len(), 24, "Sec-WebSocket-Key 应为 16 字节 base64: {key}");
        assert_ne!(key, "browser-key");
    }
}
