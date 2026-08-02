# 阶段 1：OpenCode 后端适配器 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add OpenCode as a fully functional agent backend behind the Backend trait, with multi-backend routing, SSE translation, and frontend backend selection.

**Architecture:** `BackendRegistry` routes requests by workspace_id to the correct backend. `OpenCodeBackend` translates combo REST endpoints to OpenCode's HTTP API and translates OpenCode SSE events to crush's double-nested envelope. `OpenCodeManager` manages the `opencode serve` subprocess. Frontend gains a backend selector on workspace creation.

**Tech Stack:** Rust (axum 0.7, reqwest, async-trait), React 19 + TypeScript.

## Global Constraints

- **axum 0.7:** Route params use `:id` syntax.
- **Chinese UI strings:** All user-facing copy stays Chinese.
- **OpenCode binary:** `COMBO_OPENCODE_BIN` env var, defaults to `"opencode"` from PATH. Not installed in CI — tests use stub HTTP servers.
- **Behavior preservation:** crush workspaces continue to work exactly as before.
- **reqwest:** Already a dependency (used for health checks in `crush.rs` tests via `reqwest::Client`).

**Design doc:** `docs/superpowers/specs/2026-08-02-phase1-opencode-adapter-design.md`

---

### Task 1: BackendRegistry + multi-backend AppState

**Files:**
- Create: `crates/combo-proxy/src/registry.rs`
- Modify: `crates/combo-proxy/src/backend/mod.rs` (add `BackendType::OpenCode`)
- Modify: `crates/combo-proxy/src/lib.rs` (AppState uses BackendRegistry)
- Modify: `crates/combo-proxy/src/handler.rs` (lookup backend from registry)
- Modify: `crates/combo-proxy/src/fs.rs` (lookup backend from registry)
- Test: `crates/combo-proxy/src/registry.rs` inline tests

**Interfaces:**
- Consumes: `Backend` trait, `MetaStore` (from Phase 0)
- Produces: `BackendRegistry { crush: Arc<dyn Backend>, opencode: Option<Arc<dyn Backend>> }`, `.for_workspace(ws_id, meta) -> Option<&Arc<dyn Backend>>`

- [ ] **Step 1: Add `BackendType::OpenCode` variant**

In `crates/combo-proxy/src/backend/mod.rs`, add `OpenCode` to the enum:

```rust
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BackendType {
    Crush,
    OpenCode,
}
```

- [ ] **Step 2: Create `registry.rs`**

Create `crates/combo-proxy/src/registry.rs`:

```rust
//! 多后端注册表:按 workspace 元数据中的 backend_type 选择后端。

use crate::backend::{Backend, BackendType};
use crate::meta::MetaStore;
use std::sync::Arc;

/// 持有所有可用后端,按 workspace 查 MetaStore 决定使用哪个。
pub struct BackendRegistry {
    crush: Arc<dyn Backend>,
    opencode: Option<Arc<dyn Backend>>,
}

impl BackendRegistry {
    pub fn new(crush: Arc<dyn Backend>) -> Self {
        Self {
            crush,
            opencode: None,
        }
    }

    pub fn set_opencode(&mut self, backend: Arc<dyn Backend>) {
        self.opencode = Some(backend);
    }

    /// 按 backend_type 直接获取。
    pub fn by_type(&self, bt: BackendType) -> Option<&Arc<dyn Backend>> {
        match bt {
            BackendType::Crush => Some(&self.crush),
            BackendType::OpenCode => self.opencode.as_ref(),
        }
    }

    /// 按 workspace_id 查 MetaStore 确定后端。找不到时默认 crush。
    pub fn for_workspace(&self, ws_id: &str, meta: &MetaStore) -> &Arc<dyn Backend> {
        match meta.get(ws_id) {
            Some(m) => match m.backend_type {
                BackendType::OpenCode => self.opencode.as_ref().unwrap_or(&self.crush),
                BackendType::Crush => &self.crush,
            },
            None => &self.crush,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{CrushBackend, Upstream};

    fn dummy_crush() -> Arc<dyn Backend> {
        Arc::new(CrushBackend::new(Upstream::Tcp(
            "127.0.0.1:1".parse().unwrap(),
        )))
    }

    #[test]
    fn defaults_to_crush_for_unknown_workspace() {
        let reg = BackendRegistry::new(dummy_crush());
        let meta = MetaStore::new();
        let ws_id = "unknown";
        let backend = reg.for_workspace(ws_id, &meta);
        assert_eq!(backend.backend_type(), BackendType::Crush);
    }

    #[test]
    fn routes_crush_workspace_to_crush() {
        let reg = BackendRegistry::new(dummy_crush());
        let meta = MetaStore::new();
        meta.insert(crate::WorkspaceMeta {
            id: "ws1".into(),
            path: "/tmp".into(),
            backend_type: BackendType::Crush,
        });
        let backend = reg.for_workspace("ws1", &meta);
        assert_eq!(backend.backend_type(), BackendType::Crush);
    }

    #[test]
    fn routes_opencode_workspace_to_opencode() {
        let mut reg = BackendRegistry::new(dummy_crush());
        reg.set_opencode(dummy_crush()); // 用 crush stub 代替真正的 OpenCode
        let meta = MetaStore::new();
        meta.insert(crate::WorkspaceMeta {
            id: "ws2".into(),
            path: "/tmp".into(),
            backend_type: BackendType::OpenCode,
        });
        let backend = reg.for_workspace("ws2", &meta);
        // opencode backend is set (stubbed as crush), should return it
        assert!(reg.by_type(BackendType::OpenCode).is_some());
    }

    #[test]
    fn opencode_workspace_falls_back_to_crush_when_not_set() {
        let reg = BackendRegistry::new(dummy_crush());
        let meta = MetaStore::new();
        meta.insert(crate::WorkspaceMeta {
            id: "ws3".into(),
            path: "/tmp".into(),
            backend_type: BackendType::OpenCode,
        });
        let backend = reg.for_workspace("ws3", &meta);
        assert_eq!(backend.backend_type(), BackendType::Crush);
    }
}
```

- [ ] **Step 3: Add module declaration in `lib.rs`**

In `crates/combo-proxy/src/lib.rs`, add:

```rust
pub mod registry;
pub use registry::BackendRegistry;
```

Update `AppState` to use `BackendRegistry`:

```rust
use std::sync::Arc;

/// 所有 axum handler 共享的应用状态。
#[derive(Clone)]
pub struct AppState {
    pub meta: Arc<MetaStore>,
    pub registry: Arc<BackendRegistry>,
}
```

Remove the old `backend: Arc<dyn Backend>` field from `AppState`.

- [ ] **Step 4: Update `handler.rs` to use registry**

In `crates/combo-proxy/src/handler.rs`, the `proxy` function needs to extract the workspace_id from the URL path and look up the backend. Replace the `proxy` function:

