# 多 Agent 后端支持 — 阶段 0：Backend 抽象层重构 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Introduce a `Backend` trait and `CrushBackend` implementation in combo-proxy, decoupling the proxy from the crush-specific code paths — with zero behavior change.

**Architecture:** Define a `Backend` trait that abstracts request forwarding, workspace-root resolution, and health checking. Wrap the existing crush pass-through logic in `CrushBackend`. Introduce an in-memory `MetaStore` for workspace metadata (scaffolding for future phases). Replace the router's `Arc<Upstream>` state with an `AppState` struct holding `Arc<dyn Backend>` + `Arc<MetaStore>`. All existing tests and frontend behavior remain identical.

**Tech Stack:** Rust (axum 0.7, async-trait, hyper, tokio), existing combo-proxy crate.

## Global Constraints

- **Behavior preservation:** No user-visible change. All existing Rust tests (`cargo test -p combo-proxy`) and frontend tests (`npm test`) must pass unchanged.
- **axum 0.7:** Route params use `:id` syntax (not `{id}`).
- **Chinese UI strings:** All user-facing copy stays Chinese; code comments in Chinese where existing code uses them.
- **No frontend changes:** `src/` is untouched in this phase.
- **crush binary not installed:** Integration tests (`COMBO_RUNE_IT=1`) and E2E self-skip; unit/integration tests with stub upstreams are the validation surface.

**Design doc:** `docs/superpowers/specs/2026-08-02-multi-agent-backend-support-design.md`

---

### Task 1: Create Backend trait, CrushBackend, and MetaStore modules

**Files:**
- Modify: `crates/combo-proxy/Cargo.toml` (add `async-trait` dep)
- Create: `crates/combo-proxy/src/backend/mod.rs`
- Create: `crates/combo-proxy/src/backend/crush.rs`
- Create: `crates/combo-proxy/src/meta.rs`
- Modify: `crates/combo-proxy/src/lib.rs` (add module declarations + re-exports only)
- Test: inline `#[cfg(test)]` modules in each new file

**Interfaces:**
- Consumes: `Upstream` from `crate::upstream` (unchanged)
- Produces:
  - `Backend` trait: `fn backend_type(&self) -> BackendType`, `async fn forward(&self, method, path_query, headers, body) -> Result<Response>`, `async fn workspace_root(&self, id: &str) -> Result<PathBuf>`, `async fn health(&self) -> bool`
  - `BackendType` enum: `Crush`
  - `CrushBackend` struct: `CrushBackend::new(upstream: Upstream) -> CrushBackend`
  - `MetaStore` struct: `MetaStore::new() -> MetaStore`, `.insert(WorkspaceMeta)`, `.get(id) -> Option<WorkspaceMeta>`
  - `WorkspaceMeta` struct: `{ id: String, path: PathBuf, backend_type: BackendType }`

- [ ] **Step 1: Add `async-trait` dependency**

Modify `crates/combo-proxy/Cargo.toml` — add after `libc = "0.2"`:

```toml
async-trait = "0.1"
```

- [ ] **Step 2: Create `backend/mod.rs` with the `Backend` trait and `BackendType` enum**

Create `crates/combo-proxy/src/backend/mod.rs`:

```rust
pub mod crush;

use anyhow::Result;
use axum::http::{HeaderMap, Method};
use axum::response::Response;
use std::path::PathBuf;

/// 标识当前使用的 agent 后端类型。
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BackendType {
    Crush,
}

/// combo-proxy 面向 agent 后端的统一接口。
///
/// 每个后端(crush、opencode、claude code 等)各自实现此 trait。
/// 路由层仅调用 `&self` 方法;进程生命周期(启动/关闭)在 Backend
/// 被 `Arc` 包装之前由调用方处理。
#[async_trait::async_trait]
pub trait Backend: Send + Sync {
    /// 当前后端类型。
    fn backend_type(&self) -> BackendType;

    /// 转发原始 HTTP 请求到后端,返回流式响应(SSE 体不缓冲)。
    async fn forward(
        &self,
        method: Method,
        path_query: &str,
        headers: &HeaderMap,
        body: Vec<u8>,
    ) -> Result<Response>;

    /// 根据 workspace id 解析其文件系统根目录。
    async fn workspace_root(&self, id: &str) -> Result<PathBuf>;

    /// 后端是否健康/可达。
    async fn health(&self) -> bool;
}
```

