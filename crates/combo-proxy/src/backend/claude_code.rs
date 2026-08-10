//! Claude Code 后端适配器。
//!
//! Claude Code 是 CLI 工具(无 HTTP 服务器)。本模块:
//! - 为每条消息 spawn `claude -p --output-format stream-json` 子进程
//! - 解析 newline-delimited JSON 事件,翻译为 combo 双层信封
//! - 通过 broadcast channel 把事件推给 SSE 连接
//! - 维护 combo session_id ↔ claude session_id 映射(用于 --resume)

use crate::backend::{Backend, BackendType};
use anyhow::Result;
use axum::body::Body;
use axum::http::{HeaderMap, Method, StatusCode};
use axum::response::Response;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use tokio::process::Command;
use tokio::sync::{broadcast, Mutex};
use futures_util::StreamExt;

/// Claude Code 后端。
pub struct ClaudeCodeBackend {
    bin: String,
    /// 事件代理:workspace_id → broadcast sender
    brokers: Arc<Mutex<HashMap<String, broadcast::Sender<bytes::Bytes>>>>,
    /// 会话映射:combo_session_id → claude_session_id
    sessions: Arc<Mutex<HashMap<String, String>>>,
}

impl ClaudeCodeBackend {
    pub fn new(bin: String) -> Self {
        Self {
            bin,
            brokers: Arc::new(Mutex::new(HashMap::new())),
            sessions: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// 获取或创建 workspace 的事件 broker。
    async fn get_broker(&self, workspace_id: &str) -> broadcast::Sender<bytes::Bytes> {
        let mut brokers = self.brokers.lock().await;
        brokers
            .entry(workspace_id.to_string())
            .or_insert_with(|| {
                let (tx, _rx) = broadcast::channel::<bytes::Bytes>(256);
                tx
            })
            .clone()
    }
}

#[async_trait::async_trait]
impl Backend for ClaudeCodeBackend {
    fn backend_type(&self) -> BackendType {
        BackendType::ClaudeCode
    }

    async fn forward(
        &self,
        method: Method,
        path_query: &str,
        _headers: &HeaderMap,
        body: Vec<u8>,
    ) -> Result<Response> {
        let path = path_query.split('?').next().unwrap_or(path_query);
        let segments: Vec<&str> = path.trim_start_matches('/').split('/').collect();

        // /v1/health → 始终返回 OK（进程型后端没有独立健康端点）
        if path == "/v1/health" {
            return Ok(json_response(StatusCode::OK, &json!({ "status": "ok" })));
        }

        if segments.len() < 4 {
            return Ok(not_found("unsupported path"));
        }

        let ws_id = segments[2];
        let rest = &segments[3..];

        match rest {
            // GET sessions — 从内部状态返回
            ["sessions"] if method == Method::GET => {
                let sessions = self.sessions.lock().await;
                let arr: Vec<Value> = sessions
                    .keys()
                    .map(|sid| {
                        json!({
                            "id": sid,
                            "title": "Claude Code 会话",
                            "message_count": 0,
                            "prompt_tokens": 0,
                            "completion_tokens": 0,
                            "cost": 0,
                            "created_at": 0,
                            "updated_at": 0,
                        })
                    })
                    .collect();
                Ok(json_response(StatusCode::OK, &json!(arr)))
            }

            // POST sessions — 创建空会话（延迟到首次发消息）
            ["sessions"] if method == Method::POST => {
                let req_body: Value = serde_json::from_slice(&body).unwrap_or(json!({}));
                let title = req_body.get("title").and_then(|v| v.as_str()).unwrap_or("");
                let sid = format!("cc_{}", uuid_like());
                Ok(json_response(
                    StatusCode::OK,
                    &json!({ "id": sid, "title": title, "message_count": 0, "cost": 0, "created_at": 0, "updated_at": 0 }),
                ))
            }

            // GET history — 用 claude --resume --output-format json 获取
            ["sessions", sid, "history"] => {
                self.get_history(sid).await
            }

            // POST agent — 发送消息,spawn claude 进程
            ["agent"] => {
                self.send_message(ws_id, &body).await
            }

            // POST cancel — kill 对应进程（M1 简化:返回 OK）
            ["agent", "sessions", _sid, "cancel"] => {
                Ok(json_response(StatusCode::OK, &json!({ "ok": true })))
            }

            // SSE events — 订阅 broker
            ["events"] => {
                self.subscribe_sse(ws_id).await
            }

            // current-session — 本地无操作
            ["current-session"] => Ok(json_response(StatusCode::OK, &json!({}))),

            // permissions/grant — M1 简化
            ["permissions", "grant"] => Ok(json_response(StatusCode::OK, &json!({ "ok": true }))),

            // questions/answer — M1 简化
            ["questions", "answer"] => Ok(json_response(StatusCode::OK, &json!({ "ok": true }))),

            _ => Ok(not_found("unsupported path for claude code")),
        }
    }

    async fn workspace_root(&self, _id: &str) -> Result<PathBuf> {
        anyhow::bail!("ClaudeCode workspace_root should be resolved from MetaStore")
    }

    async fn health(&self) -> bool {
        // 检查二进制是否可用
        match Command::new(&self.bin)
            .arg("--version")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .await
        {
            Ok(s) => s.success(),
            Err(_) => false,
        }
    }
}

impl ClaudeCodeBackend {
    /// 发送消息:spawn claude 进程,后台翻译输出。
    async fn send_message(&self, ws_id: &str, body: &[u8]) -> Result<Response> {
        let req_body: Value = serde_json::from_slice(body).unwrap_or(json!({}));
        let session_id = req_body
            .get("session_id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let prompt = req_body
            .get("prompt")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        // 查找已有的 claude session_id
        let claude_sid = {
            let sessions = self.sessions.lock().await;
            sessions.get(&session_id).cloned()
        };

        // 构建命令
        let mut cmd = Command::new(&self.bin);
        cmd.arg("-p")
            .arg(&prompt)
            .arg("--output-format")
            .arg("stream-json")
            .arg("--verbose")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        if let Some(ref sid) = claude_sid {
            cmd.arg("--resume").arg(sid);
        }

        let mut child = cmd
            .spawn()
            .map_err(|e| anyhow::anyhow!("failed to spawn {}: {e}", self.bin))?;

        let stdout = child.stdout.take();
        let stderr = child.stderr.take();

        // 后台读取 stdout 并翻译
        if let Some(stdout) = stdout {
            let sessions = self.sessions.clone();
            let brokers = self.brokers.clone();
            let ws_id = ws_id.to_string();
            let combo_sid = session_id.clone();

            tokio::spawn(async move {
                let reader = tokio::io::BufReader::new(stdout);
                let mut text_acc = String::new();
                let mut claude_msg_id = String::new();

                use tokio::io::AsyncBufReadExt;
                let mut lines = reader.lines();

                while let Ok(Some(line)) = lines.next_line().await {
                    if line.trim().is_empty() {
                        continue;
                    }
                    let event: Value = match serde_json::from_str(&line) {
                        Ok(v) => v,
                        Err(_) => continue,
                    };

                    let etype = event.get("type").and_then(|v| v.as_str()).unwrap_or("");

                    match etype {
                        "system" => {
                            // init 事件 — 可选发一个 session created
                        }
                        "assistant" => {
                            // 完整助手消息 — 提取 text
                            claude_msg_id = event
                                .get("uuid")
                                .or_else(|| event.get("id"))
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string();
                            if let Some(content) = event.get("message").and_then(|m| m.get("content")).and_then(|c| c.as_array()) {
                                for block in content {
                                    if block.get("type").and_then(|v| v.as_str()) == Some("text") {
                                        let delta = block.get("text").and_then(|v| v.as_str()).unwrap_or("");
                                        text_acc.push_str(delta);
                                    }
                                }
                                let payload = msg_payload(&claude_msg_id, &combo_sid, &[json!({
                                    "type": "text", "data": { "text": &text_acc }
                                })]);
                                let _ = broadcast_send(&brokers, &ws_id, &sse_envelope("message", "updated", &payload)).await;
                            }
                        }
                        "stream_event" => {
                            // 增量 delta — 累积文本
                            if let Some(delta) = event
                                .pointer("/event/delta")
                            {
                                if delta.get("type").and_then(|v| v.as_str()) == Some("text_delta") {
                                    let text = delta.get("text").and_then(|v| v.as_str()).unwrap_or("");
                                    text_acc.push_str(text);
                                    let payload = msg_payload(&claude_msg_id, &combo_sid, &[json!({
                                        "type": "text", "data": { "text": &text_acc }
                                    })]);
                                    let _ = broadcast_send(&brokers, &ws_id, &sse_envelope("message", "updated", &payload)).await;
                                } else if delta.get("type").and_then(|v| v.as_str()) == Some("thinking_delta") {
                                    let thinking = delta.get("thinking").and_then(|v| v.as_str()).unwrap_or("");
                                    let payload = msg_payload(&claude_msg_id, &combo_sid, &[json!({
                                        "type": "reasoning", "data": { "thinking": thinking, "signature": "" }
                                    })]);
                                    let _ = broadcast_send(&brokers, &ws_id, &sse_envelope("message", "updated", &payload)).await;
                                }
                            }
                        }
                        "result" => {
                            // 最终结果 — 保存 session_id, 发 run_complete
                            let claude_session = event
                                .get("session_id")
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string();
                            if !claude_session.is_empty() {
                                sessions.lock().await.insert(combo_sid.clone(), claude_session);
                            }
                            let _ = broadcast_send(
                                &brokers,
                                &ws_id,
                                &sse_envelope("run_complete", "updated", &json!({ "session_id": &combo_sid })),
                            ).await;
                        }
                        _ => {}
                    }
                }

                // 确保子进程退出
                let _ = child.wait().await;
            });
        }

        // 后台消耗 stderr 防止管道阻塞
        if let Some(stderr) = stderr {
            tokio::spawn(async move {
                use tokio::io::AsyncReadExt;
                let mut buf = vec![0u8; 4096];
                let mut stderr = stderr;
                loop {
                    match stderr.read(&mut buf).await {
                        Ok(0) | Err(_) => break,
                        Ok(_) => {}
                    }
                }
            });
        }

        Ok(json_response(StatusCode::OK, &json!({ "ok": true })))
    }

    /// 获取会话历史。
    async fn get_history(&self, sid: &str) -> Result<Response> {
        let claude_sid = {
            let sessions = self.sessions.lock().await;
            sessions.get(sid).cloned()
        };

        let messages = if let Some(claude_sid) = claude_sid {
            // 运行 claude --resume <sid> --output-format json 获取历史
            let output = Command::new(&self.bin)
                .arg("--resume")
                .arg(&claude_sid)
                .arg("--output-format")
                .arg("json")
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .output()
                .await;

            match output {
                Ok(out) if out.status.success() => {
                    let v: Value = serde_json::from_slice(&out.stdout).unwrap_or_default();
                    // claude --output-format json 返回 { result, session_id, ... }
                    // 简化:返回单条消息
                    let result_text = v
                        .get("result")
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    vec![json!({
                        "id": "msg_result",
                        "role": "assistant",
                        "session_id": sid,
                        "parts": [{ "type": "text", "data": { "text": result_text } }],
                        "model": "",
                        "provider": "",
                        "created_at": 0,
                        "updated_at": 0,
                    })]
                }
                _ => vec![],
            }
        } else {
            vec![]
        };

        Ok(json_response(
            StatusCode::OK,
            &json!({ "messages": messages }),
        ))
    }

    /// 订阅事件 broker,返回 SSE 流。
    async fn subscribe_sse(&self, ws_id: &str) -> Result<Response> {
        let broker = self.get_broker(ws_id).await;
        let rx = broker.subscribe();

        let stream = tokio_stream::wrappers::BroadcastStream::new(rx)
            .map(|r| match r {
                Ok(data) => Ok(data),
                Err(_) => Err(std::io::Error::new(std::io::ErrorKind::Other, "lagged")),
            });

        Ok(Response::builder()
            .status(StatusCode::OK)
            .header("content-type", "text/event-stream")
            .header("cache-control", "no-cache")
            .body(Body::from_stream(stream))?)
    }
}

// ── 辅助函数 ───────────────────────────────────────────────────────

async fn broadcast_send(
    brokers: &Arc<Mutex<HashMap<String, broadcast::Sender<bytes::Bytes>>>>,
    ws_id: &str,
    data: &str,
) -> Result<()> {
    let brokers = brokers.lock().await;
    if let Some(tx) = brokers.get(ws_id) {
        let _ = tx.send(bytes::Bytes::from(data.to_string()));
    }
    Ok(())
}

fn sse_envelope(event_type: &str, kind: &str, payload: &Value) -> String {
    let envelope = json!({
        "type": event_type,
        "payload": { "type": kind, "payload": payload }
    });
    format!(
        "data: {}\n\n",
        serde_json::to_string(&envelope).unwrap_or_default()
    )
}

fn msg_payload(msg_id: &str, session_id: &str, parts: &[Value]) -> Value {
    json!({
        "id": msg_id,
        "role": "assistant",
        "session_id": session_id,
        "parts": parts,
        "model": "",
        "provider": "",
        "created_at": 0,
        "updated_at": 0,
    })
}

fn json_response(status: StatusCode, value: &Value) -> Response {
    Response::builder()
        .status(status)
        .header("content-type", "application/json")
        .body(Body::from(value.to_string()))
        .unwrap()
}

fn not_found(msg: &str) -> Response {
    json_response(
        StatusCode::NOT_FOUND,
        &json!({ "message": msg }),
    )
}

fn uuid_like() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{:x}", nanos)
}
