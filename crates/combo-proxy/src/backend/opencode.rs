//! OpenCode 后端适配器。
//!
//! OpenCode 暴露 HTTP REST API(`opencode serve`)。本模块把 combo 的
//! `/v1/workspaces/{id}/*` 协议翻译成 OpenCode 的 `/session/*` API,
//! 并把 OpenCode 的 SSE 事件翻译成 crush 的双层信封格式。

use crate::backend::{Backend, BackendType};
use anyhow::Result;
use axum::body::Body;
use axum::http::{HeaderMap, Method, StatusCode};
use axum::response::Response;
use futures_util::StreamExt;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;

pub struct OpenCodeBackend {
    base_url: String,
}

impl OpenCodeBackend {
    pub fn new(base_url: String) -> Self {
        Self { base_url }
    }
}

#[async_trait::async_trait]
impl Backend for OpenCodeBackend {
    fn backend_type(&self) -> BackendType {
        BackendType::OpenCode
    }

    async fn forward(
        &self,
        method: Method,
        path_query: &str,
        _headers: &HeaderMap,
        body: Vec<u8>,
    ) -> Result<Response> {
        let client = reqwest::Client::new();
        let path = path_query.split('?').next().unwrap_or(path_query);
        let segments: Vec<&str> = path.trim_start_matches('/').split('/').collect();

        if path == "/v1/health" {
            return forward_raw(&client, &self.base_url, Method::GET, "/global/health", &[])
                .await;
        }

        self.dispatch(&client, &method, &segments, path_query, &body)
            .await
    }

    async fn workspace_root(&self, _id: &str) -> Result<PathBuf> {
        anyhow::bail!("OpenCode workspace_root should be resolved from MetaStore")
    }

    async fn health(&self) -> bool {
        let url = format!("{}/global/health", self.base_url);
        match reqwest::get(&url).await {
            Ok(r) => r.status().is_success(),
            Err(_) => false,
        }
    }
}

impl OpenCodeBackend {
    async fn dispatch(
        &self,
        client: &reqwest::Client,
        method: &Method,
        segments: &[&str],
        path_query: &str,
        body: &[u8],
    ) -> Result<Response> {
        if segments.len() < 4 {
            return Ok(not_found("unsupported path"));
        }

        let rest = &segments[3..];

        match rest {
            ["sessions"] => {
                if method == Method::GET {
                    self.list_sessions(client).await
                } else if method == Method::POST {
                    self.create_session(client, body).await
                } else {
                    Ok(method_not_allowed())
                }
            }
            ["sessions", sid, "history"] => self.get_history(client, sid).await,
            ["agent"] => self.send_message(client, body).await,
            ["agent", "sessions", sid, "cancel"] => self.cancel(client, sid).await,
            ["events"] => self.proxy_sse(client).await,
            ["current-session"] => Ok(ok_json(&json!({}))),
            ["permissions", "grant"] => self.grant_permission(client, body).await,
            ["questions", "answer"] => Ok(ok_json(&json!({ "ok": true }))),
            _ => {
                let oc_path = format!("/{}", rest.join("/"));
                self.proxy_raw(client, method, &oc_path, path_query, body).await
            }
        }
    }

    async fn list_sessions(&self, client: &reqwest::Client) -> Result<Response> {
        let url = format!("{}/session", self.base_url);
        let resp = client.get(&url).send().await?;
        let status = resp.status();
        let oc_sessions: Vec<Value> = resp.json().await.unwrap_or_default();
        let combo: Vec<Value> = oc_sessions.iter().map(map_session).collect();
        Ok(json_response(status, &json!(combo)))
    }

    async fn create_session(&self, client: &reqwest::Client, body: &[u8]) -> Result<Response> {
        let req_body: Value = serde_json::from_slice(body).unwrap_or(json!({}));
        let title = req_body.get("title").and_then(|t| t.as_str()).unwrap_or("");
        let url = format!("{}/session", self.base_url);
        let resp = client.post(&url).json(&json!({ "title": title })).send().await?;
        let status = resp.status();
        let oc_session: Value = resp.json().await.unwrap_or_default();
        Ok(json_response(status, &map_session(&oc_session)))
    }

    async fn get_history(&self, client: &reqwest::Client, sid: &str) -> Result<Response> {
        let url = format!("{}/session/{}/message", self.base_url, sid);
        let resp = client.get(&url).send().await?;
        let status = resp.status();
        let oc_msgs: Vec<Value> = resp.json().await.unwrap_or_default();
        let combo_msgs: Vec<Value> = oc_msgs.iter().map(map_message).collect();
        Ok(json_response(status, &json!({ "messages": combo_msgs })))
    }