- [ ] **Step 3: Create `backend/crush.rs` with `CrushBackend` and forwarding helpers**

Create `crates/combo-proxy/src/backend/crush.rs`. This module moves the existing `upstream_call` logic (from `handler.rs`) and `health_check` logic (from `rune.rs`) into crush-backend-owned code:

```rust
use crate::backend::{Backend, BackendType};
use crate::upstream::Upstream;
use anyhow::Result;
use axum::body::Body;
use axum::http::header::{CONNECTION, CONTENT_LENGTH, HOST, TRANSFER_ENCODING};
use axum::http::{HeaderMap, Method};
use axum::response::Response;
use futures_util::StreamExt;
use http_body_util::{BodyExt, Full};
use hyper_util::client::legacy::connect::HttpConnector;
use hyper_util::client::legacy::Client;
use hyper_util::rt::TokioExecutor;
use std::path::PathBuf;

/// Crush (rune) 后端:对运行中的 crush server 做透明转发。
/// 持有 `Upstream`(Unix socket 或 TCP 地址),所有 trait 方法
/// 直接代理 HTTP 请求。
pub struct CrushBackend {
    upstream: Upstream,
}

impl CrushBackend {
    pub fn new(upstream: Upstream) -> Self {
        Self { upstream }
    }

    /// 底层 upstream 地址(供健康状态报告用)。
    pub fn upstream(&self) -> &Upstream {
        &self.upstream
    }
}

#[async_trait::async_trait]
impl Backend for CrushBackend {
    fn backend_type(&self) -> BackendType {
        BackendType::Crush
    }

    async fn forward(
        &self,
        method: Method,
        path_query: &str,
        headers: &HeaderMap,
        body: Vec<u8>,
    ) -> Result<Response> {
        forward_to_upstream(&self.upstream, method, path_query, headers, body).await
    }

    async fn workspace_root(&self, id: &str) -> Result<PathBuf> {
        let pq = format!("/v1/workspaces/{id}");
        let resp = self
            .forward(Method::GET, &pq, &HeaderMap::new(), Vec::new())
            .await?;
        let status = resp.status();
        let bytes = axum::body::to_bytes(resp.into_body(), 1024 * 1024)
            .await
            .map_err(|e| anyhow::anyhow!("读取 workspace 响应失败: {e}"))?;
        if !status.is_success() {
            anyhow::bail!("查询 workspace 返回 {status}");
        }
        let v: serde_json::Value = serde_json::from_slice(&bytes)?;
        let path = v
            .get("path")
            .and_then(|p| p.as_str())
            .ok_or_else(|| anyhow::anyhow!("workspace 响应缺少 path 字段"))?;
        Ok(PathBuf::from(path))
    }

    async fn health(&self) -> bool {
        check_health(&self.upstream).await
    }
}

/// 向 upstream 发送请求并原样透传响应(SSE 流式不缓冲)。
/// (从 handler.rs 的 upstream_call 迁移而来。)
pub(crate) async fn forward_to_upstream(
    upstream: &Upstream,
    method: Method,
    path_query: &str,
    headers: &HeaderMap,
    body_bytes: Vec<u8>,
) -> Result<Response> {
    let (uri, _scheme) = match upstream {
        Upstream::Unix(path) => {
            let hex_host = hex::encode(path.to_string_lossy().as_bytes());
            (format!("unix://{hex_host}{path_query}"), "unix")
        }
        Upstream::Tcp(addr) => (format!("http://{addr}{path_query}"), "http"),
    };
    let uri: axum::http::Uri = uri.parse()?;

    let mut builder = axum::http::Request::builder().method(method).uri(uri);
    for (k, v) in headers.iter() {
        if k == HOST || k == CONNECTION || k == CONTENT_LENGTH || k == TRANSFER_ENCODING {
            continue;
        }
        builder = builder.header(k, v.clone());
    }
    builder = builder.header("X-Forwarded-Proto", "http");
    let up_req = builder.body(Full::from(body_bytes))?;

    let resp: hyper::Response<hyper::body::Incoming> = match upstream {
        Upstream::Unix(_) => {
            let connector = hyperlocal::UnixConnector;
            let client: Client<_, Full<bytes::Bytes>> =
                Client::builder(TokioExecutor::new()).build(connector);
            client.request(up_req).await?
        }
        Upstream::Tcp(_) => {
            let connector = HttpConnector::new();
            let client: Client<_, Full<bytes::Bytes>> =
                Client::builder(TokioExecutor::new()).build(connector);
            client.request(up_req).await?
        }
    };

    let (rparts, rbody) = resp.into_parts();
    let mut rb = Response::builder().status(rparts.status);
    for (k, v) in rparts.headers.iter() {
        if k == CONNECTION || k == TRANSFER_ENCODING {
            continue;
        }
        rb = rb.header(k, v.clone());
    }
    let stream = rbody.into_data_stream().map(|chunk| chunk.map_err(axum::Error::new));
    Ok(rb.body(Body::from_stream(stream))?)
}

/// GET /v1/health 健康探测(从 rune.rs 的 RuneManager::health_check 迁移)。
pub(crate) async fn check_health(upstream: &Upstream) -> bool {
    let uri = match upstream {
        Upstream::Unix(path) => {
            let hex_host = hex::encode(path.to_string_lossy().as_bytes());
            format!("unix://{hex_host}/v1/health")
        }
        Upstream::Tcp(addr) => format!("http://{addr}/v1/health"),
    };
    let uri: hyper::Uri = match uri.parse() {
        Ok(u) => u,
        Err(_) => return false,
    };
    let req = match hyper::Request::builder()
        .uri(uri)
        .body(Full::new(bytes::Bytes::new()))
    {
        Ok(r) => r,
        Err(_) => return false,
    };
    let resp = match upstream {
        Upstream::Unix(_) => {
            let connector = hyperlocal::UnixConnector;
            let client: Client<_, Full<bytes::Bytes>> =
                Client::builder(TokioExecutor::new()).build(connector);
            client.request(req).await
        }
        Upstream::Tcp(_) => {
            let connector = HttpConnector::new();
            let client: Client<_, Full<bytes::Bytes>> =
                Client::builder(TokioExecutor::new()).build(connector);
            client.request(req).await
        }
    };
    match resp {
        Ok(r) => r.status().is_success(),
        Err(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::StatusCode;
    use axum::routing::get;
    use axum::Router;

    /// 启动一个内存 stub upstream,提供 /v1/health 和 /v1/workspaces/:id。
    async fn stub_upstream(ws_path: String) -> std::net::SocketAddr {
        let app = Router::new()
            .route(
                "/v1/health",
                get(|| async { (StatusCode::OK, "ok") }),
            )
            .route(
                "/v1/workspaces/:id",
                get(move || async move {
                    axum::Json(serde_json::json!({ "id": "w1", "path": ws_path }))
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        addr
    }

    #[tokio::test]
    async fn crush_forward_proxies_health_endpoint() {
        let addr = stub_upstream("/tmp".into()).await;
        let backend = CrushBackend::new(Upstream::Tcp(addr));
        assert!(backend.health().await);

        let resp = backend
            .forward(Method::GET, "/v1/health", &HeaderMap::new(), Vec::new())
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn crush_workspace_root_resolves_path() {
        let addr = stub_upstream("/custom/path".into()).await;
        let backend = CrushBackend::new(Upstream::Tcp(addr));
        let root = backend.workspace_root("w1").await.unwrap();
        assert_eq!(root, PathBuf::from("/custom/path"));
    }

    #[tokio::test]
    async fn crush_health_returns_false_for_dead_upstream() {
        let backend = CrushBackend::new(Upstream::Tcp("127.0.0.1:1".parse().unwrap()));
        assert!(!backend.health().await);
    }

    #[test]
    fn crush_backend_type_is_crush() {
        let backend = CrushBackend::new(Upstream::Tcp("127.0.0.1:1".parse().unwrap()));
        assert_eq!(backend.backend_type(), BackendType::Crush);
    }
}
```