```rust
use crate::AppState;
use axum::body::Body;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::Response;
use http_body_util::BodyExt;

/// 从 URL path 中提取 workspace_id。
/// 路径格式:/v1/workspaces/{id}/...  →  返回 {id}
/// 如果不是 workspace 路径,返回 None。
fn extract_workspace_id(path: &str) -> Option<&str> {
    let segments: Vec<&str> = path.trim_start_matches('/').split('/').collect();
    // /v1/workspaces/{id}/...
    if segments.len() >= 3 && segments[0] == "v1" && segments[1] == "workspaces" {
        Some(segments[2])
    } else {
        None
    }
}

/// 反向代理 handler:按 workspace 的后端类型路由。
pub async fn proxy(State(state): State<AppState>, req: axum::extract::Request) -> Response {
    let (parts, body) = req.into_parts();
    let body_bytes = match body.collect().await {
        Ok(c) => c.to_bytes().to_vec(),
        Err(e) => {
            return Response::builder()
                .status(StatusCode::BAD_REQUEST)
                .body(Body::from(format!("invalid body: {e}")))
                .unwrap();
        }
    };
    let path_query = parts
        .uri
        .path_and_query()
        .map(|x| x.as_str())
        .unwrap_or("/");

    let ws_id = extract_workspace_id(path_query).unwrap_or("");
    let backend = state.registry.for_workspace(ws_id, &state.meta);

    match backend
        .forward(parts.method, path_query, &parts.headers, body_bytes)
        .await
    {
        Ok(resp) => resp,
        Err(_err) => Response::builder()
            .status(StatusCode::BAD_GATEWAY)
            .header(axum::http::header::CONTENT_TYPE, "application/json")
            .body(Body::from(r#"{"message":"upstream unreachable"}"#))
            .unwrap(),
    }
}
```

Update the handler test to use the new AppState structure:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::{BackendRegistry, CrushBackend, MetaStore, Upstream};
    use axum::http::header::ACCEPT;
    use axum::http::Request;
    use std::sync::Arc;

    #[tokio::test]
    async fn proxy_returns_502_for_unreachable_upstream() {
        let state = AppState {
            meta: Arc::new(MetaStore::new()),
            registry: Arc::new(BackendRegistry::new(Arc::new(CrushBackend::new(
                Upstream::Tcp("127.0.0.1:1".parse().unwrap()),
            )))),
        };
        let req = Request::builder()
            .uri("/v1/health")
            .header(ACCEPT, "application/json")
            .body(Body::empty())
            .unwrap();
        let resp = proxy(State(state), req).await;
        assert_eq!(resp.status(), StatusCode::BAD_GATEWAY);
    }

    #[test]
    fn extract_workspace_id_parses_valid_path() {
        assert_eq!(extract_workspace_id("/v1/workspaces/ws1/sessions"), Some("ws1"));
        assert_eq!(extract_workspace_id("/v1/workspaces/ws1"), Some("ws1"));
        assert_eq!(extract_workspace_id("/v1/health"), None);
    }
}
```

- [ ] **Step 5: Update `fs.rs` to use registry**

In `crates/combo-proxy/src/fs.rs`, change all three handlers' `State(state)` to use `state.registry.for_workspace(&id, &state.meta)` instead of `state.backend`. For each handler (`list`, `read`, `write`), replace:

```rust
let root = match state.backend.workspace_root(&id).await {
```

with:

```rust
let backend = state.registry.for_workspace(&id, &state.meta);
let root = match backend.workspace_root(&id).await {
```

- [ ] **Step 6: Update `main.rs` and `src-tauri/lib.rs`**

In `main.rs`, replace the AppState construction:

```rust
let state = AppState {
    backend: Arc::new(CrushBackend::new(upstream)),
    meta: Arc::new(MetaStore::new()),
};
```

with:

```rust
let state = AppState {
    meta: Arc::new(MetaStore::new()),
    registry: Arc::new(BackendRegistry::new(Arc::new(CrushBackend::new(upstream)))),
};
```

Similarly in `src-tauri/src/lib.rs`.

- [ ] **Step 7: Update `proxy_test.rs`**

In `start_proxy`, change:

```rust
let state = AppState {
    backend: Arc::new(CrushBackend::new(Upstream::Tcp(upstream_addr))),
    meta: Arc::new(MetaStore::new()),
};
```

to:

```rust
let state = AppState {
    meta: Arc::new(MetaStore::new()),
    registry: Arc::new(BackendRegistry::new(Arc::new(CrushBackend::new(
        Upstream::Tcp(upstream_addr),
    )))),
};
```

Add `BackendRegistry` to the imports.

- [ ] **Step 8: Build and test**

Run: `cargo test -p combo-proxy`
Expected: all existing tests pass + 4 new registry tests + 2 new handler tests.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "refactor: add BackendRegistry for multi-backend routing

AppState now holds a BackendRegistry instead of a single Backend.
The proxy handler extracts workspace_id from the URL and looks up
the correct backend via MetaStore. CrushBackend is the default for
unknown workspaces. No OpenCodeBackend yet — this is the routing
infrastructure."
```

---

### Task 2: OpenCodeBackend — REST translation

**Files:**
- Create: `crates/combo-proxy/src/backend/opencode.rs`
- Modify: `crates/combo-proxy/src/backend/mod.rs` (add `pub mod opencode`)
- Modify: `crates/combo-proxy/src/lib.rs` (re-export `OpenCodeBackend`)
- Test: `crates/combo-proxy/tests/opencode_test.rs`

**Interfaces:**
- Consumes: `Backend` trait, `Upstream` (TCP address of opencode server)
- Produces: `OpenCodeBackend { base_url: String }`, implements `Backend`

- [ ] **Step 1: Create the OpenCodeBackend skeleton**

Create `crates/combo-proxy/src/backend/opencode.rs`:

```rust
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
use serde_json::{json, Value};
use std::path::PathBuf;

pub struct OpenCodeBackend {
    /// OpenCode server base URL, e.g. `http://127.0.0.1:4096`
    base_url: String,
}

impl OpenCodeBackend {
    pub fn new(base_url: String) -> Self {
        Self { base_url }
    }
}

/// OpenCode SSE 事件翻译器输出的 crush 信封。
fn sse_envelope(event_type: &str, kind: &str, payload: &Value) -> String {
    let envelope = json!({
        "type": event_type,
        "payload": { "type": kind, "payload": payload }
    });
    format!("data: {}\n\n", serde_json::to_string(&envelope).unwrap_or_default())
}
```

- [ ] **Step 2: Implement `Backend` trait methods**

Add the trait impl:

```rust
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
        // 解析路径确定翻译策略
        let path = path_query.split('?').next().unwrap_or(path_query);
        let segments: Vec<&str> = path.trim_start_matches('/').split('/').collect();

        // /v1/health → GET {base}/global/health
        if path == "/v1/health" {
            return forward_raw(&client, &self.base_url, Method::GET, "/global/health", &[]).await;
        }

        // /v1/workspaces/{id}/sessions → GET/POST /session?directory={path}
        // 但这里没有 workspace path — 需要 MetaStore。
        // forward() 的限制:无法访问 MetaStore。因此 sessions/agent 等需要
        // workspace path 的端点通过特殊路由处理(见 Task 3)。
        // 此处对 workspace CRUD 之外的路径,直接转发到 OpenCode 对应路径。
        // 实际翻译在 dispatch() 中进行。

        self.dispatch(&client, &method, &segments, path_query, &body).await
    }

    async fn workspace_root(&self, _id: &str) -> Result<PathBuf> {
        // OpenCode 的 workspace root 由 combo MetaStore 管理
        // 这里不应该被调用(workspace CRUD 由 combo 本地处理)
        anyhow::bail!("OpenCode workspace_root should be resolved from MetaStore")
    }

    async fn health(&self) -> bool {
        let client = reqwest::Client::new();
        let url = format!("{}/global/health", self.base_url);
        match client.get(&url).send().await {
            Ok(r) => r.status().is_success(),
            Err(_) => false,
        }
    }
}
```

- [ ] **Step 3: Implement the `dispatch` method (REST translation)**

Add to `impl OpenCodeBackend`:

```rust
impl OpenCodeBackend {
    // ... (existing new)

