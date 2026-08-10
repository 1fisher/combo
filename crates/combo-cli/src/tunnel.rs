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
use std::sync::Arc;
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

/// 启动隧道客户端(阻塞运行,含自动重连)。
pub async fn run_tunnel_client(config: TunnelClientConfig) {
    let mut backoff = Duration::from_secs(1);
    let max_backoff = Duration::from_secs(30);

    loop {
        println!("COMBO_TUNNEL_CONNECT={}", config.relay_url);
        match connect_and_serve(&config).await {
            Ok(()) => {
                eprintln!("COMBO_TUNNEL_DISCONNECTED=正常关闭");
                backoff = Duration::from_secs(1);
            }
            Err(e) => {
                eprintln!("COMBO_TUNNEL_ERROR={e}");
            }
        }
        eprintln!("COMBO_TUNNEL_RECONNECT={}s", backoff.as_secs());
        tokio::time::sleep(backoff).await;
        backoff = (backoff * 2).min(max_backoff);
    }
}

async fn connect_and_serve(config: &TunnelClientConfig) -> anyhow::Result<()> {
    let ws_url = format!("{}?token={}", config.relay_url, config.token);
    let (ws_stream, _response) = tokio_tungstenite::connect_async(&ws_url).await?;
    println!("COMBO_TUNNEL_CONNECTED=1");

    let (mut ws_sink, mut ws_stream_rx) = ws_stream.split();

    // 共享的 WebSocket 发送通道:各 handler task 通过它回传响应。
    let (ws_tx, mut ws_rx) = mpsc::unbounded_channel::<Message>();

    // 写入任务:从通道读取消息写入 WebSocket
    let write_task = tokio::spawn(async move {
        while let Some(msg) = ws_rx.recv().await {
            if ws_sink.send(msg).await.is_err() {
                break;
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

    // 读取循环:解析中转发来的请求,分发到独立 task 处理
    while let Some(msg) = ws_stream_rx.next().await {
        let text = match msg {
            Ok(Message::Text(t)) => t,
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
        }
    }

    write_task.abort();
    eprintln!("COMBO_TUNNEL_DISCONNECTED=1");
    Ok(())
}

/// 处理单个隧道请求:转发到本地 serve,流式回传响应。
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
    let url = if query.is_empty() {
        format!("{}{}", config.local_proxy_url, path)
    } else {
        format!("{}{}?{}", config.local_proxy_url, path, query)
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

    // 解码请求体
    if let Some(b64) = body {
        if let Ok(decoded) = base64::engine::general_purpose::STANDARD.decode(&b64) {
            builder = builder.body(decoded);
        }
    }

    let resp = match builder.send().await {
        Ok(r) => r,
        Err(e) => {
            let _ = send_desktop_msg(
                &ws_tx,
                DesktopMsg::ResponseError {
                    id: id.clone(),
                    status: 502,
                    message: format!("本地代理不可达: {e}"),
                },
            );
            return;
        }
    };

    // ResponseStart: 状态 + 响应头
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

    let _ = send_desktop_msg(
        &ws_tx,
        DesktopMsg::ResponseStart {
            id: id.clone(),
            status,
            headers: resp_headers,
        },
    );

    // 流式读取响应体(支持 SSE 长连接)
    use futures::TryStreamExt;
    let mut stream = resp.bytes_stream();
    while let Ok(Some(chunk)) = stream.try_next().await {
        if chunk.is_empty() {
            continue;
        }
        let b64 = base64::engine::general_purpose::STANDARD.encode(&chunk);
        let _ = send_desktop_msg(
            &ws_tx,
            DesktopMsg::ResponseChunk {
                id: id.clone(),
                body: b64,
            },
        );
    }

    // ResponseEnd
    let _ = send_desktop_msg(&ws_tx, DesktopMsg::ResponseEnd { id });
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

    // 连接本地 WS(透传必要的请求头,如 Authorization / Cookie)
    let mut req_builder = tokio_tungstenite::tungstenite::http::Request::builder()
        .uri(&local_url)
        .header(
            "host",
            local_url
                .splitn(4, '/')
                .nth(2)
                .unwrap_or("127.0.0.1"),
        );
    for (k, v) in &headers {
        let lower = k.to_lowercase();
        if lower == "host" || lower == "content-length" || lower == "upgrade" || lower == "connection" {
            continue;
        }
        req_builder = req_builder.header(k.as_str(), v.as_str());
    }
    let req = match req_builder
        .header("upgrade", "websocket")
        .header("connection", "upgrade")
        .body(())
    {
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
        Message::Binary(decoded)
    } else {
        Message::Text(String::from_utf8_lossy(&decoded).into_owned())
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
    tx.send(Message::Text(json)).map_err(|_| ())
}