    async fn send_message(&self, client: &reqwest::Client, body: &[u8]) -> Result<Response> {
        let req_body: Value = serde_json::from_slice(body).unwrap_or(json!({}));
        let session_id = req_body.get("session_id").and_then(|v| v.as_str()).unwrap_or("");
        let prompt = req_body.get("prompt").and_then(|v| v.as_str()).unwrap_or("");
        let oc_body = json!({ "parts": [{ "type": "text", "text": prompt }] });
        let url = format!("{}/session/{}/prompt_async", self.base_url, session_id);
        let _ = client.post(&url).json(&oc_body).send().await?;
        Ok(ok_json(&json!({ "ok": true })))
    }

    async fn cancel(&self, client: &reqwest::Client, sid: &str) -> Result<Response> {
        let url = format!("{}/session/{}/abort", self.base_url, sid);
        let _ = client.post(&url).send().await?;
        Ok(ok_json(&json!({ "ok": true })))
    }

    async fn grant_permission(&self, client: &reqwest::Client, body: &[u8]) -> Result<Response> {
        let req_body: Value = serde_json::from_slice(body).unwrap_or(json!({}));
        let permission = req_body.get("permission").cloned().unwrap_or(json!({}));
        let action = req_body.get("action").and_then(|v| v.as_str()).unwrap_or("deny");
        let req_id = permission.get("id").and_then(|v| v.as_str()).unwrap_or("");
        let oc_response = match action {
            "allow" => "once",
            "allow_session" => "always",
            _ => "reject",
        };
        let url = format!("{}/permission/{}/reply", self.base_url, req_id);
        let _ = client
            .post(&url)
            .json(&json!({ "response": oc_response }))
            .send()
            .await?;
        Ok(ok_json(&json!({ "ok": true })))
    }

    async fn proxy_sse(&self, client: &reqwest::Client) -> Result<Response> {
        let url = format!("{}/event", self.base_url);
        let resp = client
            .get(&url)
            .header("accept", "text/event-stream")
            .send()
            .await?;

        if !resp.status().is_success() {
            return Ok(json_response(
                StatusCode::BAD_GATEWAY,
                &json!({ "message": "opencode SSE unavailable" }),
            ));
        }

        let byte_stream = resp.bytes_stream();
        let translated = translate_sse_stream(byte_stream);

        Ok(Response::builder()
            .status(StatusCode::OK)
            .header("content-type", "text/event-stream")
            .header("cache-control", "no-cache")
            .body(Body::from_stream(translated))?)
    }

    async fn proxy_raw(
        &self,
        client: &reqwest::Client,
        method: &Method,
        oc_path: &str,
        original_path_query: &str,
        body: &[u8],
    ) -> Result<Response> {
        let query = original_path_query
            .split_once('?')
            .map(|(_, q)| format!("?{q}"))
            .unwrap_or_default();
        let url = format!("{}{}{}", self.base_url, oc_path, query);
        let resp = client
            .request(
                reqwest::Method::from_bytes(method.as_str().as_bytes())
                    .unwrap_or(reqwest::Method::GET),
                &url,
            )
            .body(body.to_vec())
            .send()
            .await?;
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        Ok(Response::builder()
            .status(status)
            .header("content-type", "application/json")
            .body(Body::from(text))?)
    }
}

// ── SSE 翻译 ───────────────────────────────────────────────────────

/// 将 OpenCode SSE 字节流翻译为 crush 双层信封 SSE 字节流。
fn translate_sse_stream(
    byte_stream: impl futures_util::Stream<Item = Result<bytes::Bytes, reqwest::Error>>,
) -> impl futures_util::Stream<Item = Result<bytes::Bytes, std::io::Error>> {
    let mut text_acc: HashMap<String, String> = HashMap::new();
    let mut buffer = String::new();

    byte_stream.filter_map(move |chunk| {
        let chunk = match chunk {
            Ok(c) => c,
            Err(_) => return std::future::ready(None),
        };
        buffer.push_str(&String::from_utf8_lossy(&chunk));

        let mut outputs = Vec::new();

        while let Some(pos) = buffer.find("\n\n") {
            let frame = buffer[..pos].to_string();
            buffer = buffer[pos + 2..].to_string();

            let data_line = frame
                .lines()
                .find_map(|line| {
                    line.strip_prefix("data: ")
                        .or_else(|| line.strip_prefix("data:"))
                })
                .unwrap_or("");

            if data_line.is_empty() {
                continue;
            }

            let event: Value = match serde_json::from_str(data_line) {
                Ok(v) => v,
                Err(_) => continue,
            };

            let etype = event.get("type").and_then(|v| v.as_str()).unwrap_or("");
            let props = event.get("properties").cloned().unwrap_or(json!({}));

            if let Some(translated) = translate_sse_event(etype, &props, &mut text_acc) {
                outputs.push(translated);
            }
        }

        if outputs.is_empty() {
            std::future::ready(None)
        } else {
            std::future::ready(Some(Ok(bytes::Bytes::from(outputs.join("")))))
        }
    })
}