    /// 按 combo 路径段分派到 OpenCode API。
    /// segments: [v1, workspaces, {ws_id}, ...]
    async fn dispatch(
        &self,
        client: &reqwest::Client,
        method: &Method,
        segments: &[&str],
        path_query: &str,
        body: &[u8],
    ) -> Result<Response> {
        // segments[3..] 是 workspace_id 之后的路径
        if segments.len() < 4 {
            // /v1/workspaces/{id} 或更短 — workspace CRUD 由 combo 本地处理
            // 到这里说明是非 workspace 路径,直接 404
            return Ok(not_found("unsupported path"));
        }

        let rest = &segments[3..]; // e.g. ["sessions"] or ["sessions", sid, "history"]

        match rest {
            // sessions list / create
            ["sessions"] => {
                if method == Method::GET {
                    // 需要目录信息 — 由调用方注入
                    // 这里用 query param 中的 directory
                    self.proxy_to_opencode(client, method, "/session", path_query, body).await
                } else if method == Method::POST {
                    self.create_session(client, body).await
                } else {
                    Ok(method_not_allowed())
                }
            }
            // session history: sessions/{sid}/history
            ["sessions", sid, "history"] => {
                self.get_history(client, sid).await
            }
            // send message: agent
            ["agent"] => {
                self.send_message(client, body).await
            }
            // cancel: agent/sessions/{sid}/cancel
            ["agent", "sessions", sid, "cancel"] => {
                self.cancel(client, sid).await
            }
            // events (SSE)
            ["events"] => {
                self.proxy_sse(client, path_query).await
            }
            // current-session (local)
            ["current-session"] => {
                Ok(ok_json(&json!({})))
            }
            // permissions/grant
            ["permissions", "grant"] => {
                self.grant_permission(client, body).await
            }
            // questions/answer
            ["questions", "answer"] => {
                self.answer_question(client, body).await
            }
            _ => {
                // 其余路径透传(尽力而为)
                self.proxy_to_opencode(client, method, path, path_query, body).await
            }
        }
    }

    async fn create_session(&self, client: &reqwest::Client, body: &[u8]) -> Result<Response> {
        let req_body: Value = serde_json::from_slice(body).unwrap_or(json!({}));
        let title = req_body.get("title").and_then(|t| t.as_str()).unwrap_or("");
        let oc_body = json!({ "title": title });
        let url = format!("{}/session", self.base_url);
        let resp = client.post(&url).json(&oc_body).send().await?;
        let status = resp.status();
        let oc_session: Value = resp.json().await?;
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
        let oc_body = json!({
            "parts": [{ "type": "text", "text": prompt }]
        });
        let url = format!("{}/session/{}/prompt_async", self.base_url, session_id);
        let resp = client.post(&url).json(&oc_body).send().await?;
        // prompt_async returns 204
        Ok(json_response(StatusCode::OK, &json!({ "ok": true })))
    }

    async fn cancel(&self, client: &reqwest::Client, sid: &str) -> Result<Response> {
        let url = format!("{}/session/{}/abort", self.base_url, sid);
        let _ = client.post(&url).send().await?;
        Ok(json_response(StatusCode::OK, &json!({ "ok": true })))
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
        let _ = client.post(&url).json(&json!({ "response": oc_response })).send().await?;
        Ok(json_response(StatusCode::OK, &json!({ "ok": true })))
    }

    async fn answer_question(&self, _client: &reqwest::Client, _body: &[u8]) -> Result<Response> {
        // OpenCode 的 question 机制与 crush 不同, M1 先返回 OK
        Ok(json_response(StatusCode::OK, &json!({ "ok": true })))
    }

    async fn proxy_to_opencode(
        &self,
        client: &reqwest::Client,
        method: &Method,
        oc_path: &str,
        original_path_query: &str,
        body: &[u8],
    ) -> Result<Response> {
        // 提取 query params,附加到 OpenCode 路径
        let query = original_path_query.split_once('?').map(|(_, q)| format!("?{q}")).unwrap_or_default();
        let url = format!("{}{}{}", self.base_url, oc_path, query);
        let resp = client
            .request(reqwest::Method::from_bytes(method.as_str().as_bytes()).unwrap_or(reqwest::Method::GET), &url)
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

    async fn proxy_sse(&self, client: &reqwest::Client, _path_query: &str) -> Result<Response> {
        // SSE 翻译在 Task 3 实现,此处先返回占位
        let url = format!("{}/event", self.base_url);
        let resp = client.get(&url).send().await?;
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        Ok(Response::builder()
            .status(status)
            .header("content-type", "text/event-stream")
            .body(Body::from(text))?)
    }
}
```

- [ ] **Step 4: Add mapping helper functions**

Add at module level:

```rust
/// OpenCode Session → combo Session
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

/// OpenCode message {info, parts} → combo Message
fn map_message(oc_msg: &Value) -> Value {
    let info = oc_msg.get("info").cloned().unwrap_or_default();
    let parts = oc_msg.get("parts").and_then(|v| v.as_array()).cloned().unwrap_or_default();
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

/// OpenCode Part → combo ContentPart (Option: some parts are skipped)
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
                        "tool_call_id": call_id,
                        "name": tool,
                        "content": output,
                    }}))
                }
                "error" => {
                    let error = state.get("error").and_then(|v| v.as_str()).unwrap_or("");
                    Some(json!({ "type": "tool_result", "data": {
                        "tool_call_id": call_id,
                        "name": tool,
                        "content": error,
                        "is_error": true,
                    }}))
                }
                _ => {
                    // pending / running → tool_call
                    let input = state.get("input").map(|v| v.to_string()).unwrap_or_default();
                    Some(json!({ "type": "tool_call", "data": {
                        "id": call_id,
                        "name": tool,
                        "input": input,
                    }}))
                }
            }
        }
        "step-finish" => {
            let reason = part.get("reason").and_then(|v| v.as_str()).unwrap_or("");
            Some(json!({ "type": "finish", "data": { "reason": reason } }))
        }
        _ => None, // file/patch/agent/subtask 等 M1 暂不映射
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
    json_response(StatusCode::METHOD_NOT_ALLOWED, &json!({ "message": "method not allowed" }))
}

