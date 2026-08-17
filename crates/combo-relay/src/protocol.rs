use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// 中转隧道线路协议消息。
///
/// 协议基于 JSON-over-WebSocket:
/// - 中转服务器 → 桌面客户端:发 `Request`(转发 HTTP 请求)或 WebSocket 隧道消息(`WsUpgrade`/`WsData`/`WsClose`)
/// - 桌面客户端 → 中转服务器:发 `ResponseStart` / `ResponseChunk` / `ResponseEnd` / `ResponseError`
///   或 WebSocket 隧道消息(`WsData`/`WsClose`/`WsError`)
///
/// 每个 HTTP 请求 / WebSocket 连接用唯一 `id` 关联,支持单 WebSocket 连接上多请求并发。
/// 流式响应(SSE)通过多次 `ResponseChunk` 实现。

/// 中转服务器 → 桌面客户端:转发 HTTP 请求或 WebSocket 隧道消息。
#[derive(Serialize, Deserialize, Debug)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum TunnelMsg {
    Request {
        id: String,
        method: String,
        path: String,
        query: String,
        headers: HashMap<String, String>,
        #[serde(default)]
        body: Option<String>, // base64 编码
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
        data: String, // base64 编码
        binary: bool,
    },
    /// WebSocket 隧道:浏览器关闭了 WS 连接。
    WsClose {
        id: String,
    },
    /// WebRTC P2P 信令:浏览器(经 signal WS)→ 桌面端。
    /// `id` 为信令会话标识(signal WS 连接 id),中转只透传不解析。
    Signal {
        id: String,
        data: String,
    },
}

/// 桌面客户端 → 中转服务器:HTTP 响应或 WebSocket 隧道消息。
#[derive(Serialize, Deserialize, Debug)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum DesktopMsg {
    /// 响应头(每个请求必定最先发一条)
    ResponseStart {
        id: String,
        status: u16,
        headers: HashMap<String, String>,
    },
    /// 响应体分块(普通响应发一次,SSE 流式响应发多次)
    ResponseChunk {
        id: String,
        body: String, // base64 编码
    },
    /// 响应结束(每个请求必定最后发一条)
    ResponseEnd {
        id: String,
    },
    /// 响应错误(代替 ResponseStart,请求处理失败时发送)
    ResponseError {
        id: String,
        status: u16,
        message: String,
    },
    /// WebSocket 隧道:桌面端 → 浏览器的 WS 数据(如 PTY 输出)。
    WsData {
        id: String,
        data: String, // base64 编码
        binary: bool,
    },
    /// WebSocket 隧道:桌面端关闭了 WS 连接(如 PTY 退出)。
    WsClose {
        id: String,
    },
    /// WebSocket 隧道:桌面端连接本地 WS 失败。
    WsError {
        id: String,
        message: String,
    },
    /// WebRTC P2P 信令:桌面端 → 浏览器(signal WS)。
    Signal {
        id: String,
        data: String,
    },
}