- [ ] **Step 4: Create `meta.rs` with `MetaStore` and `WorkspaceMeta`**

Create `crates/combo-proxy/src/meta.rs`:

```rust
//! combo 自有的 workspace 元数据存储。
//! 阶段 0 为内存缓存;后续阶段将拦截 workspace 创建来主动填充,
//! 使 combo 成为 workspace 元数据的唯一来源。

use crate::backend::BackendType;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

/// combo 拥有的 workspace 元数据。
#[derive(Clone, Debug)]
pub struct WorkspaceMeta {
    pub id: String,
    pub path: PathBuf,
    pub backend_type: BackendType,
}

/// 内存中的 workspace 元数据存储。
#[derive(Default)]
pub struct MetaStore {
    workspaces: Mutex<HashMap<String, WorkspaceMeta>>,
}

impl MetaStore {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn insert(&self, meta: WorkspaceMeta) {
        self.workspaces.lock().unwrap().insert(meta.id.clone(), meta);
    }

    pub fn get(&self, id: &str) -> Option<WorkspaceMeta> {
        self.workspaces.lock().unwrap().get(id).cloned()
    }

    pub fn remove(&self, id: &str) {
        self.workspaces.lock().unwrap().remove(id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn insert_and_get() {
        let store = MetaStore::new();
        store.insert(WorkspaceMeta {
            id: "w1".into(),
            path: "/tmp/ws1".into(),
            backend_type: BackendType::Crush,
        });
        let meta = store.get("w1").unwrap();
        assert_eq!(meta.id, "w1");
        assert_eq!(meta.path, PathBuf::from("/tmp/ws1"));
        assert_eq!(meta.backend_type, BackendType::Crush);
    }

    #[test]
    fn get_missing_returns_none() {
        let store = MetaStore::new();
        assert!(store.get("nope").is_none());
    }

    #[test]
    fn remove_deletes_entry() {
        let store = MetaStore::new();
        store.insert(WorkspaceMeta {
            id: "w1".into(),
            path: "/tmp".into(),
            backend_type: BackendType::Crush,
        });
        store.remove("w1");
        assert!(store.get("w1").is_none());
    }
}
```