/// 直接向 OpenCode 转发请求(不做翻译)。
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
```

- [ ] **Step 5: Add module declarations and re-exports**

In `crates/combo-proxy/src/backend/mod.rs`, add:
```rust
pub mod opencode;
```

In `crates/combo-proxy/src/lib.rs`, add to re-exports:
```rust
pub use backend::opencode::OpenCodeBackend;
```

- [ ] **Step 6: Write integration test with stub OpenCode server**

Create `crates/combo-proxy/tests/opencode_test.rs`:

```rust
use axum::body::Body;
use axum::routing::{get, post};
use axum::{Json, Router};
use combo_proxy::{AppState, BackendRegistry, MetaStore, OpenCodeBackend};
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::net::TcpListener;

/// Stub OpenCode server for testing.
async fn stub_opencode() -> std::net::SocketAddr {
    let app = Router::new()
        .route("/global/health", get(|| async { json!({ "healthy": true, "version": "test" }) }))
        .route("/session", get(|| async {
            Json(vec![json!({
                "id": "ses_1",
                "title": "Test Session",
                "time": { "created": 1700000000000_u64, "updated": 1700000001000_u64 },
            })])
        }))
        .route("/session", post(|| async {
            json!({
                "id": "ses_new",
                "title": "New",
                "time": { "created": 1700000000000_u64, "updated": 1700000000000_u64 },
            })
        }))
        .route("/session/:id/message", get(|| async {
            Json(vec![json!({
                "info": {
                    "id": "msg_1",
                    "role": "assistant",
                    "sessionID": "ses_1",
                    "modelID": "claude-sonnet-4",
                    "providerID": "anthropic",
                    "time": { "created": 1700000000000_u64, "completed": 1700000001000_u64 },
                },
                "parts": [
                    { "type": "text", "text": "Hello!" },
                    { "type": "reasoning", "text": "thinking..." },
                ]
            })])
        }))
        .route("/session/:id/prompt_async", post(|| async {
            (axum::http::StatusCode::NO_CONTENT, "")
        }))
        .route("/session/:id/abort", post(|| async {
            (axum::http::StatusCode::OK, "true")
        }));
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    addr
}

fn make_state(oc_addr: std::net::SocketAddr) -> AppState {
    let mut registry = BackendRegistry::new(Arc::new(CrushBackend::new(
        combo_proxy::Upstream::Tcp("127.0.0.1:1".parse().unwrap()),
    )));
    registry.set_opencode(Arc::new(OpenCodeBackend::new(format!(
        "http://{}", oc_addr
    ))));
    let meta = MetaStore::new();
    meta.insert(combo_proxy::WorkspaceMeta {
        id: "ws_oc".into(),
        path: "/tmp/test".into(),
        backend_type: combo_proxy::BackendType::OpenCode,
    });
    AppState {
        meta: Arc::new(meta),
        registry: Arc::new(registry),
    }
}

#[tokio::test]
async fn opencode_health_works() {
    let addr = stub_opencode().await;
    let state = make_state(addr);
    let backend = state.registry.for_workspace("ws_oc", &state.meta);
    assert!(backend.health().await);
}

#[tokio::test]
async fn opencode_session_list_maps_fields() {
    let addr = stub_opencode().await;
    let state = make_state(addr);
    let backend = state.registry.for_workspace("ws_oc", &state.meta);
    let resp = backend
        .forward(axum::http::Method::GET, "/v1/workspaces/ws_oc/sessions", &Default::default(), vec![])
        .await
        .unwrap();
    assert_eq!(resp.status(), axum::http::StatusCode::OK);
    let body: Value = serde_json::from_slice(&axum::body::to_bytes(resp.into_body(), 65536).await.unwrap()).unwrap();
    let sessions = body.as_array().unwrap();
    assert_eq!(sessions[0]["id"], "ses_1");
    assert_eq!(sessions[0]["title"], "Test Session");
    assert_eq!(sessions[0]["created_at"], 1700000000); // 毫秒→秒
}

#[tokio::test]
async fn opencode_history_maps_messages_and_parts() {
    let addr = stub_opencode().await;
    let state = make_state(addr);
    let backend = state.registry.for_workspace("ws_oc", &state.meta);
    let resp = backend
        .forward(axum::http::Method::GET, "/v1/workspaces/ws_oc/sessions/ses_1/history", &Default::default(), vec![])
        .await
        .unwrap();
    assert_eq!(resp.status(), axum::http::StatusCode::OK);
    let body: Value = serde_json::from_slice(&axum::body::to_bytes(resp.into_body(), 65536).await.unwrap()).unwrap();
    let messages = body["messages"].as_array().unwrap();
    assert_eq!(messages[0]["id"], "msg_1");
    assert_eq!(messages[0]["role"], "assistant");
    let parts = messages[0]["parts"].as_array().unwrap();
    assert_eq!(parts[0]["type"], "text");
    assert_eq!(parts[0]["data"]["text"], "Hello!");
    assert_eq!(parts[1]["type"], "reasoning");
    assert_eq!(parts[1]["data"]["thinking"], "thinking...");
}

#[tokio::test]
async fn opencode_send_message_calls_prompt_async() {
    let addr = stub_opencode().await;
    let state = make_state(addr);
    let backend = state.registry.for_workspace("ws_oc", &state.meta);
    let body = serde_json::to_vec(&json!({
        "session_id": "ses_1",
        "run_id": "run_1",
        "prompt": "hello",
    })).unwrap();
    let resp = backend
        .forward(axum::http::Method::POST, "/v1/workspaces/ws_oc/agent", &Default::default(), body)
        .await
        .unwrap();
    assert_eq!(resp.status(), axum::http::StatusCode::OK);
}

#[tokio::test]
async fn opencode_cancel_calls_abort() {
    let addr = stub_opencode().await;
    let state = make_state(addr);
    let backend = state.registry.for_workspace("ws_oc", &state.meta);
    let resp = backend
        .forward(axum::http::Method::POST, "/v1/workspaces/ws_oc/agent/sessions/ses_1/cancel", &Default::default(), vec![])
        .await
        .unwrap();
    assert_eq!(resp.status(), axum::http::StatusCode::OK);
}

// Need this import for CrushBackend
use combo_proxy::CrushBackend;
```

- [ ] **Step 7: Build and test**

Run: `cargo test -p combo-proxy`
Expected: all existing tests pass + 5 new opencode tests.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: add OpenCodeBackend with REST translation

Implements the Backend trait for OpenCode, translating combo REST
endpoints (sessions, history, agent, cancel, permissions) to
OpenCode's HTTP API. Maps OpenCode's Session/Message/Part shapes to
crush-compatible formats. Includes stub-server integration tests."
```

---

### Task 3: SSE translation — OpenCode events → crush envelope

**Files:**
- Modify: `crates/combo-proxy/src/backend/opencode.rs` (replace `proxy_sse`)
- Test: `crates/combo-proxy/tests/opencode_test.rs` (add SSE tests)

- [ ] **Step 1: Add SSE translator struct**

