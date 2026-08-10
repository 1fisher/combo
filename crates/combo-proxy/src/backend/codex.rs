//! Codex (OpenAI) 后端适配器。
//!
//! Codex 通过 `codex exec --json` 产生 newline-delimited JSON 事件流。
//! 与 Claude Code 类似,为每条消息 spawn 子进程,解析输出翻译为
//! combo 双层信封,通过 broadcast channel 推给 SSE 连接。

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

pub struct CodexBackend {
    bin: String,
    brokers: Arc<Mutex<HashMap<String, broadcast::Sender<bytes::Bytes>>>>,
    /// combo_session_id → codex thread_id
    threads: Arc<Mutex<HashMap<String, String>>>,
}

impl CodexBackend {
    pub fn new(bin: String) -> Self {
        Self {
            bin,
            brokers: Arc::new(Mutex::new(HashMap::new())),
            threads: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    async fn get_broker(&self, ws_id: &str) -> broadcast::Sender<bytes::Bytes> {
        let mut brokers = self.brokers.lock().await;
        brokers
            .entry(ws_id.to_string())
            .or_insert_with(|| broadcast::channel::<bytes::Bytes>(256).0)
            .clone()
    }
}

#[async_trait::async_trait]
impl Backend for CodexBackend {
    fn backend_type(&self) -> BackendType {
        BackendType::Codex
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

        if path == "/v1/health" {
            return Ok(json_response(StatusCode::OK, &json!({ "status": "ok" })));
        }

        if segments.len() < 4 {
            return Ok(not_found("unsupported path"));
        }

        let ws_id = segments[2];
        let rest = &segments[3..];

        match rest {
            ["sessions"] if method == Method::GET => {
                let threads = self.threads.lock().await;
                let arr: Vec<Value> = threads
                    .keys()
                    .map(|sid| {
                        json!({
                            "id": sid,
                            "title": "Codex 会话",
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
            ["sessions"] if method == Method::POST => {
                let req_body: Value = serde_json::from_slice(&body).unwrap_or(json!({}));
                let title = req_body.get("title").and_then(|v| v.as_str()).unwrap_or("");
                let sid = format!("cx_{}", uuid_like());
                Ok(json_response(
                    StatusCode::OK,
                    &json!({ "id": sid, "title": title, "message_count": 0, "cost": 0, "created_at": 0, "updated_at": 0 }),
                ))
            }
            ["sessions", _sid, "history"] => {
                Ok(json_response(StatusCode::OK, &json!({ "messages": [] })))
            }
            ["agent"] => self.send_message(ws_id, &body).await,
            ["agent", "sessions", _sid, "cancel"] => {
                Ok(json_response(StatusCode::OK, &json!({ "ok": true })))
            }
            ["events"] => self.subscribe_sse(ws_id).await,
            ["current-session"] => Ok(json_response(StatusCode::OK, &json!({}))),
            ["permissions", "grant"] => Ok(json_response(StatusCode::OK, &json!({ "ok": true }))),
            ["questions", "answer"] => Ok(json_response(StatusCode::OK, &json!({ "ok": true }))),
            _ => Ok(not_found("unsupported path for codex")),
        }
    }

    async fn workspace_root(&self, _id: &str) -> Result<PathBuf> {
        anyhow::bail!("Codex workspace_root should be resolved from MetaStore")
    }

    async fn health(&self) -> bool {
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

impl CodexBackend {
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

        let mut child = Command::new(&self.bin)
            .arg("exec")
            .arg("--json")
            .arg(&prompt)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| anyhow::anyhow!("failed to spawn {}: {e}", self.bin))?;

        let stdout = child.stdout.take();
        let stderr = child.stderr.take();

        if let Some(stdout) = stdout {
            let threads = self.threads.clone();
            let brokers = self.brokers.clone();
            let ws_id = ws_id.to_string();
            let combo_sid = session_id.clone();

            tokio::spawn(async move {
                use tokio::io::{AsyncBufReadExt, BufReader};
                let reader = BufReader::new(stdout);
                let mut lines = reader.lines();
                let mut item_id = String::new();

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
                        "thread.started" => {
                            let tid = event.get("thread_id").and_then(|v| v.as_str()).unwrap_or("");
                            if !tid.is_empty() {
                                threads.lock().await.insert(combo_sid.clone(), tid.to_string());
                            }
                        }
                        "item.started" | "item.updated" => {
                            let item = event.get("item").cloned().unwrap_or_default();
                            item_id = item.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                            let itype = item.get("type").and_then(|v| v.as_str()).unwrap_or("");

                            if itype == "agent_message" {
                                if let Some(text) = item.get("text").and_then(|v| v.as_str()) {
                                    let payload = msg_payload(&item_id, &combo_sid, &[json!({
                                        "type": "text", "data": { "text": text }
                                    })]);
                                    let _ = broadcast_send(&brokers, &ws_id, &sse_envelope("message", "updated", &payload)).await;
                                }
                            } else if itype == "command_execution" {
                                let cmd = item.get("command").and_then(|v| v.as_str()).unwrap_or("");
                                let payload = msg_payload(&item_id, &combo_sid, &[json!({
                                    "type": "tool_call", "data": { "id": &item_id, "name": "bash", "input": cmd }
                                })]);
                                let _ = broadcast_send(&brokers, &ws_id, &sse_envelope("message", "updated", &payload)).await;
                            }
                        }
                        "item.completed" => {
                            let item = event.get("item").cloned().unwrap_or_default();
                            let itype = item.get("type").and_then(|v| v.as_str()).unwrap_or("");

                            if itype == "agent_message" {
                                let text = item.get("text").and_then(|v| v.as_str()).unwrap_or("");
                                let payload = msg_payload(&item_id, &combo_sid, &[json!({
                                    "type": "text", "data": { "text": text }
                                })]);
                                let _ = broadcast_send(&brokers, &ws_id, &sse_envelope("message", "updated", &payload)).await;
                            } else if itype == "command_execution" {
                                let result = item.get("output").and_then(|v| v.as_str()).unwrap_or("");
                                let payload = msg_payload(&item_id, &combo_sid, &[json!({
                                    "type": "tool_result", "data": { "tool_call_id": &item_id, "name": "bash", "content": result }
                                })]);
                                let _ = broadcast_send(&brokers, &ws_id, &sse_envelope("message", "updated", &payload)).await;
                            }
                        }
                        "turn.completed" => {
                            let _ = broadcast_send(
                                &brokers,
                                &ws_id,
                                &sse_envelope("run_complete", "updated", &json!({ "session_id": &combo_sid })),
                            ).await;
                        }
                        _ => {}
                    }
                }

                let _ = child.wait().await;
            });
        }

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
    json_response(StatusCode::NOT_FOUND, &json!({ "message": msg }))
}

fn uuid_like() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{:x}", nanos)
}
