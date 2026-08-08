use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// 中转隧道线路协议消息。
///
/// 协议基于 JSON-over-WebSocket:
/// - 中转服务器 → 桌面客户端:只发 `TunnelRequest`(转发 HTTP 请求)
/// - 桌面客户端 → 中转服务器:发 `TunnelResponseStart` / `TunnelResponseChunk` / `TunnelResponseEnd` / `TunnelResponseError`
///
/// 每个 HTTP 请求用唯一 `id` 关联请求与响应,支持单 WebSocket 连接上多请求并发。
/// 流式响应(SSE)通过多次 `TunnelResponseChunk` 实现。

/// 中转服务器 → 桌面客户端:转发一个 HTTP 请求。
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
}

/// 桌面客户端 → 中转服务器:HTTP 响应(可能跨多条消息,支持流式)。
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
}