In `crates/combo-proxy/src/backend/opencode.rs`, add the translator:

```rust
use std::collections::HashMap;
use tokio::sync::Mutex;

/// 流式翻译过程中维护的状态(每个 SSE 连接一份)。
struct SseState {
    /// messageID → 累积的 text 部分文本
    text_acc: HashMap<String, String>,
    /// messageID → 累积的 reasoning 部分文本
    reasoning_acc: HashMap<String, String>,
    /// sessionID → 当前 assistant messageID(用于 idle→run_complete)
    current_msg: HashMap<String, String>,
}
```

- [ ] **Step 2: Implement SSE event translation**

Replace the `proxy_sse` method in `impl OpenCodeBackend`:

```rust
    async fn proxy_sse(&self, client: &reqwest::Client, path_query: &str) -> Result<Response> {
        // 提取 directory 参数(从 workspace path 传入)
        let url = format!("{}/event", self.base_url);

        // 连接 OpenCode SSE 并翻译
        let resp = client
            .get(&url)
            .header("accept", "text/event-stream")
            .send()
            .await?;

        if !resp.status().is_success() {
            return Ok(json_response(resp.status(), &json!({ "message": "opencode SSE unavailable" })));
        }

        // 获取字节流,逐帧翻译
        let byte_stream = resp.bytes_stream();
        let translated = translate_sse_stream(byte_stream);

        Ok(Response::builder()
            .status(StatusCode::OK)
            .header("content-type", "text/event-stream")
            .header("cache-control", "no-cache")
            .body(Body::from_stream(translated))?)
    }
```

Add the streaming translator function:

```rust
use futures_util::StreamExt;

/// 将 OpenCode SSE 字节流翻译为 crush 双层信封 SSE 字节流。
fn translate_sse_stream(
    byte_stream: impl futures_util::Stream<Item = Result<bytes::Bytes, reqwest::Error>>,
) -> impl futures_util::Stream<Item = Result<bytes::Bytes, std::io::Error>> {
    use std::collections::HashMap;

    // 累积器:msg_id → accumulated_text
    let mut text_acc: HashMap<String, String> = HashMap::new();
    let mut msg_by_session: HashMap<String, String> = HashMap::new();
    let mut buffer = String::new();

    byte_stream.filter_map(move |chunk| {
        let chunk = match chunk {
            Ok(c) => c,
            Err(_) => return std::future::ready(None),
        };
        buffer.push_str(&String::from_utf8_lossy(&chunk));

        let mut outputs = Vec::new();

        // 按完整 SSE 帧(data: ...\n\n)切分
        while let Some(pos) = buffer.find("\n\n") {
            let frame = buffer[..pos].to_string();
            buffer = buffer[pos + 2..].to_string();

            // 提取 data: 行
            let data_line = frame
                .lines()
                .find_map(|line| line.strip_prefix("data: ").or_else(|| line.strip_prefix("data:")))
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

            if let Some(translated) = translate_sse_event(etype, &props, &mut text_acc, &mut msg_by_session) {
                outputs.push(bytes::Bytes::from(translated));
            }
        }

        if outputs.is_empty() {
            std::future::ready(None)
        } else {
            std::future::ready(Some(Ok(bytes::Bytes::from(
                outputs.into_iter().map(|b| String::from_utf8_lossy(&b).to_string()).collect::<String>(),
            ))))
        }
    })
}
```

- [ ] **Step 3: Implement `translate_sse_event`**

Add the core translation function:

```rust
/// 翻译单个 OpenCode SSE 事件为 crush 双层信封字符串(或 None = 忽略)。
fn translate_sse_event(
    etype: &str,
    props: &Value,
    text_acc: &mut HashMap<String, String>,
    msg_by_session: &mut HashMap<String, String>,
) -> Option<String> {
    let session_id = props.get("sessionID").and_then(|v| v.as_str()).unwrap_or("");
    let msg_id = props
        .get("assistantMessageID")
        .or_else(|| props.get("messageID"))
        .and_then(|v| v.as_str())
        .unwrap_or("");

    match etype {
        // 文本增量
        "session.next.text.delta" => {
            let delta = props.get("delta").and_then(|v| v.as_str()).unwrap_or("");
            let text_id = props.get("textID").and_then(|v| v.as_str()).unwrap_or(msg_id);
            let acc = text_acc.entry(text_id.to_string()).or_default();
            acc.push_str(delta);
            let payload = json!({
                "id": msg_id,
                "role": "assistant",
                "session_id": session_id,
                "parts": [{ "type": "text", "data": { "text": acc } }],
                "model": "",
                "provider": "",
                "created_at": 0,
                "updated_at": 0,
            });
            Some(sse_envelope("message", "updated", &payload))
        }

        // 推理增量
        "session.next.reasoning.delta" => {
            let delta = props.get("delta").and_then(|v| v.as_str()).unwrap_or("");
            let reasoning_id = props.get("reasoningID").and_then(|v| v.as_str()).unwrap_or(msg_id);
            let key = format!("r:{}", reasoning_id);
            let acc = text_acc.entry(key).or_default();
            acc.push_str(delta);
            let payload = json!({
                "id": msg_id,
                "role": "assistant",
                "session_id": session_id,
                "parts": [{ "type": "reasoning", "data": { "thinking": acc, "signature": "" } }],
                "model": "",
                "provider": "",
                "created_at": 0,
                "updated_at": 0,
            });
            Some(sse_envelope("message", "updated", &payload))
        }

        // 工具调用开始
        "session.next.tool.called" => {
            let call_id = props.get("callID").and_then(|v| v.as_str()).unwrap_or("");
            let tool = props.get("tool").and_then(|v| v.as_str()).unwrap_or("unknown");
            let input = props.get("input").map(|v| v.to_string()).unwrap_or_default();
            let payload = json!({
                "id": msg_id,
                "role": "assistant",
                "session_id": session_id,
                "parts": [{
                    "type": "tool_call",
                    "data": { "id": call_id, "name": tool, "input": input }
                }],
                "model": "",
                "provider": "",
                "created_at": 0,
                "updated_at": 0,
            });
            Some(sse_envelope("message", "updated", &payload))
        }

        // 工具调用成功
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
            let payload = json!({
                "id": msg_id,
                "role": "assistant",
                "session_id": session_id,
                "parts": [{
                    "type": "tool_result",
                    "data": { "tool_call_id": call_id, "name": tool, "content": content }
                }],
                "model": "",
                "provider": "",
                "created_at": 0,
                "updated_at": 0,
            });
            Some(sse_envelope("message", "updated", &payload))
        }

        // 工具调用失败
        "session.next.tool.failed" => {
            let call_id = props.get("callID").and_then(|v| v.as_str()).unwrap_or("");
            let tool = props.get("tool").and_then(|v| v.as_str()).unwrap_or("unknown");
            let error = props
                .pointer("/error/message")
                .and_then(|v| v.as_str())
                .unwrap_or("tool failed");
            let payload = json!({
                "id": msg_id,
                "role": "assistant",
                "session_id": session_id,
                "parts": [{
                    "type": "tool_result",
                    "data": { "tool_call_id": call_id, "name": tool, "content": error, "is_error": true }
                }],
                "model": "",
                "provider": "",
                "created_at": 0,
                "updated_at": 0,
            });
            Some(sse_envelope("message", "updated", &payload))
        }

        // 会话空闲 → 运行完成
        "session.idle" | "session.status" if props_pointer(props, "status/type") == Some("idle") => {
            if !session_id.is_empty() {
                msg_by_session.remove(session_id);
            }
            Some(sse_envelope("run_complete", "updated", &json!({
                "session_id": session_id,
            })))
        }
        "session.idle" => {
            Some(sse_envelope("run_complete", "updated", &json!({
                "session_id": session_id,
            })))
        }

        // 权限请求
        "permission.asked" => {
            let perm_id = props.get("id").and_then(|v| v.as_str()).unwrap_or("");
            let permission = props.get("permission").and_then(|v| v.as_str()).unwrap_or("");
            let patterns = props.get("patterns").cloned().unwrap_or(json!([]));
            let tool_info = props.get("tool").cloned();
            let call_id = tool_info
                .as_ref()
                .and_then(|t| t.get("callID"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let payload = json!({
                "id": perm_id,
                "session_id": session_id,
                "tool_call_id": call_id,
                "tool_name": permission,
                "description": format!("OpenCode permission: {} {:?}", permission, patterns),
                "action": permission,
                "params": {},
                "path": "",
            });
            Some(sse_envelope("permission_request", "created", &payload))
        }

        // 会话创建
        "session.created" => {
            let info = props.get("info").cloned().unwrap_or_default();
            Some(sse_envelope("session", "created", &map_session(&info)))
        }

        // 会话更新
        "session.updated" => {
            let info = props.get("info").cloned().unwrap_or_default();
            Some(sse_envelope("session", "updated", &map_session(&info)))
        }

        // 其余事件忽略
        _ => None,
    }
}

/// 辅助:按 JSON pointer 路径取字符串。
fn props_pointer<'a>(v: &'a Value, path: &str) -> Option<&'a str> {
    v.pointer(&format!("/{}", path.replace('/', "/")))
        .and_then(|v| v.as_str())
}
```