- [ ] **Step 5: Add module declarations and re-exports to `lib.rs`**

Modify `crates/combo-proxy/src/lib.rs`. Add these lines to the existing module declarations (after `pub mod upstream;`):

```rust
pub mod backend;
pub mod meta;
```

Add these re-exports after the existing `pub use` lines:

```rust
pub use backend::crush::CrushBackend;
pub use backend::{Backend, BackendType};
pub use meta::{MetaStore, WorkspaceMeta};
```

Do NOT change any existing code in `lib.rs` — these are purely additive.

- [ ] **Step 6: Run tests to verify the new modules compile and pass**

Run: `cargo test -p combo-proxy`
Expected: all existing tests pass + new tests in `backend::crush` (4 tests) and `meta` (3 tests) pass.

- [ ] **Step 7: Commit**

```bash
git add crates/combo-proxy/Cargo.toml crates/combo-proxy/src/backend/ crates/combo-proxy/src/meta.rs crates/combo-proxy/src/lib.rs Cargo.lock
git commit -m "refactor: introduce Backend trait, CrushBackend, and MetaStore

Add a Backend trait abstracting request forwarding, workspace-root
resolution, and health checking. CrushBackend wraps the existing
crush pass-through logic. MetaStore provides in-memory workspace
metadata storage for future phases. No existing code is modified
yet — these are new modules exported alongside the current API."
```

---