/// 翻译单个 OpenCode SSE 事件为 crush 双层信封字符串。
fn translate_sse_event(
    etype: &str,
    props: &Value,
    text_acc: &mut HashMap<String, String>,
) -> Option<String> {
    let session_id = props.get("sessionID").and_then(|v| v.as_str()).unwrap_or("");
    let msg_id = props
        .get("assistantMessageID")
        .or_else(|| props.get("messageID"))
        .and_then(|v| v.as_str())
        .unwrap_or("");

    match etype {
        "session.next.text.delta" => {
            let delta = props.get("delta").and_then(|v| v.as_str()).unwrap_or("");
            let text_id = props.get("textID").and_then(|v| v.as_str()).unwrap_or(msg_id);
            let acc = text_acc.entry(text_id.to_string()).or_default();
            acc.push_str(delta);
            let payload = msg_payload(msg_id, session_id, &[json!({
                "type": "text",
                "data": { "text": acc }
            })]);
            Some(sse_envelope("message", "updated", &payload))
        }

        "session.next.reasoning.delta" => {
            let delta = props.get("delta").and_then(|v| v.as_str()).unwrap_or("");
            let rid = props.get("reasoningID").and_then(|v| v.as_str()).unwrap_or(msg_id);
            let key = format!("r:{}", rid);
            let acc = text_acc.entry(key).or_default();
            acc.push_str(delta);
            let payload = msg_payload(msg_id, session_id, &[json!({
                "type": "reasoning",
                "data": { "thinking": acc, "signature": "" }
            })]);
            Some(sse_envelope("message", "updated", &payload))
        }

        "session.next.tool.called" => {
            let call_id = props.get("callID").and_then(|v| v.as_str()).unwrap_or("");
            let tool = props.get("tool").and_then(|v| v.as_str()).unwrap_or("unknown");
            let input = props.get("input").map(|v| v.to_string()).unwrap_or_default();
            let payload = msg_payload(msg_id, session_id, &[json!({
                "type": "tool_call",
                "data": { "id": call_id, "name": tool, "input": input }
            })]);
            Some(sse_envelope("message", "updated", &payload))
        }

        "session.next.tool.success" => {
            let call_id = props.get("callID").and_then(|v| v.as_str()).unwrap_or("");
            let tool = props.get("tool").and_then(|v| v.as_str()).unwrap_or("unknown");
            let content = props
                .get("content")
                .and_then(|v| v.as_array())
                .and_then(|arr| arr.first())
                .and_then(|c| c.get("text"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let payload = msg_payload(msg_id, session_id, &[json!({
                "type": "tool_result",
                "data": { "tool_call_id": call_id, "name": tool, "content": content }
            })]);
            Some(sse_envelope("message", "updated", &payload))
        }

        "session.next.tool.failed" => {
            let call_id = props.get("callID").and_then(|v| v.as_str()).unwrap_or("");
            let tool = props.get("tool").and_then(|v| v.as_str()).unwrap_or("unknown");
            let error = props
                .pointer("/error/message")
                .and_then(|v| v.as_str())
                .unwrap_or("tool failed");
            let payload = msg_payload(msg_id, session_id, &[json!({
                "type": "tool_result",
                "data": { "tool_call_id": call_id, "name": tool, "content": error, "is_error": true }
            })]);
            Some(sse_envelope("message", "updated", &payload))
        }

        "session.idle" => Some(sse_envelope(
            "run_complete",
            "updated",
            &json!({ "session_id": session_id }),
        )),

        "permission.asked" => {
            let perm_id = props.get("id").and_then(|v| v.as_str()).unwrap_or("");
            let permission = props.get("permission").and_then(|v| v.as_str()).unwrap_or("");
            let patterns = props.get("patterns").cloned().unwrap_or(json!([]));
            let call_id = props
                .get("tool")
                .and_then(|t| t.get("callID"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let payload = json!({
                "id": perm_id,
                "session_id": session_id,
                "tool_call_id": call_id,
                "tool_name": permission,
                "description": format!("OpenCode 权限请求: {} {:?}", permission, patterns),
                "action": permission,
                "params": {},
                "path": "",
            });
            Some(sse_envelope("permission_request", "created", &payload))
        }

        "session.created" => {
            let info = props.get("info").cloned().unwrap_or_default();
            Some(sse_envelope("session", "created", &map_session(&info)))
        }

        "session.updated" => {
            let info = props.get("info").cloned().unwrap_or_default();
            Some(sse_envelope("session", "updated", &map_session(&info)))
        }

        _ => None,
    }
}

// ── 辅助函数 ───────────────────────────────────────────────────────

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

fn map_session(oc: &Value) -> Value {
    let created = oc.pointer("/time/created").and_then(|v| v.as_u64()).unwrap_or(0);
    let updated = oc.pointer("/time/updated").and_then(|v| v.as_u64()).unwrap_or(0);
    json!({
        "id": oc.get("id").cloned().unwrap_or_default(),
        "title": oc.get("title").cloned().unwrap_or_default(),
        "message_count": 0,
        "prompt_tokens": 0,
        "completion_tokens": 0,
        "cost": 0,
        "created_at": created / 1000,
        "updated_at": updated / 1000,
    })
}

fn map_message(oc_msg: &Value) -> Value {
    let info = oc_msg.get("info").cloned().unwrap_or_default();
    let parts = oc_msg
        .get("parts")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let combo_parts: Vec<Value> = parts.iter().filter_map(map_part).collect();
    let created = info.pointer("/time/created").and_then(|v| v.as_u64()).unwrap_or(0);
    let completed = info.pointer("/time/completed").and_then(|v| v.as_u64()).unwrap_or(created);
    json!({
        "id": info.get("id").cloned().unwrap_or_default(),
        "role": info.get("role").cloned().unwrap_or_default(),
        "session_id": info.get("sessionID").cloned().unwrap_or_default(),
        "parts": combo_parts,
        "model": info.get("modelID").cloned().unwrap_or_default(),
        "provider": info.get("providerID").cloned().unwrap_or_default(),
        "created_at": created / 1000,
        "updated_at": completed / 1000,
    })
}

fn map_part(part: &Value) -> Option<Value> {
    let ptype = part.get("type").and_then(|v| v.as_str())?;
    match ptype {
        "text" => {
            let text = part.get("text").and_then(|v| v.as_str()).unwrap_or("");
            Some(json!({ "type": "text", "data": { "text": text } }))
        }
        "reasoning" => {
            let text = part.get("text").and_then(|v| v.as_str()).unwrap_or("");
            Some(json!({ "type": "reasoning", "data": { "thinking": text, "signature": "" } }))
        }
        "tool" => {
            let tool = part.get("tool").and_then(|v| v.as_str()).unwrap_or("unknown");
            let call_id = part.get("callID").and_then(|v| v.as_str()).unwrap_or("");
            let state = part.get("state").cloned().unwrap_or_default();
            let status = state.get("status").and_then(|v| v.as_str()).unwrap_or("");
            match status {
                "completed" => {
                    let output = state.get("output").and_then(|v| v.as_str()).unwrap_or("");
                    Some(json!({ "type": "tool_result", "data": {
                        "tool_call_id": call_id, "name": tool, "content": output
                    }}))
                }
                "error" => {
                    let error = state.get("error").and_then(|v| v.as_str()).unwrap_or("");
                    Some(json!({ "type": "tool_result", "data": {
                        "tool_call_id": call_id, "name": tool, "content": error, "is_error": true
                    }}))
                }
                _ => {
                    let input = state.get("input").map(|v| v.to_string()).unwrap_or_default();
                    Some(json!({ "type": "tool_call", "data": {
                        "id": call_id, "name": tool, "input": input
                    }}))
                }
            }
        }
        "step-finish" => {
            let reason = part.get("reason").and_then(|v| v.as_str()).unwrap_or("");
            Some(json!({ "type": "finish", "data": { "reason": reason } }))
        }
        _ => None,
    }
}

fn json_response(status: StatusCode, value: &Value) -> Response {
    Response::builder()
        .status(status)
        .header("content-type", "application/json")
        .body(Body::from(value.to_string()))
        .unwrap()
}

fn ok_json(value: &Value) -> Response {
    json_response(StatusCode::OK, value)
}

fn not_found(msg: &str) -> Response {
    json_response(StatusCode::NOT_FOUND, &json!({ "message": msg }))
}

fn method_not_allowed() -> Response {
    json_response(
        StatusCode::METHOD_NOT_ALLOWED,
        &json!({ "message": "method not allowed" }),
    )
}

async fn forward_raw(
    client: &reqwest::Client,
    base_url: &str,
    method: Method,
    path: &str,
    body: &[u8],
) -> Result<Response> {
    let url = format!("{}{}", base_url, path);
    let resp = client
        .request(
            reqwest::Method::from_bytes(method.as_str().as_bytes())
                .unwrap_or(reqwest::Method::GET),
            &url,
        )
        .body(body.to_vec())
        .send()
        .await?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    Ok(Response::builder()
        .status(status)
        .header("content-type", "application/json")
        .body(Body::from(text))?)
}
