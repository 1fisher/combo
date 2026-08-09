//! 桌面端隧道客户端。
//!
//! 桌面客户端(combo-proxy)通过 WebSocket 连出到中转服务器(combo-relay),
//! 建立**反向隧道**。中转服务器收到手机/Web 的 HTTP 请求后,通过隧道转发到桌面端,
//! 桌面端在本地处理(转发给 combo-proxy)后将响应通过隧道返回。
//!
//! 连接: `wss://proxy.apesoft.cn/v1/relay/tunnel?token=<access_token>`
//! 断线自动重连(指数退避)。

use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::time::Duration;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

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
}

/// 隧道客户端配置。
#[derive(Clone)]
pub struct TunnelClientConfig {
    /// 中转服务器 WebSocket 地址。
    pub relay_url: String,
    /// 访问令牌。
    pub token: String,
    /// 本地 combo-proxy 地址。
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
        .timeout(Duration::from_secs(300))
        .redirect(reqwest::redirect::Policy::none())
        .build()?;

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
        }
    }

    write_task.abort();
    eprintln!("COMBO_TUNNEL_DISCONNECTED=1");
    Ok(())
}

/// 处理单个隧道请求:转发到本地 combo-proxy,流式回传响应。
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
        // 跳过 host(combo-proxy 会自己设置)
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
    use futures_util::TryStreamExt;
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

fn send_desktop_msg(tx: &mpsc::UnboundedSender<Message>, msg: DesktopMsg) -> Result<(), ()> {
    let json = serde_json::to_string(&msg).map_err(|_| ())?;
    tx.send(Message::Text(json)).map_err(|_| ())
}