### Task 2: Migrate router state from `Arc<Upstream>` to `AppState`

This is the atomic state-type migration. All steps must be completed before `cargo build` succeeds. Steps are ordered to minimize confusion but cannot be tested individually.

**Files:**
- Modify: `crates/combo-proxy/src/lib.rs` (add AppState, change serve signature)
- Modify: `crates/combo-proxy/src/handler.rs` (proxy uses backend.forward, remove upstream_call + forward)
- Modify: `crates/combo-proxy/src/fs.rs` (handlers use backend.workspace_root, remove local workspace_root fn)
- Modify: `crates/combo-proxy/src/router.rs` (state = AppState)
- Modify: `crates/combo-proxy/src/rune.rs` (health_check delegates to crush::check_health)
- Modify: `crates/combo-proxy/src/main.rs` (create CrushBackend + AppState)
- Modify: `src-tauri/src/lib.rs` (create CrushBackend + AppState)
- Modify: `crates/combo-proxy/tests/proxy_test.rs` (update start_proxy helper)

**Interfaces:**
- Consumes: `Backend` trait, `CrushBackend`, `MetaStore` from Task 1
- Produces: `AppState { backend: Arc<dyn Backend>, meta: Arc<MetaStore> }`, all handlers refactored to use it

- [ ] **Step 1: Define `AppState` in `lib.rs`**

In `crates/combo-proxy/src/lib.rs`, add this struct definition (after the re-exports, before `parse_upstream`):

```rust
use std::sync::Arc;

/// 所有 axum handler 共享的应用状态。
#[derive(Clone)]
pub struct AppState {
    pub backend: Arc<dyn Backend>,
    pub meta: Arc<MetaStore>,
}
```

- [ ] **Step 2: Change `serve()` signature in `lib.rs`**

Replace the existing `serve` function:

```rust
/// Runs the proxy on `listener`, forwarding to `upstream`.
pub async fn serve(
    listener: tokio::net::TcpListener,
    upstream: Upstream,
    allowed_origins: Vec<String>,
) -> anyhow::Result<()> {
    let app = build_router(upstream, allowed_origins);
    axum::serve(listener, app).await?;
    Ok(())
}
```

with:

```rust
/// Runs the proxy on `listener`.
pub async fn serve(
    listener: tokio::net::TcpListener,
    state: AppState,
    allowed_origins: Vec<String>,
) -> anyhow::Result<()> {
    let app = build_router(state, allowed_origins);
    axum::serve(listener, app).await?;
    Ok(())
}
```

- [ ] **Step 3: Rewrite `handler.rs`**

Replace the entire contents of `crates/combo-proxy/src/handler.rs` with:

```rust
use crate::AppState;
use axum::body::Body;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::Response;

/// 反向代理 handler:将请求转发到后端 backend,
/// 响应体流式透传(SSE 不缓冲)。
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
    match state
        .backend
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{CrushBackend, MetaStore, Upstream};
    use axum::http::header::ACCEPT;
    use axum::http::Request;
    use std::sync::Arc;

    #[tokio::test]
    async fn proxy_returns_502_for_unreachable_upstream() {
        let state = AppState {
            backend: Arc::new(CrushBackend::new(Upstream::Tcp(
                "127.0.0.1:1".parse().unwrap(),
            ))),
            meta: Arc::new(MetaStore::new()),
        };
        let req = Request::builder()
            .uri("/v1/health")
            .header(ACCEPT, "application/json")
            .body(Body::empty())
            .unwrap();
        let resp = proxy(State(state), req).await;
        assert_eq!(resp.status(), StatusCode::BAD_GATEWAY);
    }
}
```

Note: `upstream_call` and `forward` functions are removed — their logic now lives in `CrushBackend::forward`.

- [ ] **Step 4: Rewrite `fs.rs` handler signatures**

In `crates/combo-proxy/src/fs.rs`, make three changes:

1. Replace the imports block. Change:
```rust
use crate::handler::upstream_call;
use crate::upstream::Upstream;
```
to:
```rust
use crate::AppState;
```