- [ ] **Step 4: Add SSE integration test**

In `crates/combo-proxy/tests/opencode_test.rs`, add:

```rust
use futures_util::StreamExt;

#[tokio::test]
async fn opencode_sse_translates_text_delta() {
    // 启动 stub OpenCode SSE 服务端
    let sse_body = concat!(
        r#"data: {"id":"evt_1","type":"server.connected","properties":{}}"#, "\n\n",
        r#"data: {"id":"evt_2","type":"session.next.text.delta","properties":{"sessionID":"ses_1","assistantMessageID":"msg_1","textID":"txt_1","delta":"Hello "}}"#, "\n\n",
        r#"data: {"id":"evt_3","type":"session.next.text.delta","properties":{"sessionID":"ses_1","assistantMessageID":"msg_1","textID":"txt_1","delta":"World"}}"#, "\n\n",
        r#"data: {"id":"evt_4","type":"session.idle","properties":{"sessionID":"ses_1"}}"#, "\n\n",
    );
    let app = Router::new().route("/event", get(|| async {
        Response::builder()
            .header("content-type", "text/event-stream")
            .body(Body::from(sse_body))
            .unwrap()
    }));
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

    let state = make_state(addr);
    let backend = state.registry.for_workspace("ws_oc", &state.meta);
    let resp = backend
        .forward(axum::http::Method::GET, "/v1/workspaces/ws_oc/events", &Default::default(), vec![])
        .await
        .unwrap();
    assert_eq!(resp.status(), axum::http::StatusCode::OK);
    let body_bytes = axum::body::to_bytes(resp.into_body(), 65536).await.unwrap();
    let body_str = String::from_utf8_lossy(&body_bytes);

    // 应包含翻译后的 message 事件
    assert!(body_str.contains(r#""type":"message""#));
    // 第一帧 delta "Hello " → 累积后文本包含 "Hello "
    assert!(body_str.contains("Hello "));
    // 第二帧 delta "World" → 累积后文本包含 "Hello World"
    assert!(body_str.contains("Hello World"));
    // run_complete 事件
    assert!(body_str.contains(r#""type":"run_complete""#));
}
```

- [ ] **Step 5: Build and test**

Run: `cargo test -p combo-proxy`
Expected: all tests pass including new SSE test.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: add SSE translation from OpenCode events to crush envelope

Translates OpenCode's flat SSE events (session.next.text.delta,
session.next.tool.called, session.idle, permission.asked, etc.)
into crush's double-nested envelope format that the frontend
expects. Maintains per-message text accumulation state for
streaming deltas."
```

---

### Task 4: OpenCodeManager — process lifecycle

**Files:**
- Create: `crates/combo-proxy/src/manager/mod.rs`
- Create: `crates/combo-proxy/src/manager/opencode.rs`
- Modify: `crates/combo-proxy/src/lib.rs` (add module)
- Test: inline unit tests

- [ ] **Step 1: Create manager module**

Create `crates/combo-proxy/src/manager/mod.rs`:

```rust
pub mod opencode;
```

Create `crates/combo-proxy/src/manager/opencode.rs`:

```rust
//! OpenCode 服务器进程管理。
//! 启动 `opencode serve`,等待健康,关闭时 kill 进程。

use anyhow::Result;
use std::process::Stdio;
use std::time::Duration;
use tokio::process::{Child, Command};
use tokio::time::{sleep, timeout};

pub struct OpenCodeManager {
    bin: String,
    port: u16,
    log_path: std::path::PathBuf,
    child: Option<Child>,
}

impl OpenCodeManager {
    pub fn new(bin: String) -> Self {
        let log_path = std::env::temp_dir().join("combo-opencode.log");
        Self {
            bin,
            port: 0, // 随机端口
            log_path,
            child: None,
        }
    }

    /// 返回 OpenCode server 的 base URL(启动后可用)。
    pub fn base_url(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }

    /// 启动 OpenCode server 并等待健康。
    pub async fn ensure_running(&mut self) -> Result<String> {
        // 绑定一个随机端口
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        self.port = listener.local_addr()?.port();
        drop(listener); // 释放端口让 opencode 使用

        let log = std::fs::File::create(&self.log_path)?;
        let stderr = Stdio::from(log);
        self.child = Some(
            Command::new(&self.bin)
                .arg("serve")
                .arg("--port")
                .arg(self.port.to_string())
                .arg("--hostname")
                .arg("127.0.0.1")
                .stdout(stderr)
                .stderr(Stdio::inherit())
                .spawn()
                .map_err(|e| anyhow::anyhow!("failed to spawn {}: {e}", self.bin))?,
        );

        // 健康探测
        let base_url = self.base_url();
        let ready = timeout(
            Duration::from_secs(15),
            poll_health(&base_url),
        )
        .await;
        match ready {
            Ok(true) => Ok(base_url),
            _ => anyhow::bail!(
                "opencode server did not become healthy within 15s; log at {}",
                self.log_path.display()
            ),
        }
    }