2. Delete the entire `workspace_root` function (the `async fn workspace_root(upstream: &Upstream, id: &str) -> anyhow::Result<PathBuf>` function, approximately lines 48-72).

3. In all three handlers (`list`, `read`, `write`), replace:
```rust
State(upstream): State<Arc<Upstream>>,
```
with:
```rust
State(state): State<AppState>,
```
and replace:
```rust
let root = match workspace_root(&upstream, &id).await {
```
with:
```rust
let root = match state.backend.workspace_root(&id).await {
```

Also remove the now-unused `use std::sync::Arc;` import if no other code in the file uses `Arc`.

- [ ] **Step 5: Rewrite `router.rs`**

Replace the entire contents of `crates/combo-proxy/src/router.rs` with:

```rust
use crate::fs;
use crate::handler::proxy;
use crate::AppState;
use axum::routing::get;
use axum::Router;
use tower_http::cors::{Any, CorsLayer};

/// 构建 proxy router。`allowed_origins` 为空时 CORS 全开放(开发模式)。
pub fn build_router(state: AppState, allowed_origins: Vec<String>) -> Router {
    let cors = if allowed_origins.is_empty() {
        CorsLayer::permissive()
    } else {
        let origins: Vec<axum::http::HeaderValue> = allowed_origins
            .iter()
            .map(|o| {
                o.parse()
                    .expect("allowed_origins must contain valid origin values")
            })
            .collect();
        CorsLayer::new()
            .allow_origin(origins)
            .allow_methods(Any)
            .allow_headers(Any)
    };
    Router::new()
        .route("/v1/workspaces/:id/files/list", get(fs::list))
        .route(
            "/v1/workspaces/:id/files/content",
            get(fs::read).put(fs::write),
        )
        .fallback(proxy)
        .with_state(state)
        .layer(cors)
}
```

- [ ] **Step 6: Update `rune.rs` health check to delegate**

In `crates/combo-proxy/src/rune.rs`, replace the `health_check` method body. Change:

```rust
/// GET /v1/health over the upstream (Unix socket or TCP).
pub async fn health_check(&self, upstream: &Upstream) -> bool {
    let uri = match upstream {
        Upstream::Unix(path) => {
            let hex_host = hex::encode(path.to_string_lossy().as_bytes());
            format!("unix://{hex_host}/v1/health")
        }
        Upstream::Tcp(addr) => format!("http://{addr}/v1/health"),
    };
    let uri: hyper::Uri = match uri.parse() {
        Ok(u) => u,
        Err(_) => return false,
    };
    let req = match hyper::Request::builder()
        .uri(uri)
        .body(Full::new(bytes::Bytes::new()))
    {
        Ok(r) => r,
        Err(_) => return false,
    };
    let resp = match upstream {
        Upstream::Unix(_) => {
            let connector = hyperlocal::UnixConnector;
            let client: Client<_, Full<bytes::Bytes>> =
                Client::builder(TokioExecutor::new()).build(connector);
            client.request(req).await
        }
        Upstream::Tcp(_) => {
            let connector = HttpConnector::new();
            let client: Client<_, Full<bytes::Bytes>> =
                Client::builder(TokioExecutor::new()).build(connector);
            client.request(req).await
        }
    };
    match resp {
        Ok(r) => r.status().is_success(),
        Err(_) => false,
    }
}
```

to:

```rust
/// GET /v1/health over the upstream (Unix socket or TCP).
pub async fn health_check(&self, upstream: &Upstream) -> bool {
    crate::backend::crush::check_health(upstream).await
}
```

Then remove the now-unused imports at the top of `rune.rs`. The imports `http_body_util::Full`, `hyper_util::client::legacy::connect::HttpConnector`, `hyper_util::client::legacy::Client`, `hyper_util::rt::TokioExecutor` are no longer needed by `health_check` (they are still used by `post_control_shutdown`, so check before removing). Keep any imports still used by `post_control_shutdown`.

> **Note:** `post_control_shutdown` still uses `Full`, `Client`, `TokioExecutor`, `hyperlocal::UnixConnector`, `HttpConnector` — so keep those imports. Only remove truly unused ones after checking.

- [ ] **Step 7: Update `main.rs`**

Replace the contents of `crates/combo-proxy/src/main.rs` with:

```rust
use anyhow::Result;
use combo_proxy::rune::RuneManager;
use combo_proxy::{parse_upstream, serve, AppState, CrushBackend, MetaStore, Upstream};
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::net::TcpListener;

#[tokio::main]
async fn main() -> Result<()> {
    let mut args = std::env::args().skip(1);
    let mut upstream_arg = None;
    let mut port: u16 = 0;
    let mut host: std::net::IpAddr = [127, 0, 0, 1].into();
    let mut origins = Vec::new();
    while let Some(a) = args.next() {
        match a.as_str() {
            "--upstream" => upstream_arg = Some(args.next().unwrap()),
            "--port" => port = args.next().unwrap().parse()?,
            "--host" => host = args.next().unwrap().parse()?,
            "--origin" => origins.push(args.next().unwrap()),
            _ => {}
        }
    }
    let upstream: Upstream = match upstream_arg {
        Some(s) => parse_upstream(&s)?,
        None => {
            // 自动接管 rune 生命周期
            let mut mgr = RuneManager::new(
                std::env::var("COMBO_CRUSH_BIN").unwrap_or_else(|_| "crush".into()),
            );
            let u = mgr.ensure_running().await?;
            println!("COMBO_RUNE_STATUS=connected");
            u
        }
    };

    let state = AppState {
        backend: Arc::new(CrushBackend::new(upstream)),
        meta: Arc::new(MetaStore::new()),
    };

    let listener = TcpListener::bind(SocketAddr::new(host, port)).await?;
    let actual = listener.local_addr()?.port();
    println!("COMBO_PROXY_PORT={actual}");
    serve(listener, state, origins).await?;
    Ok(())
}
```

- [ ] **Step 8: Update `src-tauri/src/lib.rs`**

In `src-tauri/src/lib.rs`, replace the `init_backend` function. Change the `use` statement inside the function and the body after the upstream is resolved. The function becomes:

```rust
async fn init_backend(app: &tauri::AppHandle) {
    use combo_proxy::rune::RuneManager;
    use combo_proxy::{serve, AppState, CrushBackend, MetaStore, Upstream};
    use std::net::SocketAddr;
    use std::sync::Arc;
    use tokio::net::TcpListener;

    let bin = std::env::var("COMBO_CRUSH_BIN").unwrap_or_else(|_| "crush".into());
    let mut mgr = RuneManager::new(bin);
    let upstream = match mgr.ensure_running().await {
        Ok(u) => {
            let _ = app.emit(EVENT_RUNE_STATUS, RuneStatus { connected: true });
            u
        }
        Err(e) => {
            eprintln!("rune server failed: {e:?}");
            let _ = app.emit(EVENT_RUNE_STATUS, RuneStatus { connected: false });
            // 用不可达 TCP 地址保持代理存活,UI 显示断开
            Upstream::Tcp("127.0.0.1:1".parse().unwrap())
        }
    };

    let state = AppState {
        backend: Arc::new(CrushBackend::new(upstream)),
        meta: Arc::new(MetaStore::new()),
    };

    let listener = match TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0))).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("proxy bind failed: {e:?}");
            return;
        }
    };
    let port = listener.local_addr().map(|a| a.port()).unwrap_or(0);
    let origins = vec![
        "tauri://localhost".to_string(),
        "http://localhost:5173".to_string(),
    ];
    let _ = app.emit(EVENT_PROXY_READY, ProxyReady { port });
    if let Err(e) = serve(listener, state, origins).await {
        eprintln!("proxy exited: {e:?}");
    }
}
```

- [ ] **Step 9: Update `proxy_test.rs`**

In `crates/combo-proxy/tests/proxy_test.rs`, update the `start_proxy` helper function. Change:

```rust
use combo_proxy::{serve, Upstream};
```

to:

```rust
use combo_proxy::{serve, AppState, CrushBackend, MetaStore, Upstream};
```

Add at the top of the file (after existing `use` statements):

```rust
use std::sync::Arc;
```

Replace the `start_proxy` function:

```rust
async fn start_proxy(upstream_addr: SocketAddr, origins: Vec<String>) -> SocketAddr {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let proxy_addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        serve(listener, Upstream::Tcp(upstream_addr), origins)
            .await
            .unwrap();
    });
    proxy_addr
}
```

with:

```rust
async fn start_proxy(upstream_addr: SocketAddr, origins: Vec<String>) -> SocketAddr {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let proxy_addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let state = AppState {
            backend: Arc::new(CrushBackend::new(Upstream::Tcp(upstream_addr))),
            meta: Arc::new(MetaStore::new()),
        };
        serve(listener, state, origins).await.unwrap();
    });
    proxy_addr
}
```

- [ ] **Step 10: Build and fix any compilation errors**

Run: `cargo build -p combo-proxy`
Expected: compiles successfully. If there are unused-import warnings in `rune.rs` (from removed `health_check` body), remove those imports. If `fs.rs` has an unused `Arc` import, remove it.

- [ ] **Step 11: Run full test suite**

Run: `cargo test -p combo-proxy`
Expected: ALL tests pass — the 5 existing proxy integration tests, the handler unit test, the rune unit tests, the lib parse tests, plus the new backend/meta tests from Task 1.

- [ ] **Step 12: Commit**

```bash
git add -A
git commit -m "refactor: migrate router state to AppState with Backend trait

Replace Arc<Upstream> router state with AppState holding
Arc<dyn Backend> + Arc<MetaStore>. All handlers (proxy, file service)
now route through the Backend trait instead of directly calling
upstream_call. CrushBackend provides transparent pass-through,
preserving exact behavior. RuneManager.health_check delegates to the
shared check_health helper."
```

---

### Task 3: Full verification and cleanup

**Files:**
- Verify only (fix warnings if found)

- [ ] **Step 1: Run Rust tests**

Run: `cargo test -p combo-proxy`
Expected: all tests pass (same count as end of Task 2).

- [ ] **Step 2: Run frontend typecheck**

Run: `npm run tsc`
Expected: passes (no frontend changes were made, so this is a sanity check).

- [ ] **Step 3: Run frontend unit tests**

Run: `npm test`
Expected: passes (no frontend changes).

- [ ] **Step 4: Check for compiler warnings**

Run: `cargo build -p combo-proxy 2>&1 | grep warning`
Expected: no warnings related to the refactor. If any unused-import warnings remain, fix and re-commit.

- [ ] **Step 5: Commit any fixups (if needed)**

Only if Step 4 found warnings:

```bash
git add -A
git commit -m "fix: clean up unused imports from backend refactor"
```

---

## Self-Review Notes

**Spec coverage:** The design doc's Phase 0 specifies: Backend trait + proto.rs → covered by Task 1 (proto.rs deferred — the trait uses raw axum types which is sufficient for the pass-through CrushBackend; structured combo protocol types are needed in Phase 1+ when process-type backends synthesize responses); CrushBackend → Task 1; fs.rs改用workspace_root() → Task 2 Step 4; combo元数据层(meta.rs) → Task 1 Step 4.

**Type consistency:** `AppState` is defined in `lib.rs`, used identically in handler.rs, fs.rs, router.rs. `CrushBackend::new(Upstream)` matches the `Upstream` type from upstream.rs. `Backend::forward` signature matches what proxy() passes. `Backend::workspace_root` returns `Result<PathBuf>` matching fs.rs usage.

**Deferred items (noted in design doc, out of Phase 0 scope):**
- `proto.rs` structured types (needed when backends synthesize responses)
- MetaStore wiring into request flow (lazy cache / workspace creation interception — Phase 1)
- `BackendType` serialization for frontend (Phase 1 when UI needs it)