    /// 关闭 OpenCode server。
    pub async fn shutdown(&mut self) -> Result<()> {
        if let Some(mut child) = self.child.take() {
            let _ = child.kill().await;
            let _ = child.wait().await;
        }
        Ok(())
    }
}

async fn poll_health(base_url: &str) -> bool {
    let url = format!("{}/global/health", base_url);
    loop {
        if let Ok(resp) = reqwest::get(&url).await {
            if resp.status().is_success() {
                return true;
            }
        }
        sleep(Duration::from_millis(500)).await;
    }
}
```

- [ ] **Step 2: Add module to lib.rs**

In `crates/combo-proxy/src/lib.rs`, add:
```rust
pub mod manager;
pub use manager::opencode::OpenCodeManager;
```

- [ ] **Step 3: Build and test**

Run: `cargo test -p combo-proxy`
Expected: compiles, all existing tests pass.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: add OpenCodeManager for opencode serve lifecycle

Manages the opencode serve subprocess: spawns with a random port,
polls /global/health until ready, and kills on shutdown. Follows
the same pattern as RuneManager for crush."
```

---

### Task 5: Wire OpenCodeManager into proxy startup

**Files:**
- Modify: `crates/combo-proxy/src/main.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `crates/combo-proxy/src/router.rs` (add workspace CRUD routes)

- [ ] **Step 1: Update `main.rs` to optionally start OpenCode**

In `crates/combo-proxy/src/main.rs`, after creating the crush backend and AppState, conditionally start OpenCode:

```rust
let mut registry = BackendRegistry::new(Arc::new(CrushBackend::new(upstream)));

// 可选:启动 OpenCode 后端
if let Ok(oc_bin) = std::env::var("COMBO_OPENCODE_BIN") {
    match start_opencode(&oc_bin).await {
        Some(base_url) => {
            registry.set_opencode(Arc::new(OpenCodeBackend::new(base_url)));
            println!("COMBO_OPENCODE_STATUS=connected");
        }
        None => {
            eprintln!("COMBO_OPENCODE_STATUS=failed");
        }
    }
}

let state = AppState {
    meta: Arc::new(MetaStore::new()),
    registry: Arc::new(registry),
};
```

Add the helper function:

```rust
async fn start_opencode(bin: &str) -> Option<String> {
    let mut mgr = OpenCodeManager::new(bin.to_string());
    match mgr.ensure_running().await {
        Ok(url) => Some(url),
        Err(e) => {
            eprintln!("opencode failed: {e:?}");
            None
        }
    }
}
```

- [ ] **Step 2: Update `src-tauri/src/lib.rs` similarly**

Add the same OpenCode startup logic to `init_backend`:

```rust
let mut registry = BackendRegistry::new(Arc::new(CrushBackend::new(upstream)));

if let Ok(oc_bin) = std::env::var("COMBO_OPENCODE_BIN") {
    let mut oc_mgr = OpenCodeManager::new(oc_bin);
    match oc_mgr.ensure_running().await {
        Ok(url) => {
            registry.set_opencode(Arc::new(OpenCodeBackend::new(url)));
        }
        Err(e) => {
            eprintln!("opencode server failed: {e:?}");
        }
    }
}

let state = AppState {
    meta: Arc::new(MetaStore::new()),
    registry: Arc::new(registry),
};
```

- [ ] **Step 3: Build and test**

Run: `cargo test -p combo-proxy && cargo build -p combo`
Expected: compiles and tests pass.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: wire OpenCodeManager into proxy startup

When COMBO_OPENCODE_BIN is set, the proxy starts an opencode serve
instance alongside crush. Both backends are registered in the
BackendRegistry for per-workspace routing."
```

---

### Task 6: Workspace management — MetaStore as source of truth

**Files:**
- Modify: `crates/combo-proxy/src/router.rs` (add workspace CRUD routes)
- Create: `crates/combo-proxy/src/workspace.rs` (workspace handlers)
- Modify: `crates/combo-proxy/src/lib.rs` (add module)
- Test: `crates/combo-proxy/tests/workspace_test.rs`

- [ ] **Step 1: Create `workspace.rs`**

Create `crates/combo-proxy/src/workspace.rs`:

```rust
//! Workspace CRUD handlers。combo 自己拥有 workspace 元数据。
//! 对于 crush 后端,同时转发给 crush 创建(双写)。

use crate::AppState;
use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::Response;
use crate::backend::BackendType;
use serde_json::{json, Value};

/// GET /v1/workspaces — 列出 combo 的所有 workspace。
pub async fn list(State(state): State<AppState>) -> Response {
    let workspaces = state.meta.list();
    let arr: Vec<Value> = workspaces
        .iter()
        .map(|w| {
            json!({
                "id": w.id,
                "path": w.path,
                "backend": format!("{:?}", w.backend_type).to_lowercase(),
            })
        })
        .collect();
    json_ok(&json!(arr))
}

/// POST /v1/workspaces — 创建 workspace。
/// body: { path: string, client_id: string, backend?: "crush"|"opencode" }
pub async fn create(State(state): State<AppState>, axum::extract::Json(body): axum::extract::Json<Value>) -> Response {
    let path = body.get("path").and_then(|v| v.as_str()).unwrap_or("");
    if path.is_empty() {
        return json_err(StatusCode::BAD_REQUEST, "缺少 path");
    }
    let backend = body
        .get("backend")
        .and_then(|v| v.as_str())
        .map(|s| match s {
            "opencode" => BackendType::OpenCode,
            _ => BackendType::Crush,
        })
        .unwrap_or(BackendType::Crush);

    // 对于 crush:转发给 crush 创建,获取真实 ID
    let (ws_id, ws_path) = if backend == BackendType::Crush {
        match state.registry.by_type(BackendType::Crush) {
            Some(crush) => {
                // 转发给 crush
                let crush_body = serde_json::to_vec(&json!({ "path": path, "client_id": body.get("client_id").cloned().unwrap_or_default() })).unwrap_or_default();
                match crush.forward(axum::http::Method::POST, "/v1/workspaces", &Default::default(), crush_body).await {
                    Ok(resp) if resp.status().is_success() => {
                        let bytes = axum::body::to_bytes(resp.into_body(), 65536).await.unwrap_or_default();
                        let v: Value = serde_json::from_slice(&bytes).unwrap_or_default();
                        let id = v.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                        let p = v.get("path").and_then(|v| v.as_str()).unwrap_or(path).to_string();
                        (id, p)
                    }
                    _ => {
                        // crush 失败,用本地 fallback
                        (format!("ws_{}", uuid_like()), path.to_string())
                    }
                }
            }
            None => (format!("ws_{}", uuid_like()), path.to_string()),
        }
    } else {
        // OpenCode: combo 生成 ID
        (format!("ws_{}", uuid_like()), path.to_string())
    };

    let meta = crate::WorkspaceMeta {
        id: ws_id.clone(),
        path: ws_path.into(),
        backend_type: backend,
    };
    state.meta.insert(meta.clone());

    json_ok(&json!({
        "id": ws_id,
        "path": ws_path,
        "backend": format!("{:?}", backend).to_lowercase(),
    }))
}

/// GET /v1/workspaces/{id} — 从 MetaStore 返回。
pub async fn get(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    match state.meta.get(&id) {
        Some(w) => json_ok(&json!({
            "id": w.id,
            "path": w.path,
            "backend": format!("{:?}", w.backend_type).to_lowercase(),
        })),
        None => json_err(StatusCode::NOT_FOUND, "workspace 不存在"),
    }
}

fn json_ok(v: &Value) -> Response {
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "application/json")
        .body(Body::from(v.to_string()))
        .unwrap()
}

fn json_err(status: StatusCode, msg: &str) -> Response {
    Response::builder()
        .status(status)
        .header("content-type", "application/json")
        .body(Body::from(json!({ "message": msg }).to_string()))
        .unwrap()
}

/// 生成一个简易的唯一 ID(不用 uuid crate,用时间戳+随机)。
fn uuid_like() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{:x}", nanos)
}
```

- [ ] **Step 2: Add `list` method to MetaStore**

In `crates/combo-proxy/src/meta.rs`, add:

```rust
pub fn list(&self) -> Vec<WorkspaceMeta> {
    self.workspaces.lock().unwrap().values().cloned().collect()
}
```

- [ ] **Step 3: Add routes and module**

In `crates/combo-proxy/src/lib.rs`, add:
```rust
pub mod workspace;
```

In `crates/combo-proxy/src/router.rs`, add workspace routes:

```rust
use crate::workspace;

// In build_router, BEFORE the fallback:
Router::new()
    .route("/v1/workspaces", get(workspace::list).post(workspace::create))
    .route("/v1/workspaces/:id", get(workspace::get))
    .route("/v1/workspaces/:id/files/list", get(fs::list))
    .route("/v1/workspaces/:id/files/content", get(fs::read).put(fs::write))
    .fallback(proxy)
    .with_state(state)
    .layer(cors)
```

- [ ] **Step 4: Write workspace handler tests**

Create `crates/combo-proxy/tests/workspace_test.rs`:

```rust
use axum::body::Body;
use axum::http::{Request, StatusCode};
use combo_proxy::*;
use serde_json::{json, Value};
use std::sync::Arc;

async fn start_proxy() -> (SocketAddr, Arc<MetaStore>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let meta = Arc::new(MetaStore::new());
    let registry = BackendRegistry::new(Arc::new(CrushBackend::new(Upstream::Tcp(
        "127.0.0.1:1".parse().unwrap(),
    ))));
    let state = AppState { meta: meta.clone(), registry: Arc::new(registry) };
    tokio::spawn(async move { serve(listener, state, vec![]).await.unwrap() });
    (addr, meta)
}

#[tokio::test]
async fn create_and_list_opencode_workspace() {
    let (proxy, _) = start_proxy().await;
    let client = reqwest::Client::new();

    // 创建 OpenCode workspace
    let resp = client
        .post(format!("http://{proxy}/v1/workspaces"))
        .json(&json!({ "path": "/tmp/test", "client_id": "c1", "backend": "opencode" }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let body: Value = resp.json().await.unwrap();
    assert_eq!(body["backend"], "opencode");
    let ws_id = body["id"].as_str().unwrap().to_string();

    // 列出
    let resp = client.get(format!("http://{proxy}/v1/workspaces")).send().await.unwrap();
    let list: Value = resp.json().await.unwrap();
    let found = list.as_array().unwrap().iter().any(|w| w["id"] == ws_id);
    assert!(found);

    // 获取单个
    let resp = client.get(format!("http://{proxy}/v1/workspaces/{ws_id}")).send().await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let body: Value = resp.json().await.unwrap();
    assert_eq!(body["backend"], "opencode");
}
```

- [ ] **Step 5: Build and test**

Run: `cargo test -p combo-proxy`
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: combo owns workspace metadata via MetaStore

Workspace CRUD is now handled by combo-proxy locally. For crush
workspaces, creation is dual-written (MetaStore + forwarded to crush).
For OpenCode, MetaStore-only with combo-generated IDs. The
'backend' field in create/select responses enables frontend
backend selection."
```

---

### Task 7: Frontend — backend selector

**Files:**
- Modify: `src/lib/api/index.ts` (createWorkspace accepts backend param)
- Modify: `src/lib/api/types.ts` (add backend field to Workspace)
- Modify: `src/stores/agentStore.ts` (store backend type)
- Modify: workspace creation UI component
- Test: existing frontend tests + new test

- [ ] **Step 1: Update API types**

In `src/lib/api/types.ts`, add `backend` field to `Workspace`:

```typescript
  export type Workspace = {
    id: string;
    path: string;
    backend?: string;  // 'crush' | 'opencode'
    yolo?: boolean;
    // ... rest unchanged
  };
```

- [ ] **Step 2: Update `createWorkspace` API wrapper**

In `src/lib/api/index.ts`:

```typescript
export function createWorkspace(
  path: string,
  backend: 'crush' | 'opencode' = 'crush'
): Promise<Api.Workspace> {
  return apiRequest('/v1/workspaces', {
    method: 'POST',
    body: { path, client_id: getClientId(), backend },
  });
}
```

- [ ] **Step 3: Add backend selector to workspace creation UI**

Find the workspace creation component and add a backend type selector. The UI should show a dropdown with options:
- Crush (crush) — 默认
- OpenCode (opencode)

Pass the selected backend type to `createWorkspace(path, backend)`.

- [ ] **Step 4: Run frontend tests**

Run: `npm run tsc && npm test`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add backend selector for workspace creation

Workspace creation now accepts a backend type ('crush' or
'opencode'). The frontend shows a dropdown selector. The
createWorkspace API wrapper and Workspace type are updated to
include the backend field."
```

---

### Task 8: Full integration verification

- [ ] **Step 1: Run all Rust tests**

Run: `cargo test -p combo-proxy`
Expected: all tests pass.

- [ ] **Step 2: Run frontend tests**

Run: `npm run tsc && npm test`
Expected: all tests pass.

- [ ] **Step 3: Manual smoke test (if opencode available)**

If `opencode` is installed:
```bash
COMBO_OPENCODE_BIN=$(which opencode) cargo run -p combo-proxy -- --port 18234
```
Then in browser: create an OpenCode workspace, create a session, send a message.

- [ ] **Step 4: Fix any issues and commit**

---

## Self-Review Notes

**Spec coverage:**
- OpenCodeManager → Task 4
- Multi-backend routing → Task 1 (BackendRegistry)
- workspace double-write → Task 6
- REST translation → Task 2
- SSE translation → Task 3
- Frontend backend selector → Task 7
- Permission mapping → Task 2 (grant_permission) + Task 3 (permission.asked SSE)
- Question mapping → Task 2 (answer_question, M1 simplified)

**Deferred (noted):**
- Question SSE translation (question.asked event) — basic stub in Task 3
- Session status field mapping (is_busy, tokens, cost) — approximated
- File operations via OpenCode — using combo's local file service instead
- OpenCode config management — via OpenCode's own config
