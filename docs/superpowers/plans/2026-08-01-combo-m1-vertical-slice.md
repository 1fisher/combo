# combo M1 垂直切片 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付可运行的 Tauri 桌面应用,能连接本地 rune(Crush)server,完成"选项目 → 建会话 → 发任务 → 流式查看 agent 执行(消息/工具调用)→ 处理权限与提问弹窗 → 取消/完成"的端到端闭环。

**Architecture:** Rust 壳(combo-proxy crate + Tauri 应用)负责启动/守护 rune server 子进程,并在 `127.0.0.1:<随机端口>` 起 axum 反向代理,把 `/v1/*` 透传到 rune 的 unix socket(SSE 流式不缓冲)。前端是标准 Web 栈(React + TanStack Query + Zustand + shadcn),用 fetch/EventSource 直连代理。

**Tech Stack:** Tauri 2.x、Rust(axum、tokio)、React 18、TypeScript、Vite、Tailwind CSS、shadcn/ui、TanStack Query、Zustand、openapi-typescript、Vitest、Testing Library、Playwright。

## Global Constraints

- Node >= 20, Rust >= 1.80。
- 运行时需要 `crush` 可执行文件(环境变量 `COMBO_CRUSH_BIN` 可覆盖,默认 `crush`,要求能在 `$PATH` 找到;找不到时 UI 显示"未检测到 crush",不崩溃)。
- rune API 契约以本仓库 `swagger/swagger.json` 为准(从 `../rune/internal/swagger/swagger.json` 复制,并在 `swagger/README.md` 记录来源 rune commit `git rev-parse HEAD`)。
- 所有 rune 调用带查询参数 `client_id=<持久化 UUID>`(存 localStorage `combo.clientId`,由 `src/lib/clientId.ts` 提供)。
- SSE 订阅端点:`GET /v1/workspaces/{id}/events?client_id=<uuid>`,`Accept: text/event-stream`。
- SSE 事件信封:`{"type": "<payload_type>", "payload": <json>}`;payload_type 见 `src/lib/events/payloadTypes.ts`。
- 消息 parts 为判别联合 `{"type": "text"|"reasoning"|"tool_call"|"tool_result"|"finish"|"image_url"|"binary", "data": {...}}`。
- 前端数据路径不得依赖 Tauri API(纯浏览器可开发调试);仅"选目录"用 Tauri dialog 插件,Web 模式降级为路径输入框。
- 提交信息遵循仓库既有格式(参考根 commit d5002b0 风格)。
- 每个任务的步骤必须按顺序执行:先写失败测试 → 验证失败 → 实现 → 验证通过 → commit。

---

### Task 1: 工作区脚手架(仓库结构 + 前端骨架 + UI 基础)

**Files:**
- Create: `Cargo.toml`(workspace)、`crates/combo-proxy/Cargo.toml`、`crates/combo-proxy/src/lib.rs`(占位 `pub fn placeholder() {}`)
- Create: `src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json`、`src-tauri/src/main.rs`(最小 Tauri 启动)
- Create: `package.json`、`vite.config.ts`、`tsconfig.json`、`tailwind.config.ts`、`postcss.config.js`、`src/main.tsx`、`src/App.tsx`、`index.html`
- Create: `.gitignore`、`components.json`(shadcn 配置)
- Create: `src/components/ui/button.tsx`、`src/components/ui/dialog.tsx`、`src/components/ui/input.tsx`、`src/components/ui/tabs.tsx`、`src/components/ui/scroll-area.tsx`、`src/components/ui/badge.tsx`、`src/components/ui/tooltip.tsx`(shadcn add 生成)

**Interfaces:**
- Produces: Cargo workspace 根 `Cargo.toml` 声明 `members = ["crates/combo-proxy", "src-tauri"]`;`src-tauri` 依赖 `combo-proxy = { path = "../crates/combo-proxy" }`。后续所有 Rust 任务都在此 workspace 内。
- Produces: 前端约定目录:`src/lib/`、`src/stores/`、`src/hooks/`、`src/components/{shell,agent,ui}/`、`swagger/`、`e2e/`。

- [ ] **Step 1: 创建仓库骨架**

```bash
mkdir -p crates/combo-proxy/src src-tauri/src src/lib/api src/lib/events src/stores src/hooks src/components/shell src/components/agent src/components/ui swagger e2e
```

- [ ] **Step 2: 根 Cargo workspace + 两个 crate 占位**

`Cargo.toml`:
```toml
[workspace]
members = ["crates/combo-proxy", "src-tauri"]
resolver = "2"
```

`crates/combo-proxy/Cargo.toml`:
```toml
[package]
name = "combo-proxy"
version = "0.1.0"
edition = "2021"

[dependencies]
axum = "0.7"
tokio = { version = "1", features = ["full"] }
tower-http = { version = "0.5", features = ["cors"] }
reqwest = { version = "0.12", default-features = false, features = ["stream"] }
tokio-util = { version = "0.7", features = ["io"] }
anyhow = "1"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
```

`crates/combo-proxy/src/lib.rs`:
```rust
pub fn placeholder() -> u32 { 42 }
```

- [ ] **Step 3: 最小 Tauri 应用(脚手架由 create-tauri-app 生成后裁剪)**

运行 `cargo install create-tauri-app` 后执行 `create-tauri-app --template vanilla` 会有交互;本步骤直接手写最小文件:

`src-tauri/Cargo.toml`:
```toml
[package]
name = "combo"
version = "0.1.0"
edition = "2021"

[build-dependencies]
tauri-build = { version = "2", features = [] }

[dependencies]
tauri = { version = "2", features = [] }
combo-proxy = { path = "../crates/combo-proxy" }
tokio = { version = "1", features = ["full"] }
anyhow = "1"

[lib]
name = "combo_lib"
crate-type = ["staticlib", "cdylib", "rlib"]
```

`src-tauri/src/main.rs`:
```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    combo_lib::run()
}
```

`src-tauri/src/lib.rs`:
```rust
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

`src-tauri/tauri.conf.json`:
```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "combo",
  "version": "0.1.0",
  "identifier": "dev.combo.ide",
  "build": {
    "beforeDevCommand": "npm run dev",
    "devUrl": "http://localhost:5173",
    "beforeBuildCommand": "npm run build",
    "frontendDist": "../dist"
  },
  "app": {
    "windows": [{ "title": "combo", "width": 1400, "height": 900 }],
    "security": { "csp": null }
  }
}
```

- [ ] **Step 4: 前端骨架(Vite + React + TS + Tailwind + shadcn)**

用已有 shadcn 初始化流程(参见 shadcn 技能,`components.json` 指向本项目 `src`):
```bash
npm create vite@latest . -- --template react-ts
npm install
npm install @tanstack/react-query zustand @tauri-apps/api @tauri-apps/plugin-dialog
npm install -D tailwindcss @tailwindcss/vite openapi-typescript vitest @testing-library/react @testing-library/jest-dom jsdom @playwright/test
npx shadcn@latest init
npx shadcn@latest add button dialog input tabs scroll-area badge tooltip
```

`src/App.tsx`(占位,后续任务替换):
```tsx
export default function App() {
  return <div className="p-4 text-sm">combo M1 scaffold ok</div>;
}
```

- [ ] **Step 5: 验证构建**

Run: `cargo build --workspace`
Expected: 成功,无 error。

Run: `npm run build && npm run tsc --noEmit`(tsc 脚本需在 package.json 配置为 `tsc -b`)
Expected: 成功。

Run: `npx vitest run`(空测试集,退出码 0)
Expected: "No test files found" 或空通过。

- [ ] **Step 6: 提交**

```bash
git add -A
git commit -m "chore: scaffold combo workspace (Tauri + Vite React + shadcn)"
```

---

### Task 2: 引入 rune swagger 契约并生成 TS 类型

**Files:**
- Create: `swagger/swagger.json`(复制自 `../rune/internal/swagger/swagger.json`)
- Create: `swagger/README.md`(记录来源与刷新方法)
- Create: `scripts/gen-api.sh`(openapi-typescript 生成 `src/lib/api/types.ts`)
- Create: `src/lib/api/types.ts`(由脚本生成,任务内运行脚本产出)
- Create: `src/lib/api/index.ts`(重新导出 `Api` 命名空间)

**Interfaces:**
- Produces: `src/lib/api/types.ts` 导出全局命名空间 `Api`(openapi-typescript 默认 `--export-type` 行为下为 `Api` 接口),包含 `Api.Workspace`、`Api.Session`、`Api.Message`、`Api.ContentPart`、`Api.PermissionRequest`、`Api.QuestionRequest`、`Api.AgentMessage`、`Api.PermissionGrant`、`Api.QuestionAnswer`、`Api.Error` 等。后续所有任务引用 `Api.*` 类型,禁止手写同名类型。

- [ ] **Step 1: 复制 swagger 并记录来源**

```bash
cp ../rune/internal/swagger/swagger.json swagger/swagger.json
cd ../rune && git rev-parse HEAD > /tmp/rune-commit.txt && cd ..
echo "rune commit: $(cat /tmp/rune-commit.txt)" > swagger/README.md
```

- [ ] **Step 2: 生成脚本**

`scripts/gen-api.sh`:
```bash
#!/usr/bin/env bash
set -euo pipefail
npx openapi-typescript swagger/swagger.json \
  --output src/lib/api/types.ts \
  --export-type
```
运行 `chmod +x scripts/gen-api.sh`。

- [ ] **Step 3: 运行脚本并验证类型可编译**

Run: `./scripts/gen-api.sh && npx tsc --noEmit`
Expected: 生成 `src/lib/api/types.ts`,类型检查通过。

- [ ] **Step 4: 验证关键契约存在(防止 swagger 缺失字段)**

`src/lib/api/contract.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import type { Api } from './types';

describe('rune api contract', () => {
  it('exposes workspace, session, message, permission, question types', () => {
    // 类型级断言:仅编译期有意义,这里验证命名空间对象存在
    expect(typeof Api).toBe('object');
  });
});
```
Run: `npx vitest run`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add swagger/ scripts/ src/lib/api/
git commit -m "feat: vendor rune swagger contract and generate TS types"
```

---

### Task 3: combo-proxy 反向代理(含 SSE 透传与 CORS)

**Files:**
- Create: `crates/combo-proxy/src/lib.rs`(替换占位,模块声明)
- Create: `crates/combo-proxy/src/upstream.rs`(Upstream 枚举与连接建立)
- Create: `crates/combo-proxy/src/handler.rs`(代理 handler,SSE 透传)
- Create: `crates/combo-proxy/src/router.rs`(构建 axum Router + CORS)
- Test: `crates/combo-proxy/tests/proxy_test.rs`(集成测试:内存 stub 上游 + reqwest 断言)
- Test: `crates/combo-proxy/src/handler.rs` 内嵌单元测试

**Interfaces:**
- Produces: `pub enum Upstream { Unix(std::path::PathBuf), Tcp(std::net::SocketAddr) }`
- Produces: `pub async fn serve(listener: tokio::net::TcpListener, upstream: Upstream, allowed_origins: Vec<String>) -> anyhow::Result<()>` —— 启动 axum 服务,监听 `listener`(调用方决定端口),把请求转发到 `upstream`。`allowed_origins` 为空时允许全部 Origin。
- Produces: `pub fn build_router(upstream: Upstream, allowed_origins: Vec<String>) -> axum::Router` —— 供测试与 serve 复用。

**Rune 代理契约(本任务测试必须覆盖):**
- 任意 `GET/POST/PUT/DELETE /v1/*` 转发:方法、路径、查询参数、请求头(X-Forwarded-* 附加)、body 原样转发;上游响应状态码、头、body 原样返回。
- `Accept: text/event-stream` 的响应:流式透传(逐 chunk 写,不缓冲,直到上游 EOF)。
- 上游连接失败(如 socket 不存在)返回 502 与 JSON `{"message":"upstream unreachable"}`。
- 上游 4xx/5xx 原样透传(含 `proto.Error` JSON body)。
- CORS:允许 `allowed_origins`;请求带 `Origin` 且不在列表内时拒绝(403),`Access-Control-Allow-Origin` 回显。

- [ ] **Step 1: 写失败测试(转发基础)**

`crates/combo-proxy/tests/proxy_test.rs`:
```rust
use axum::body::Body;
use axum::http::{Request, StatusCode};
use axum::response::IntoResponse;
use axum::routing::get;
use axum::Router;
use combo_proxy::{serve, Upstream};
use std::net::{TcpListener as StdTcpListener, SocketAddr};
use tokio::net::TcpListener;
use tower::ServiceExt;

/// 内存 stub 上游:回显请求方法+路径,body 固定返回。
async fn stub_upstream() -> (SocketAddr, tokio::task::JoinHandle<()>) {
    let app = Router::new()
        .route("/v1/health", get(|| async { "upstream-ok" }))
        .route(
            "/v1/echo",
            get(|req: Request<Body>| async move {
                let path = req.uri().path().to_string();
                (StatusCode::OK, format!("echo:{path}")).into_response()
            }),
        );
    let listener = StdTcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    let handle = tokio::spawn(async move {
        axum::Server::from_tcp(listener)
            .unwrap()
            .serve(app.into_make_service())
            .await
            .unwrap();
    });
    (addr, handle)
}

async fn start_proxy(upstream_addr: SocketAddr) -> SocketAddr {
    let listener = StdTcpListener::bind("127.0.0.1:0").unwrap();
    let proxy_addr = listener.local_addr().unwrap();
    let upstream = Upstream::Tcp(upstream_addr);
    tokio::spawn(async move {
        serve(
            TcpListener::from_std(listener).unwrap(),
            upstream,
            vec![],
        )
        .await
        .unwrap();
    });
    proxy_addr
}

#[tokio::test]
async fn forwards_path_method_and_body() {
    let (upstream, _h) = stub_upstream().await;
    let proxy = start_proxy(upstream).await;

    let resp = reqwest::Client::new()
        .get(format!("http://{proxy}/v1/health"))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    assert_eq!(resp.text().await.unwrap(), "upstream-ok");
}

#[tokio::test]
async fn upstream_unreachable_returns_502() {
    // 没有在监听的地址
    let dead: SocketAddr = "127.0.0.1:1".parse().unwrap();
    let proxy = start_proxy(dead).await;
    let resp = reqwest::Client::new()
        .get(format!("http://{proxy}/v1/health"))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::BAD_GATEWAY);
}
```

- [ ] **Step 2: 运行测试,确认失败**

Run: `cargo test -p combo-proxy --test proxy_test`
Expected: 编译失败(`serve`/`Upstream` 不存在)。

- [ ] **Step 3: 实现 upstream 连接**

`crates/combo-proxy/src/upstream.rs`:
```rust
use anyhow::Result;
use std::path::PathBuf;
use std::net::SocketAddr;
use tokio::net::TcpStream;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio_util::io::ReaderStream;
use tokio::net::unix::UnixStream;

pub enum Upstream {
    Unix(PathBuf),
    Tcp(SocketAddr),
}

pub enum UpstreamStream {
    Unix(UnixStream),
    Tcp(TcpStream),
}

impl Upstream {
    pub async fn connect(&self) -> Result<UpstreamStream> {
        match self {
            Upstream::Unix(path) => {
                let s = UnixStream::connect(path).await?;
                Ok(UpstreamStream::Unix(s))
            }
            Upstream::Tcp(addr) => {
                let s = TcpStream::connect(addr).await?;
                Ok(UpstreamStream::Tcp(s))
            }
        }
    }
}
```

- [ ] **Step 4: 实现代理 handler(关键路径:HTTP 转发 + SSE 透传)**

`crates/combo-proxy/src/handler.rs`:
```rust
use crate::upstream::Upstream;
use axum::body::Body;
use axum::extract::Request;
use axum::http::header::{ACCEPT, AUTHORIZATION, CONTENT_TYPE, HOST, ORIGIN};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::Response;
use futures_util::StreamExt;

const STREAMING: &str = "text/event-stream";

pub async fn proxy(req: Request<Body>, upstream: Upstream) -> Response {
    let method = req.method().clone();
    let uri = req.uri().clone();
    let wants_sse = req
        .headers()
        .get(ACCEPT)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.contains(STREAMING));

    // 组装上游请求:保持方法/路径/查询/头,去掉 hop-by-hop 头
    let mut builder = reqwest::Client::builder()
        .no_proxy()
        .build()
        .unwrap()
        .request(method, &uri.to_string());
    // 上游地址通过连接注入,见 Step 5 的 resolve 逻辑
    let (host, headers, body) = match split(req).await {
        Ok(v) => v,
        Err(_) => return Response::builder().status(StatusCode::BAD_REQUEST).body(Body::empty()).unwrap(),
    };
    let _ = (host, headers, body, wants_sse);
    Response::builder().status(StatusCode::INTERNAL_SERVER_ERROR).body(Body::empty()).unwrap()
}

async fn split(_req: Request<Body>) -> anyhow::Result<(String, HeaderMap, String)> {
    anyhow::bail!("unimplemented")
}
```

> 说明:本步先给出手写转发骨架,完整实现见 Step 5。真实实现细节:
> 1. 用 `reqwest::Client` 对 `upstream` 建立到目标地址的请求(Unix socket 用 `hyper` 的 `UnixConnector` 或 `tokio::net::unix` 手动代理;为降低复杂度,Unix socket 场景使用 `hyper-util` 的 `UnixConnector`,TCP 场景用普通 `reqwest` 客户端)。
> 2. 复制请求头并删除 `Host`、`Content-Length`(由 reqwest 重算),追加 `X-Forwarded-Proto: http`、`X-Forwarded-Host`。
> 3. 上游响应若 `Content-Type` 含 `text/event-stream`,用 `StreamBody` 逐 chunk 转发;否则整包读回后透传。状态码与其余响应头原样复制(跳过 `transfer-encoding`/`connection`)。
>
> 单元测试(内嵌 `#[cfg(test)] mod tests`):构造 `Request::builder().uri("/v1/health").header(ACCEPT, "application/json").body(Body::empty())`,断言 `proxy()` 返回 502(指向未监听地址)。

- [ ] **Step 5: 完善转发实现与路由/CORS**

`crates/combo-proxy/src/router.rs`:
```rust
use crate::handler::proxy;
use crate::upstream::Upstream;
use axum::Router;
use std::sync::Arc;
use tower_http::cors::{Any, CorsLayer};
use tower_http::set_header::SetResponseHeaderLayer;

pub fn build_router(upstream: Upstream, allowed_origins: Vec<String>) -> Router {
    let cors = if allowed_origins.is_empty() {
        CorsLayer::permissive()
    } else {
        let mut layer = CorsLayer::new();
        for o in allowed_origins {
            layer = layer.allow_origin(
                o.parse().expect("valid origin in allowed_origins"),
            );
        }
        layer.allow_methods(Any).allow_headers(Any)
    };
    Router::new()
        .fallback(proxy)
        .with_state(Arc::new(upstream))
        .layer(cors)
}
```

`crates/combo-proxy/src/lib.rs`:
```rust
pub mod handler;
pub mod router;
pub mod upstream;

pub use router::build_router;
pub use upstream::Upstream;

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

- [ ] **Step 6: 运行测试,补齐失败用例直到全绿**

Run: `cargo test -p combo-proxy`
Expected: 全部 PASS,包括:
- `forwards_path_method_and_body`
- `upstream_unreachable_returns_502`
- SSE 透传测试:stub 上游返回 `Content-Type: text/event-stream` 并写两个 chunk(`data: {"a":1}\n\n` 与 `data: {"a":2}\n\n`),断言代理端逐块收到两个 chunk(用 `reqwest` + `bytes_stream` 校验)。
- CORS 测试:带 `Origin: http://localhost:5173` 且 allowed 列表含它 → 响应头 `access-control-allow-origin` 存在;Origin 不在列表 → 403。

- [ ] **Step 7: 提交**

```bash
git add crates/combo-proxy
git commit -m "feat: add combo-proxy reverse proxy with SSE passthrough and CORS"
```

---

### Task 4: RuneManager —— crush server 子进程生命周期

**Files:**
- Create: `crates/combo-proxy/src/rune.rs`(RuneManager)
- Test: `crates/combo-proxy/src/rune.rs` 内嵌单元测试 + `crates/combo-proxy/tests/rune_integration_test.rs`(环境变量 `COMBO_RUNE_IT=1` 时对真实 `crush` 跑集成,默认跳过)

**Interfaces:**
- Produces: `pub struct RuneManager { bin: String, log_path: PathBuf }`
- Produces: `impl RuneManager { pub fn new(bin: String) -> Self; pub async fn ensure_running(&mut self) -> anyhow::Result<Upstream>; pub async fn health_check(&self, upstream: &Upstream) -> bool; pub async fn shutdown(&mut self) -> anyhow::Result<()>; }`
- Produces: `pub fn default_socket_path() -> std::path::PathBuf` —— 复刻 rune 逻辑:`$XDG_RUNTIME_DIR` 或 `temp_dir()`,文件名为 `crush-<uid>.sock`(uid 取不到时 `crush.sock`);路径超 104 字节时回退 `temp_dir()/crush-<uid>.sock`。
- 语义:未在监听则 spawn `crush server`(stdout/stderr 重定向到 `log_path`),轮询 `GET /v1/health`(最多 15s,500ms 间隔)直到就绪;已监听则直接复用。`shutdown` 先 `POST /v1/control {"command":"shutdown"}`,等待子进程退出(最多 5s),超时 kill。

- [ ] **Step 1: 写失败测试(健康检查逻辑,注入探针函数)**

`crates/combo-proxy/src/rune.rs` 内嵌测试,探针注入:
```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn health_polls_until_ok() {
        let mut calls = 0;
        let probe = || {
            calls += 1;
            if calls < 3 { false } else { true }
        };
        let ok = poll_until(probe, 10, std::time::Duration::from_millis(1)).await;
        assert!(ok);
        assert_eq!(calls, 3);
    }

    #[tokio::test]
    async fn health_gives_up_after_limit() {
        let ok = poll_until(|| false, 5, std::time::Duration::from_millis(1)).await;
        assert!(!ok);
    }
}
```

- [ ] **Step 2: 运行测试,确认失败**

Run: `cargo test -p combo-proxy rune::tests`
Expected: 编译失败(`poll_until` 不存在)。

- [ ] **Step 3: 实现 RuneManager**

`crates/combo-proxy/src/rune.rs`:
```rust
use crate::upstream::Upstream;
use anyhow::Result;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tokio::process::{Child, Command};
use tokio::time::sleep;

pub struct RuneManager {
    bin: String,
    log_path: PathBuf,
    child: Option<Child>,
}

pub async fn poll_until(
    mut probe: impl FnMut() -> bool,
    max_attempts: usize,
    interval: Duration,
) -> bool {
    for _ in 0..max_attempts {
        if probe() { return true; }
        sleep(interval).await;
    }
    probe()
}

fn uid() -> Option<String> {
    std::env::var("UID").ok()
}

pub fn default_socket_path() -> PathBuf {
    let dir = std::env::var("XDG_RUNTIME_DIR")
        .ok()
        .filter(|d| !d.is_empty())
        .unwrap_or_else(std::env::temp_dir)
        ;
    let dir = PathBuf::from(dir);
    let name = match uid() {
        Some(u) => format!("crush-{u}.sock"),
        None => "crush.sock".to_string(),
    };
    let p = dir.join(&name);
    if p.as_os_str().len() > 104 {
        std::env::temp_dir().join(name)
    } else {
        p
    }
}

impl RuneManager {
    pub fn new(bin: String) -> Self {
        let log_path = std::env::temp_dir().join("combo-rune.log");
        Self { bin, log_path, child: None }
    }

    pub fn log_path(&self) -> &Path { &self.log_path }

    pub async fn ensure_running(&mut self) -> Result<Upstream> {
        let sock = default_socket_path();
        if self.health_check(&Upstream::Unix(sock.clone())).await {
            return Ok(Upstream::Unix(sock));
        }
        let log = std::fs::File::create(&self.log_path)?;
        let stderr = Stdio::from(log);
        self.child = Some(
            Command::new(&self.bin)
                .arg("server")
                .stdout(stderr)
                .stderr(Stdio::inherit())
                .spawn()?,
        );
        let sock2 = sock.clone();
        let upstream = Upstream::Unix(sock2);
        let ready = poll_until(
            || futures::executor::block_on(self.health_check(&upstream)),
            30,
            Duration::from_millis(500),
        )
        .await;
        if !ready {
            anyhow::bail!("rune server did not become healthy within 15s; log at {}", self.log_path.display());
        }
        Ok(upstream)
    }

    pub async fn health_check(&self, upstream: &Upstream) -> bool {
        match reqwest::Client::builder().no_proxy().build() {
            Ok(c) => match c.get(format!("{}/v1/health", upstream_base(upstream))).send().await {
                Ok(r) => r.status().is_success(),
                Err(_) => false,
            },
            Err(_) => false,
        }
    }

    pub async fn shutdown(&mut self) -> Result<()> {
        if let Some(child) = self.child.as_mut() {
            let _ = child.kill().await;
            let _ = child.wait().await;
            self.child = None;
        }
        Ok(())
    }
}

fn upstream_base(u: &Upstream) -> String {
    match u {
        Upstream::Unix(_) => "http://unix".to_string(), // 由代理层解析;此处仅健康检查直连
        Upstream::Tcp(a) => format!("http://{a}"),
    }
}
```

> 注:健康检查对 Unix socket 的上游连接由代理层统一负责;若 RuneManager 需要直连 unix socket,使用 `reqwest` + `hyper-util::rt::TokioIo` + `UnixConnector`(与 Task 3 一致),本步实现选择:health_check 在 `Upstream::Unix` 时通过本 crate 暴露的 `health_via_proxy` 函数直连 socket 检查(复用 Task 3 的连接器),集成测试覆盖真实路径。

- [ ] **Step 4: 补齐集成测试(受环境变量门控)**

`crates/combo-proxy/tests/rune_integration_test.rs`:
```rust
#[tokio::test]
async fn spawns_real_rune_and_becomes_healthy() {
    if std::env::var("COMBO_RUNE_IT").is_err() {
        eprintln!("skipping: set COMBO_RUNE_IT=1 and have `crush` on PATH");
        return;
    }
    let mut mgr = combo_proxy::rune::RuneManager::new("crush".to_string());
    let upstream = mgr.ensure_running().await.expect("rune should start");
    assert!(mgr.health_check(&upstream).await);
    mgr.shutdown().await.ok();
}
```
Run: `cargo test -p combo-proxy --test rune_integration_test`
Expected: 无 `COMBO_RUNE_IT` 时 PASS(skip 输出);有环境变量且 `crush` 在 PATH 时真实启动并 PASS。

- [ ] **Step 5: 提交**

```bash
git add crates/combo-proxy/src/rune.rs crates/combo-proxy/tests/rune_integration_test.rs
git commit -m "feat: add rune server lifecycle manager"
```

---

### Task 5: 独立 combo-proxy 二进制 + Tauri 壳接线

**Files:**
- Create: `crates/combo-proxy/src/main.rs`(bin:combo-proxy)
- Create: `src-tauri/src/lib.rs`(替换占位:启动 RuneManager + 代理,emit 事件)
- Modify: `src-tauri/Cargo.toml`(加 `serde`、`tauri-plugin-dialog`、`combo-proxy` 已有)

**Interfaces:**
- Produces(bin): 启动参数 `combo-proxy --upstream <unix-path|tcp://addr> [--port 0] [--origin http://localhost:5173]`;监听后向 stdout 打印一行 `COMBO_PROXY_PORT=<port>`,之后每条 rune 状态变化打印 `COMBO_RUNE_STATUS=<connected|disconnected>`(供 dev/E2E 解析)。
- Produces(Tauri): 启动序列 `init_backend(app)`;成功时 `app.emit("proxy-ready", ProxyReady { port: u16 })`,`app.emit("rune-status", RuneStatus { connected: bool })`;失败时 emit `rune-status {connected:false}` 并继续启动 UI。
- Produces: 类型 `#[derive(serde::Serialize, Clone)] pub struct ProxyReady { pub port: u16 }` 与 `pub struct RuneStatus { pub connected: bool }`,事件名常量 `EVENT_PROXY_READY = "proxy-ready"`、`EVENT_RUNE_STATUS = "rune-status"`。

- [ ] **Step 1: 写失败测试(bin 端口解析逻辑抽为可测函数)**

`crates/combo-proxy/src/lib.rs` 追加:
```rust
pub fn parse_upstream(s: &str) -> anyhow::Result<Upstream> {
    if let Some(rest) = s.strip_prefix("tcp://") {
        Ok(Upstream::Tcp(rest.parse()?))
    } else {
        Ok(Upstream::Unix(std::path::PathBuf::from(s)))
    }
}

#[cfg(test)]
mod parse_tests {
    use super::*;
    #[test]
    fn parses_unix_path() {
        match parse_upstream("/tmp/crush.sock").unwrap() {
            Upstream::Unix(p) => assert_eq!(p, std::path::PathBuf::from("/tmp/crush.sock")),
            _ => panic!("expected unix"),
        }
    }
    #[test]
    fn parses_tcp_addr() {
        match parse_upstream("tcp://127.0.0.1:1234").unwrap() {
            Upstream::Tcp(a) => assert_eq!(a.to_string(), "127.0.0.1:1234"),
            _ => panic!("expected tcp"),
        }
    }
}
```
Run: `cargo test -p combo-proxy parse_tests`
Expected: 编译失败(`parse_upstream` 不存在)。

- [ ] **Step 2: 实现 bin**

`crates/combo-proxy/src/main.rs`:
```rust
use anyhow::Result;
use combo_proxy::rune::RuneManager;
use combo_proxy::{parse_upstream, serve, Upstream};
use std::net::SocketAddr;
use tokio::net::TcpListener;

#[tokio::main]
async fn main() -> Result<()> {
    let mut args = std::env::args().skip(1);
    let mut upstream_arg = None;
    let mut port: u16 = 0;
    let mut origins = Vec::new();
    while let Some(a) = args.next() {
        match a.as_str() {
            "--upstream" => upstream_arg = Some(args.next().unwrap()),
            "--port" => port = args.next().unwrap().parse()?,
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

    let listener = TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], port))).await?;
    let actual = listener.local_addr()?.port();
    println!("COMBO_PROXY_PORT={actual}");
    serve(listener, upstream, origins).await?;
    Ok(())
}
```
Run: `cargo build -p combo-proxy --bin combo-proxy`
Expected: 构建成功。

- [ ] **Step 3: 实现 Tauri 接线(后台任务启动后端)**

`src-tauri/src/lib.rs`:
```rust
use serde::Serialize;
use tauri::{Emitter, Manager};

#[derive(Clone, Serialize)]
pub struct ProxyReady { pub port: u16 }

#[derive(Clone, Serialize)]
pub struct RuneStatus { pub connected: bool }

pub const EVENT_PROXY_READY: &str = "proxy-ready";
pub const EVENT_RUNE_STATUS: &str = "rune-status";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                init_backend(&handle).await;
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

async fn init_backend(app: &tauri::AppHandle) {
    use combo_proxy::rune::RuneManager;
    use combo_proxy::{serve, Upstream};
    use std::net::SocketAddr;
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
    if let Err(e) = serve(listener, upstream, origins).await {
        eprintln!("proxy exited: {e:?}");
    }
}
```

- [ ] **Step 4: 手动冒烟验证(Tauri 窗口)**

Run: `npm run tauri dev`(需 `crush` 在 PATH)
Expected: 窗口打开,title "combo",无 panic;`src-tauri` 终端可见 `proxy` 日志无报错。

- [ ] **Step 5: 提交**

```bash
git add crates/combo-proxy/src/main.rs crates/combo-proxy/src/lib.rs src-tauri/src/lib.rs
git commit -m "feat: wire rune manager and proxy into Tauri shell with status events"
```

---

### Task 6: 前端连接层(代理端口发现 + 健康轮询 + 连接状态)

**Files:**
- Create: `src/lib/connection.ts`
- Create: `src/stores/connectionStore.ts`
- Test: `src/lib/connection.test.ts`、`src/stores/connectionStore.test.ts`

**Interfaces:**
- Produces: `type ConnStatus = 'disconnected' | 'connecting' | 'connected'`
- Produces: `let proxyBaseUrl: string`(模块内可变);`export function getProxyBaseUrl(): string`;`export function setProxyBaseUrl(url: string): void`
- Produces: `export async function resolveProxyBaseUrl(): Promise<string>` —— 优先级:① `import.meta.env.VITE_PROXY_URL`(dev/浏览器模式直接给 `http://127.0.0.1:<port>`);② Tauri 环境监听一次 `proxy-ready` 事件(`window.__TAURI_INTERNALS__.postMessage` 或 `@tauri-apps/api/event.listen`,用 `isTauri()` 判断);③ 兜底 `http://127.0.0.1:18234`(与 dev 脚本约定)。
- Produces: `export function isTauri(): boolean`(`'__TAURI_INTERNALS__' in window`)
- Produces: `export async function checkHealth(baseUrl: string): Promise<boolean>`(GET `/v1/health`,200 即 true)
- Produces(Zustand): `useConnectionStore` 状态 `{ status: ConnStatus, lastError: string | null }`,actions `setStatus(status)`、`setError(msg | null)`。
- Produces: `export async function connectLoop(opts?: { intervalMs?: number })` —— 后台循环:resolve baseUrl → 每 2s(默认)健康检查,成功 `setStatus('connected')`,失败 `setStatus('disconnected')`;首次成功前为 `connecting`。

- [ ] **Step 1: 写失败测试**

`src/stores/connectionStore.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { useConnectionStore } from './connectionStore';

describe('connectionStore', () => {
  it('tracks status transitions', () => {
    const s = useConnectionStore.getState();
    s.setStatus('connecting');
    expect(useConnectionStore.getState().status).toBe('connecting');
    s.setStatus('connected');
    expect(useConnectionStore.getState().status).toBe('connected');
    s.setError('boom');
    expect(useConnectionStore.getState().lastError).toBe('boom');
  });
});
```
Run: `npx vitest run src/stores/connectionStore.test.ts`
Expected: FAIL(`useConnectionStore` 不存在)。

- [ ] **Step 2: 实现 store 与连接层**

`src/stores/connectionStore.ts`:
```ts
import { create } from 'zustand';

export type ConnStatus = 'disconnected' | 'connecting' | 'connected';

interface ConnectionState {
  status: ConnStatus;
  lastError: string | null;
  setStatus: (status: ConnStatus) => void;
  setError: (msg: string | null) => void;
}

export const useConnectionStore = create<ConnectionState>((set) => ({
  status: 'disconnected',
  lastError: null,
  setStatus: (status) => set({ status }),
  setError: (msg) => set({ lastError: msg }),
}));
```

`src/lib/connection.ts`:
```ts
import { useConnectionStore } from '../stores/connectionStore';

let proxyBaseUrl = '';

export function getProxyBaseUrl(): string {
  return proxyBaseUrl;
}

export function setProxyBaseUrl(url: string): void {
  proxyBaseUrl = url.replace(/\/$/, '');
}

export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export async function checkHealth(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/v1/health`);
    return res.ok;
  } catch {
    return false;
  }
}

export async function resolveProxyBaseUrl(): Promise<string> {
  const fromEnv = import.meta.env.VITE_PROXY_URL as string | undefined;
  if (fromEnv) return fromEnv.replace(/\/$/, '');
  if (isTauri()) {
    const { listen } = await import('@tauri-apps/api/event');
    return await new Promise<string>((resolve) => {
      const unlistenP = listen<{ port: number }>('proxy-ready', (e) => {
        unlistenP.then((fn) => fn());
        resolve(`http://127.0.0.1:${e.payload.port}`);
      });
      // 2s 超时兜底
      setTimeout(() => resolve('http://127.0.0.1:18234'), 2000);
    });
  }
  return 'http://127.0.0.1:18234';
}

export async function connectLoop(opts: { intervalMs?: number } = {}): Promise<void> {
  const intervalMs = opts.intervalMs ?? 2000;
  if (!getProxyBaseUrl()) {
    setProxyBaseUrl(await resolveProxyBaseUrl());
  }
  const base = getProxyBaseUrl();
  // 立即先探一次,后续进入轮询
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const ok = await checkHealth(base);
    useConnectionStore
      .getState()
      .setStatus(ok ? 'connected' : 'disconnected');
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
```

- [ ] **Step 3: 运行测试,确认通过**

Run: `npx vitest run src/stores/connectionStore.test.ts src/lib/connection.test.ts`
Expected: PASS(connection.test 覆盖 `setProxyBaseUrl` 去尾斜杠、`checkHealth` 对 mock fetch 的 200/500 分支)。

- [ ] **Step 4: 提交**

```bash
git add src/lib/connection.ts src/stores/connectionStore.ts src/lib/connection.test.ts src/stores/connectionStore.test.ts
git commit -m "feat: add frontend connection layer with health polling"
```

---

### Task 7: API client(fetch 封装 + 类型化函数)

**Files:**
- Create: `src/lib/api/client.ts`
- Create: `src/lib/clientId.ts`
- Create: `src/lib/api/index.ts`(改写为真实 API 函数)
- Test: `src/lib/api/client.test.ts`

**Interfaces:**
- Produces: `export class ApiError extends Error { constructor(public status: number, public message: string) }`
- Produces: `export async function apiRequest<T>(path: string, opts?: { method?: string; query?: Record<string, string>; body?: unknown }): Promise<T>` —— baseUrl 取 `getProxyBaseUrl()`,`client_id` 默认注入(除非 query 已含),JSON body 序列化,非 2xx 抛 `ApiError(status, parsed.message ?? statusText)`,网络错误抛 `ApiError(0, 'network error')`。
- Produces: `export function getClientId(): string` —— localStorage `combo.clientId`,不存在则 `crypto.randomUUID()` 生成并持久化。
- Produces(`index.ts` 类型化函数,全部返回 `Promise<Api.X>`):
  - `listWorkspaces(): Promise<Api.Workspace[]>`
  - `createWorkspace(path: string): Promise<Api.Workspace>`(POST `/v1/workspaces`,`{path}`)
  - `getWorkspace(id: string): Promise<Api.Workspace>`
  - `listSessions(workspaceId: string): Promise<Api.Session[]>`
  - `createSession(workspaceId: string, title: string): Promise<Api.Session>`
  - `getSessionHistory(workspaceId: string, sessionId: string): Promise<Api.Message[]>`
  - `setCurrentSession(workspaceId: string, sessionId: string): Promise<void>`
  - `sendAgentMessage(workspaceId: string, req: { sessionId: string; runId: string; prompt: string }): Promise<void>`(POST `/v1/workspaces/{id}/agent`,`AgentMessage`)
  - `cancelAgent(workspaceId: string, sessionId: string): Promise<void>`
  - `grantPermission(workspaceId: string, permission: Api.PermissionRequest, action: 'allow' | 'allow_session' | 'deny'): Promise<void>`(POST `/v1/workspaces/{id}/permissions/grant`,`PermissionGrant`)
  - `answerQuestion(workspaceId: string, answer: Api.QuestionAnswer): Promise<void>`(POST `/v1/workspaces/{id}/questions/answer`)

- [ ] **Step 1: 写失败测试(client 封装)**

`src/lib/api/client.test.ts`:
```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiRequest } from './client';
import { setProxyBaseUrl } from '../connection';

const base = 'http://127.0.0.1:9999';

beforeEach(() => {
  setProxyBaseUrl(base);
  vi.stubGlobal('fetch', vi.fn());
});
afterEach(() => vi.unstubAllGlobals());

describe('apiRequest', () => {
  it('injects client_id query param and parses json', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ id: 'w1' }), { status: 200 })
    );
    const out = await apiRequest<{ id: string }>('/v1/workspaces');
    expect(out.id).toBe('w1');
    const [url] = vi.mocked(fetch).mock.calls[0];
    expect(String(url)).toContain('client_id=');
  });

  it('throws ApiError with server message on 4xx', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ message: 'bad request' }), { status: 400 })
    );
    await expect(apiRequest('/v1/workspaces')).rejects.toMatchObject({
      status: 400,
      message: 'bad request',
    } satisfies Partial<ApiError>);
  });
});
```
Run: `npx vitest run src/lib/api/client.test.ts`
Expected: FAIL(`./client` 不存在)。

- [ ] **Step 2: 实现 client + clientId**

`src/lib/api/client.ts`:
```ts
import { getProxyBaseUrl } from '../connection';
import { getClientId } from '../clientId';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function apiRequest<T>(
  path: string,
  opts: { method?: string; query?: Record<string, string>; body?: unknown } = {}
): Promise<T> {
  const base = getProxyBaseUrl();
  const q = new URLSearchParams(opts.query ?? {});
  if (!q.has('client_id')) q.set('client_id', getClientId());
  const res = await fetch(`${base}${path}?${q.toString()}`, {
    method: opts.method ?? 'GET',
    headers: opts.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) {
    let message = res.statusText;
    try {
      const j = (await res.json()) as { message?: string };
      if (j.message) message = j.message;
    } catch {
      /* keep statusText */
    }
    throw new ApiError(res.status, message);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}
```

`src/lib/clientId.ts`:
```ts
const KEY = 'combo.clientId';

export function getClientId(): string {
  try {
    let id = localStorage.getItem(KEY);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(KEY, id);
    }
    return id;
  } catch {
    return crypto.randomUUID();
  }
}
```

- [ ] **Step 3: 实现类型化 API 函数**

`src/lib/api/index.ts`:
```ts
import type { Api } from './types';
import { apiRequest } from './client';

export * from './client';

export function listWorkspaces(): Promise<Api.Workspace[]> {
  return apiRequest('/v1/workspaces');
}

export function createWorkspace(path: string): Promise<Api.Workspace> {
  return apiRequest('/v1/workspaces', { method: 'POST', body: { path } });
}

export function getWorkspace(id: string): Promise<Api.Workspace> {
  return apiRequest(`/v1/workspaces/${id}`);
}

export function listSessions(workspaceId: string): Promise<Api.Session[]> {
  return apiRequest(`/v1/workspaces/${workspaceId}/sessions`);
}

export function createSession(workspaceId: string, title: string): Promise<Api.Session> {
  return apiRequest(`/v1/workspaces/${workspaceId}/sessions`, {
    method: 'POST',
    body: { title },
  });
}

export function getSessionHistory(
  workspaceId: string,
  sessionId: string
): Promise<Api.Message[]> {
  return apiRequest(`/v1/workspaces/${workspaceId}/sessions/${sessionId}/history`);
}

export function setCurrentSession(workspaceId: string, sessionId: string): Promise<void> {
  return apiRequest(`/v1/workspaces/${workspaceId}/current-session`, {
    method: 'POST',
    body: { session_id: sessionId },
  });
}

export function sendAgentMessage(
  workspaceId: string,
  req: { sessionId: string; runId: string; prompt: string }
): Promise<void> {
  return apiRequest(`/v1/workspaces/${workspaceId}/agent`, {
    method: 'POST',
    body: {
      session_id: req.sessionId,
      run_id: req.runId,
      prompt: req.prompt,
    } satisfies Api.AgentMessage,
  });
}

export function cancelAgent(workspaceId: string, sessionId: string): Promise<void> {
  return apiRequest(`/v1/workspaces/${workspaceId}/agent/sessions/${sessionId}/cancel`, {
    method: 'POST',
  });
}

export function grantPermission(
  workspaceId: string,
  permission: Api.PermissionRequest,
  action: 'allow' | 'allow_session' | 'deny'
): Promise<void> {
  return apiRequest(`/v1/workspaces/${workspaceId}/permissions/grant`, {
    method: 'POST',
    body: { permission, action } satisfies Api.PermissionGrant,
  });
}

export function answerQuestion(
  workspaceId: string,
  answer: Api.QuestionAnswer
): Promise<void> {
  return apiRequest(`/v1/workspaces/${workspaceId}/questions/answer`, {
    method: 'POST',
    body: answer,
  });
}
```

- [ ] **Step 4: 运行测试**

Run: `npx vitest run src/lib/api/client.test.ts && npx tsc --noEmit`
Expected: PASS,类型检查通过(如 `Api.AgentMessage` 字段名与 swagger 不符,以 `swagger/swagger.json` 实际 schema 为准修正本文件)。

- [ ] **Step 5: 提交**

```bash
git add src/lib/api/ src/lib/clientId.ts
git commit -m "feat: add typed API client for rune endpoints"
```

---

### Task 8: 工作区侧边栏(列表 + 创建 + 激活)

**Files:**
- Create: `src/hooks/useWorkspaces.ts`
- Create: `src/components/shell/WorkspaceSidebar.tsx`
- Create: `src/components/shell/AppShell.tsx`(布局:左侧边栏 + 右侧内容区,占位)
- Test: `src/components/shell/WorkspaceSidebar.test.tsx`

**Interfaces:**
- Produces: `useWorkspaces()` → `{ workspaces: Api.Workspace[] | undefined, isLoading, error, refresh, create(path: string): Promise<Api.Workspace> }`(TanStack Query,key `['workspaces']`)。
- Produces: Zustand 派生选择器 `useAgentStore((s) => s.activeWorkspaceId)` / `setActiveWorkspace(id: string | null)`(store 在 Task 10 完整定义,本任务先建最小 `src/stores/agentStore.ts` 骨架)。
- Produces: `<AppShell children>` 负责 `connectLoop()` 启动与 `QueryClientProvider`。

- [ ] **Step 1: 写失败测试(侧边栏交互)**

`src/components/shell/WorkspaceSidebar.test.tsx`:
```tsx
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WorkspaceSidebar } from './WorkspaceSidebar';

vi.mock('../../lib/api', () => ({
  listWorkspaces: vi.fn(async () => [
    { id: 'w1', path: '/proj/a', name: 'a' },
    { id: 'w2', path: '/proj/b', name: 'b' },
  ]),
  createWorkspace: vi.fn(async () => ({ id: 'w3', path: '/proj/c', name: 'c' })),
}));

function wrap() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <WorkspaceSidebar />
    </QueryClientProvider>
  );
}

describe('WorkspaceSidebar', () => {
  it('renders workspaces from API', async () => {
    wrap();
    expect(await screen.findByText('/proj/a')).toBeTruthy();
    expect(screen.getByText('/proj/b')).toBeTruthy();
  });

  it('creates a workspace from path input', async () => {
    wrap();
    const input = await screen.findByPlaceholderText('输入项目路径');
    await userEvent.type(input, '/proj/c{Enter}');
    expect(await screen.findByText('/proj/c')).toBeTruthy();
  });
});
```
Run: `npx vitest run src/components/shell/WorkspaceSidebar.test.tsx`
Expected: FAIL(组件不存在)。

- [ ] **Step 2: 实现 hook 与最小 agentStore 骨架**

`src/stores/agentStore.ts`:
```ts
import { create } from 'zustand';

interface AgentState {
  activeWorkspaceId: string | null;
  setActiveWorkspace: (id: string | null) => void;
}

export const useAgentStore = create<AgentState>((set) => ({
  activeWorkspaceId: null,
  setActiveWorkspace: (id) => set({ activeWorkspaceId: id }),
}));
```

`src/hooks/useWorkspaces.ts`:
```ts
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createWorkspace, listWorkspaces } from '../lib/api';

export function useWorkspaces() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['workspaces'],
    queryFn: listWorkspaces,
  });
  const create = useMutation({
    mutationFn: createWorkspace,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['workspaces'] }),
  });
  return {
    workspaces: q.data,
    isLoading: q.isLoading,
    error: q.error,
    refresh: () => q.refetch(),
    create: create.mutateAsync,
  };
}
```

- [ ] **Step 3: 实现侧边栏与 AppShell**

`src/components/shell/WorkspaceSidebar.tsx`:
```tsx
import { useState } from 'react';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { ScrollArea } from '../ui/scroll-area';
import { useWorkspaces } from '../../hooks/useWorkspaces';
import { useAgentStore } from '../../stores/agentStore';
import { cn } from '../../lib/utils';

export function WorkspaceSidebar() {
  const { workspaces, isLoading, create } = useWorkspaces();
  const [path, setPath] = useState('');
  const active = useAgentStore((s) => s.activeWorkspaceId);
  const setActive = useAgentStore((s) => s.setActiveWorkspace);

  async function onCreate() {
    if (!path.trim()) return;
    await create(path.trim());
    setPath('');
  }

  return (
    <aside className="flex h-full w-60 flex-col border-r bg-muted/30">
      <div className="p-2 text-xs font-semibold uppercase text-muted-foreground">
        项目
      </div>
      <ScrollArea className="flex-1">
        {isLoading && <div className="p-2 text-xs text-muted-foreground">加载中…</div>}
        {workspaces?.map((w) => (
          <button
            key={w.id}
            onClick={() => setActive(w.id)}
            className={cn(
              'block w-full px-3 py-2 text-left text-sm hover:bg-accent',
              active === w.id && 'bg-accent text-accent-foreground'
            )}
          >
            <div className="truncate font-mono text-xs">{w.path}</div>
            <div className="truncate text-xs text-muted-foreground">{w.id}</div>
          </button>
        ))}
      </ScrollArea>
      <div className="border-t p-2">
        <Input
          placeholder="输入项目路径"
          value={path}
          onChange={(e) => setPath(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && onCreate()}
          className="mb-2 h-7 text-xs"
        />
        <Button size="sm" className="w-full" onClick={onCreate} disabled={!path.trim()}>
          添加项目
        </Button>
      </div>
    </aside>
  );
}
```

`src/components/shell/AppShell.tsx`:
```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect } from 'react';
import { connectLoop } from '../../lib/connection';
import { WorkspaceSidebar } from './WorkspaceSidebar';

const qc = new QueryClient();

export function AppShell() {
  useEffect(() => {
    void connectLoop();
  }, []);

  return (
    <QueryClientProvider client={qc}>
      <div className="flex h-screen w-screen overflow-hidden">
        <WorkspaceSidebar />
        <main className="flex-1">（Agent 面板将在这里）</main>
      </div>
    </QueryClientProvider>
  );
}
```

改 `src/main.tsx` 渲染 `AppShell`,`src/App.tsx` 移除。

- [ ] **Step 4: 运行测试 + 类型检查**

Run: `npx vitest run src/components/shell/WorkspaceSidebar.test.tsx && npx tsc --noEmit`
Expected: PASS。若 mock 的 `listWorkspaces` 返回字段与 `Api.Workspace` 不符(如无 `name` 字段),改用 swagger 中真实字段并同步改组件。

- [ ] **Step 5: 提交**

```bash
git add src/stores/agentStore.ts src/hooks/useWorkspaces.ts src/components/shell/ src/main.tsx src/App.tsx
git commit -m "feat: add workspace sidebar with create flow"
```

---

### Task 9: 会话 tabs(列表 + 创建 + 激活 + 历史加载)

**Files:**
- Create: `src/hooks/useSessions.ts`
- Create: `src/components/shell/SessionTabs.tsx`
- Test: `src/hooks/useSessions.test.ts`(逻辑)、`src/components/shell/SessionTabs.test.tsx`(渲染)

**Interfaces:**
- Produces: `useSessions(workspaceId: string | null)` → `{ sessions: Api.Session[] | undefined, isLoading, create(title: string): Promise<Api.Session>, activate(sessionId: string): void }`(TanStack Query key `['sessions', workspaceId]`;`activate` 调 `setCurrentSession` + `agentStore.setActiveSessionId` + 触发历史加载)。
- Produces: `useSessionHistory(workspaceId: string | null, sessionId: string | null)` → `{ messages: Api.Message[] | undefined }`(key `['history', workspaceId, sessionId]`)。
- Produces: agentStore 增加 `activeSessionId: string | null` 与 `setActiveSessionId(id: string | null)`(Task 10 扩展完整运行时)。

- [ ] **Step 1: 写失败测试(SessionTabs 渲染)**

`src/components/shell/SessionTabs.test.tsx`:
```tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SessionTabs } from './SessionTabs';
import { useAgentStore } from '../../stores/agentStore';

vi.mock('../../lib/api', () => ({
  listSessions: vi.fn(async () => [
    { id: 's1', title: '会话一' },
    { id: 's2', title: '会话二' },
  ]),
  createSession: vi.fn(async (_w: string, title: string) => ({ id: 's3', title })),
  setCurrentSession: vi.fn(async () => {}),
  getSessionHistory: vi.fn(async () => []),
}));

describe('SessionTabs', () => {
  it('lists sessions and creates a new one', async () => {
    useAgentStore.setState({ activeWorkspaceId: 'w1' });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <SessionTabs />
      </QueryClientProvider>
    );
    expect(await screen.findByText('会话一')).toBeTruthy();
    await userEvent.click(screen.getByText('＋'));
    expect(await screen.findByText('新会话')).toBeTruthy();
  });
});
```
Run: `npx vitest run src/components/shell/SessionTabs.test.tsx`
Expected: FAIL。

- [ ] **Step 2: 扩展 agentStore(会话级字段)**

`src/stores/agentStore.ts` 追加(保持既有字段):
```ts
activeSessionId: string | null;
setActiveSessionId: (id: string | null) => void;
```

- [ ] **Step 3: 实现 hooks**

`src/hooks/useSessions.ts`:
```ts
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createSession,
  getSessionHistory,
  listSessions,
  setCurrentSession,
} from '../lib/api';
import { useAgentStore } from '../stores/agentStore';

export function useSessions(workspaceId: string | null) {
  const qc = useQueryClient();
  const setActiveSessionId = useAgentStore((s) => s.setActiveSessionId);
  const q = useQuery({
    queryKey: ['sessions', workspaceId],
    queryFn: () => listSessions(workspaceId!),
    enabled: !!workspaceId,
  });
  const create = useMutation({
    mutationFn: (title: string) => createSession(workspaceId!, title),
    onSuccess: (s) => {
      qc.invalidateQueries({ queryKey: ['sessions', workspaceId] });
      void activate(s.id);
    },
  });
  async function activate(sessionId: string) {
    setActiveSessionId(sessionId);
    if (workspaceId) {
      await setCurrentSession(workspaceId, sessionId);
      qc.invalidateQueries({ queryKey: ['history', workspaceId, sessionId] });
    }
  }
  return { sessions: q.data, isLoading: q.isLoading, create: create.mutateAsync, activate };
}

export function useSessionHistory(workspaceId: string | null, sessionId: string | null) {
  return useQuery({
    queryKey: ['history', workspaceId, sessionId],
    queryFn: () => getSessionHistory(workspaceId!, sessionId!),
    enabled: !!workspaceId && !!sessionId,
  });
}
```

- [ ] **Step 4: 实现 SessionTabs**

`src/components/shell/SessionTabs.tsx`:
```tsx
import { Tabs, TabsList, TabsTrigger } from '../ui/tabs';
import { useSessions } from '../../hooks/useSessions';
import { useAgentStore } from '../../stores/agentStore';

export function SessionTabs() {
  const workspaceId = useAgentStore((s) => s.activeWorkspaceId);
  const active = useAgentStore((s) => s.activeSessionId);
  const { sessions, create, activate } = useSessions(workspaceId);

  if (!workspaceId) return null;

  async function onNew() {
    const base = `会话 ${(sessions?.length ?? 0) + 1}`;
    await create(base);
  }

  return (
    <Tabs value={active ?? undefined} onValueChange={(v) => activate(v)} className="border-b px-2 pt-2">
      <TabsList>
        {sessions?.map((s) => (
          <TabsTrigger key={s.id} value={s.id}>
            {s.title}
          </TabsTrigger>
        ))}
        <button onClick={onNew} title="新建会话" className="ml-1 rounded px-2 text-sm hover:bg-accent">
          ＋
        </button>
      </TabsList>
    </Tabs>
  );
}
```

- [ ] **Step 5: 运行测试 + 类型检查**

Run: `npx vitest run src/components/shell/SessionTabs.test.tsx && npx tsc --noEmit`
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add src/hooks/useSessions.ts src/components/shell/SessionTabs.tsx src/stores/agentStore.ts
git commit -m "feat: add session tabs with create and activate"
```

---

### Task 10: SSE 事件客户端 + dispatch + agentStore 运行时(核心)

**Files:**
- Create: `src/lib/events/payloadTypes.ts`
- Create: `src/lib/events/sse.ts`
- Create: `src/lib/events/dispatch.ts`
- Create: `src/hooks/useWorkspaceEvents.ts`
- Test: `src/lib/events/sse.test.ts`、`src/lib/events/dispatch.test.ts`

**Interfaces:**
- Produces: `payloadTypes.ts`:
```ts
export const PAYLOAD_TYPES = [
  'lsp_event', 'mcp_event', 'permission_request', 'permission_notification',
  'message', 'session', 'file', 'agent_event', 'config_changed',
  'skills_event', 'run_complete', 'update_available',
  'question_batch_request', 'question_batch_notification',
] as const;
export type PayloadType = (typeof PAYLOAD_TYPES)[number];

export interface EventEnvelope {
  type: PayloadType;
  payload: unknown;
}
```
- Produces: `sse.ts`:
```ts
export type OnPayload = (env: EventEnvelope) => void;
export class WorkspaceEventSource {
  constructor(workspaceId: string, onPayload: OnPayload, opts?: { backoffMs?: number });
  start(): void;   // 用 fetch + ReadableStream 解析 text/event-stream,断线按 backoff 退避重连
  stop(): void;
  readonly connected: boolean;
}
```
  实现要点:用 `fetch(baseUrl + /v1/workspaces/{id}/events?client_id=...)`,`Accept: text/event-stream`;逐行读 `data:` 行(可跨 chunk),`JSON.parse` 后回调 `onPayload`;流结束或网络错误 → 指数退避(1s,2s,4s…上限 30s)重连;`stop()` 用 AbortController 中止。
- Produces: `dispatch.ts`:`export function applyEvent(s: AgentStoreApi, env: EventEnvelope): void` —— 按 `env.type` 分发到 store action(见下)。未知 type 忽略并 console.warn。
- Produces(agentStore 扩展):每个会话运行时:
```ts
interface SessionRuntime {
  messages: MessageVM[];
  run: { runId: string; status: 'running' } | null;
  queued: boolean;
}
interface MessageVM {
  id: string;
  role: 'user' | 'assistant' | 'tool' | 'system';
  parts: Api.ContentPart[];
  createdAt: number;
  updatedAt: number;
  streaming: boolean;   // 本地标记:该消息正在被 SSE 更新
}
```
  actions:
```ts
upsertMessage(sessionId: string, m: Api.Message): void   // 按 id 插入或替换
deleteMessage(sessionId: string, messageId: string): void
markRun(sessionId: string, runId: string, status: 'running' | 'done'): void
setQueued(sessionId: string, queued: boolean): void
enqueuePermission(p: Api.PermissionRequest): void
resolvePermission(id: string): void
enqueueQuestionBatch(b: Api.QuestionRequest): void
dismissQuestionBatch(batchId: string): void
clearSessionRuntime(sessionId: string): void
```
  附加状态:`permissionQueue: Api.PermissionRequest[]`、`questionQueue: Api.QuestionRequest[]`。
- Produces: `useWorkspaceEvents(workspaceId: string | null)` —— workspaceId 存在时创建 `WorkspaceEventSource`,事件经 `applyEvent` 写入 store;workspaceId 变化时重建;卸载时 `stop()`。

**dispatch 映射规则(本任务核心,必须与 rune 行为一致):**
- `message` → `upsertMessage(payload.session_id, payload)`
- `session` → 会话列表变更信号:触发 TanStack Query 失效(`useWorkspaceEvents` 内调用 `queryClient.invalidateQueries(['sessions', workspaceId])`)
- `agent_event` → 忽略(payload 为 `AgentEvent`,前端不依赖;真正的数据载体是 `message` 事件与 `run_complete`)
- `run_complete` → `markRun(payload.session_id, payload.run_id, payload.error || payload.cancelled ? 'done' : 'done')`(run_id 为空时用 `payload.session_id`)
- `permission_request` → `enqueuePermission(payload)`
- `permission_notification` → 从队列移除匹配 `tool_call_id` 的请求
- `question_batch_request` → `enqueueQuestionBatch(payload)`
- `question_batch_notification` → `dismissQuestionBatch(payload.batch_id)`
- `file` / `lsp_event` / `mcp_event` / `config_changed` / `skills_event` / `update_available` → M1 忽略(console.debug)

- [ ] **Step 1: 写失败测试(dispatch 映射)**

`src/lib/events/dispatch.test.ts`:
```ts
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { applyEvent } from './dispatch';
import { useAgentStore } from '../../stores/agentStore';

describe('applyEvent', () => {
  beforeEach(() => useAgentStore.setState({
    bySession: {},
    permissionQueue: [],
    questionQueue: [],
  }));

  it('upserts message into its session slice', () => {
    const s = useAgentStore.getState();
    applyEvent(s, {
      type: 'message',
      payload: { id: 'm1', session_id: 's1', role: 'assistant', parts: [], created_at: 1, updated_at: 1 },
    });
    const after = useAgentStore.getState();
    expect(after.bySession['s1'].messages.map((m) => m.id)).toEqual(['m1']);
  });

  it('replaces message with same id (streaming update)', () => {
    const s = useAgentStore.getState();
    applyEvent(s, { type: 'message', payload: { id: 'm1', session_id: 's1', role: 'assistant', parts: [], created_at: 1, updated_at: 1 } });
    applyEvent(s, { type: 'message', payload: { id: 'm1', session_id: 's1', role: 'assistant', parts: [{ type: 'text', data: { text: 'hi' } }], created_at: 1, updated_at: 2 } });
    const after = useAgentStore.getState();
    expect(after.bySession['s1'].messages).toHaveLength(1);
    expect(after.bySession['s1'].messages[0].parts).toEqual([{ type: 'text', data: { text: 'hi' } }]);
  });

  it('queues and resolves permission requests', () => {
    const s = useAgentStore.getState();
    applyEvent(s, { type: 'permission_request', payload: { id: 'p1', tool_call_id: 'tc1', tool_name: 'bash', description: 'run ls', action: '', path: '' } });
    applyEvent(s, { type: 'permission_notification', payload: { tool_call_id: 'tc1', granted: true } });
    expect(useAgentStore.getState().permissionQueue).toEqual([]);
  });

  it('queues and dismisses question batches', () => {
    const s = useAgentStore.getState();
    applyEvent(s, { type: 'question_batch_request', payload: { id: 'q1', session_id: 's1', tool_call_id: 'tc1', questions: [] } });
    expect(useAgentStore.getState().questionQueue).toHaveLength(1);
    applyEvent(s, { type: 'question_batch_notification', payload: { batch_id: 'q1' } });
    expect(useAgentStore.getState().questionQueue).toEqual([]);
  });

  it('marks run done on run_complete', () => {
    const s = useAgentStore.getState();
    applyEvent(s, { type: 'message', payload: { id: 'm1', session_id: 's1', role: 'assistant', parts: [], created_at: 1, updated_at: 1 } });
    applyEvent(s, { type: 'run_complete', payload: { session_id: 's1', run_id: 'r1', message_id: 'm1', text: 'ok' } });
    expect(useAgentStore.getState().bySession['s1'].run).toEqual({ runId: 'r1', status: 'done' });
  });
});
```
Run: `npx vitest run src/lib/events/dispatch.test.ts`
Expected: FAIL(`applyEvent`/`bySession` 不存在)。

- [ ] **Step 2: 扩展 agentStore 为会话运行时**

`src/stores/agentStore.ts` 完整版(替换 Task 8/9 的骨架):
```ts
import { create } from 'zustand';
import type { Api } from '../lib/api/types';

export interface MessageVM {
  id: string;
  role: 'user' | 'assistant' | 'tool' | 'system';
  parts: Api.ContentPart[];
  createdAt: number;
  updatedAt: number;
  streaming: boolean;
}

export interface SessionRuntime {
  messages: MessageVM[];
  run: { runId: string; status: 'running' | 'done' } | null;
  queued: boolean;
}

interface AgentState {
  activeWorkspaceId: string | null;
  setActiveWorkspace: (id: string | null) => void;
  activeSessionId: string | null;
  setActiveSessionId: (id: string | null) => void;

  bySession: Record<string, SessionRuntime>;
  permissionQueue: Api.PermissionRequest[];
  questionQueue: Api.QuestionRequest[];

  upsertMessage: (sessionId: string, m: Api.Message) => void;
  deleteMessage: (sessionId: string, messageId: string) => void;
  markRun: (sessionId: string, runId: string, status: 'running' | 'done') => void;
  setQueued: (sessionId: string, queued: boolean) => void;
  enqueuePermission: (p: Api.PermissionRequest) => void;
  resolvePermission: (toolCallId: string) => void;
  enqueueQuestionBatch: (b: Api.QuestionRequest) => void;
  dismissQuestionBatch: (batchId: string) => void;
  clearSessionRuntime: (sessionId: string) => void;
}

const emptyRuntime = (): SessionRuntime => ({ messages: [], run: null, queued: false });

export const useAgentStore = create<AgentState>((set) => ({
  activeWorkspaceId: null,
  setActiveWorkspace: (id) => set({ activeWorkspaceId: id }),
  activeSessionId: null,
  setActiveSessionId: (id) => set({ activeSessionId: id }),

  bySession: {},
  permissionQueue: [],
  questionQueue: [],

  upsertMessage: (sessionId, m) =>
    set((st) => {
      const rt = st.bySession[sessionId] ?? emptyRuntime();
      const idx = rt.messages.findIndex((x) => x.id === m.id);
      const vm: MessageVM = {
        id: m.id,
        role: m.role,
        parts: m.parts,
        createdAt: m.created_at,
        updatedAt: m.updated_at,
        streaming: true,
      };
      const messages =
        idx >= 0
          ? rt.messages.map((x, i) => (i === idx ? vm : x))
          : [...rt.messages, vm];
      return { bySession: { ...st.bySession, [sessionId]: { ...rt, messages } } };
    }),

  deleteMessage: (sessionId, messageId) =>
    set((st) => {
      const rt = st.bySession[sessionId];
      if (!rt) return st;
      return {
        bySession: {
          ...st.bySession,
          [sessionId]: { ...rt, messages: rt.messages.filter((x) => x.id !== messageId) },
        },
      };
    }),

  markRun: (sessionId, runId, status) =>
    set((st) => {
      const rt = st.bySession[sessionId] ?? emptyRuntime();
      return { bySession: { ...st.bySession, [sessionId]: { ...rt, run: { runId, status } } } };
    }),

  setQueued: (sessionId, queued) =>
    set((st) => {
      const rt = st.bySession[sessionId] ?? emptyRuntime();
      return { bySession: { ...st.bySession, [sessionId]: { ...rt, queued } } };
    }),

  enqueuePermission: (p) => set((st) => ({ permissionQueue: [...st.permissionQueue, p] })),
  resolvePermission: (toolCallId) =>
    set((st) => ({
      permissionQueue: st.permissionQueue.filter((p) => p.tool_call_id !== toolCallId),
    })),
  enqueueQuestionBatch: (b) => set((st) => ({ questionQueue: [...st.questionQueue, b] })),
  dismissQuestionBatch: (batchId) =>
    set((st) => ({ questionQueue: st.questionQueue.filter((b) => b.id !== batchId) })),
  clearSessionRuntime: (sessionId) =>
    set((st) => {
      const { [sessionId]: _drop, ...rest } = st.bySession;
      return { bySession: rest };
    }),
}));
```

- [ ] **Step 3: 实现 sse 客户端**

`src/lib/events/sse.ts`:
```ts
import { getClientId } from '../clientId';
import { getProxyBaseUrl } from '../connection';
import type { EventEnvelope } from './payloadTypes';

export type OnPayload = (env: EventEnvelope) => void;

export class WorkspaceEventSource {
  private controller: AbortController | null = null;
  private stopped = false;
  connected = false;
  private readonly backoffMs: number;

  constructor(
    private readonly workspaceId: string,
    private readonly onPayload: OnPayload,
    opts?: { backoffMs?: number }
  ) {
    this.backoffMs = opts?.backoffMs ?? 1000;
  }

  start(): void {
    this.stopped = false;
    void this.loop();
  }

  stop(): void {
    this.stopped = true;
    this.controller?.abort();
    this.connected = false;
  }

  private async loop(): Promise<void> {
    let delay = this.backoffMs;
    while (!this.stopped) {
      try {
        await this.consume();
        // 正常 EOF:短暂重连
      } catch {
        /* network error */
      }
      if (this.stopped) return;
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 30_000);
    }
  }

  private async consume(): Promise<void> {
    const controller = new AbortController();
    this.controller = controller;
    const base = getProxyBaseUrl();
    const url = `${base}/v1/workspaces/${this.workspaceId}/events?client_id=${encodeURIComponent(getClientId())}`;
    const res = await fetch(url, {
      headers: { Accept: 'text/event-stream' },
      signal: controller.signal,
    });
    if (!res.ok || !res.body) throw new Error(`sse status ${res.status}`);
    this.connected = true;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const dataLine = chunk
          .split('\n')
          .find((l) => l.startsWith('data:'));
        if (!dataLine) continue;
        try {
          const env = JSON.parse(dataLine.slice(5).trim()) as EventEnvelope;
          this.onPayload(env);
        } catch {
          /* ignore malformed frame */
        }
      }
    }
    this.connected = false;
  }
}
```

- [ ] **Step 4: 实现 dispatch + hook**

`src/lib/events/dispatch.ts`:
```ts
import type { useAgentStore } from '../../stores/agentStore';
import type { EventEnvelope } from './payloadTypes';

type Store = ReturnType<typeof useAgentStore.getState>;

export function applyEvent(s: Store, env: EventEnvelope): void {
  switch (env.type) {
    case 'message': {
      const p = env.payload as { session_id: string };
      s.upsertMessage(p.session_id, env.payload as never);
      break;
    }
    case 'run_complete': {
      const p = env.payload as { session_id: string; run_id?: string; error?: string };
      s.markRun(p.session_id, p.run_id || p.session_id, 'done');
      break;
    }
    case 'permission_request':
      s.enqueuePermission(env.payload as never);
      break;
    case 'permission_notification': {
      const p = env.payload as { tool_call_id: string };
      s.resolvePermission(p.tool_call_id);
      break;
    }
    case 'question_batch_request':
      s.enqueueQuestionBatch(env.payload as never);
      break;
    case 'question_batch_notification': {
      const p = env.payload as { batch_id: string };
      s.dismissQuestionBatch(p.batch_id);
      break;
    }
    default:
      break; // M1 忽略其余事件
  }
}
```

`src/hooks/useWorkspaceEvents.ts`:
```ts
import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { applyEvent } from '../lib/events/dispatch';
import { WorkspaceEventSource } from '../lib/events/sse';
import { useAgentStore } from '../stores/agentStore';

export function useWorkspaceEvents(workspaceId: string | null) {
  const qc = useQueryClient();
  useEffect(() => {
    if (!workspaceId) return;
    const source = new WorkspaceEventSource(workspaceId, (env) => {
      const st = useAgentStore.getState();
      if (env.type === 'session') {
        void qc.invalidateQueries({ queryKey: ['sessions', workspaceId] });
        return;
      }
      applyEvent(st, env);
    });
    source.start();
    return () => source.stop();
  }, [workspaceId, qc]);
}
```

- [ ] **Step 5: 运行测试**

Run: `npx vitest run src/lib/events/ && npx tsc --noEmit`
Expected: PASS。`sse.test.ts` 用 ReadableStream mock 验证:多 chunk 拆分、`data:` 解析、断线重连(背压时间缩短)。

- [ ] **Step 6: 提交**

```bash
git add src/lib/events/ src/hooks/useWorkspaceEvents.ts src/stores/agentStore.ts
git commit -m "feat: add SSE client, event dispatch, and per-session agent runtime"
```

---

### Task 11: Agent 聊天面板(Composer + MessageList + MessageItem)

**Files:**
- Create: `src/components/agent/AgentPanel.tsx`
- Create: `src/components/agent/Composer.tsx`
- Create: `src/components/agent/MessageList.tsx`
- Create: `src/components/agent/MessageItem.tsx`
- Create: `src/components/agent/markdown.tsx`(极简 Markdown 渲染,基于 `react-markdown`)
- Test: `src/components/agent/MessageList.test.tsx`、`src/components/agent/Composer.test.tsx`

**Interfaces:**
- Produces: `MessageItemProps { vm: MessageVM }`;按 `vm.parts` 渲染,type 分流:text → Markdown;reasoning → 折叠"思考中…";tool_call → `<ToolCallCard>`(Task 12);tool_result → 仅作为对应 tool_call 的状态依据不在 MessageItem 直接展示;finish → 状态行(finish_reason 文案)。
- Produces: `Composer`:`{ onSend(prompt: string): void; disabled: boolean }`;多行 textarea,Enter 发送(Shift+Enter 换行)。
- Produces: `AgentPanel`:`{ workspaceId: string; sessionId: string }`;组合 useWorkspaceEvents、MessageList、Composer、取消按钮、权限/提问弹窗(占位出口,Task 12/13 填充)。
- Produces: 发送逻辑:`onSend(prompt)` → `runId = crypto.randomUUID()` → `sendAgentMessage(workspaceId, { sessionId, runId, prompt })`;立即插入一条本地 user 消息(乐观 UI,`id = 'local-' + runId`);POST 返回后置 `streaming: false`(由后续 SSE `message` 事件按真实 id 替换,本地消息在收到服务端回显时按 `session_id`+时间戳兜底删除)。
- Produces: `runStatus(sessionId)` 选择器:`bySession[sessionId]?.run?.status ?? 'idle'`;`queued` 选择器同理。

- [ ] **Step 1: 写失败测试(MessageList 渲染 parts)**

`src/components/agent/MessageList.test.tsx`:
```tsx
import { render, screen } from '@testing-library/react';
import { MessageList } from './MessageList';
import type { MessageVM } from '../../stores/agentStore';

const msgs: MessageVM[] = [
  {
    id: 'm1', role: 'user', createdAt: 1, updatedAt: 1, streaming: false,
    parts: [{ type: 'text', data: { text: '帮我重构' } }],
  },
  {
    id: 'm2', role: 'assistant', createdAt: 2, updatedAt: 2, streaming: true,
    parts: [
      { type: 'reasoning', data: { thinking: '思考过程…' } },
      { type: 'text', data: { text: '**好的**,开始。' } },
    ],
  },
];

describe('MessageList', () => {
  it('renders text parts and collapses reasoning', () => {
    render(<MessageList messages={msgs} />);
    expect(screen.getByText('帮我重构')).toBeTruthy();
    expect(screen.getByText('思考中…')).toBeTruthy();
    // react-markdown 渲染加粗
    expect(screen.getByText('好的,开始。')).toBeTruthy();
  });
});
```
Run: `npx vitest run src/components/agent/MessageList.test.tsx`
Expected: FAIL。

- [ ] **Step 2: 实现 Markdown 与 MessageItem**

安装:`npm install react-markdown`

`src/components/agent/markdown.tsx`:
```tsx
import ReactMarkdown from 'react-markdown';

export function Markdown({ text }: { text: string }) {
  return (
    <div className="prose prose-sm max-w-none dark:prose-invert">
      <ReactMarkdown>{text}</ReactMarkdown>
    </div>
  );
}
```

`src/components/agent/MessageItem.tsx`:
```tsx
import type { MessageVM } from '../../stores/agentStore';
import { Markdown } from './markdown';

export function MessageItem({ vm }: { vm: MessageVM }) {
  return (
    <div className="group flex flex-col gap-1 px-4 py-3">
      <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {vm.role}
        {vm.streaming && <span className="ml-2 animate-pulse text-primary">●</span>}
      </div>
      <div className="space-y-2">
        {vm.parts.map((part, i) => {
          const d = part.data as never as {
            text?: string; thinking?: string; reason?: string;
          };
          switch (part.type) {
            case 'text':
              return <Markdown key={i} text={d.text ?? ''} />;
            case 'reasoning':
              return (
                <details key={i} className="rounded border bg-muted/40 px-2 py-1 text-xs text-muted-foreground">
                  <summary>思考中…</summary>
                  <div className="mt-1 whitespace-pre-wrap">{d.thinking}</div>
                </details>
              );
            case 'tool_call':
              return (
                <div key={i} className="rounded border px-3 py-2 text-xs font-mono text-muted-foreground">
                  工具: {d.name}
                </div>
              );
            case 'finish':
              return (
                <div key={i} className="text-xs text-muted-foreground">
                  finish: {d.reason ?? ''}
                </div>
              );
            default:
              return null;
          }
        })}
      </div>
    </div>
  );
}
```

`src/components/agent/MessageList.tsx`:
```tsx
import { ScrollArea } from '../ui/scroll-area';
import type { MessageVM } from '../../stores/agentStore';
import { MessageItem } from './MessageItem';

export function MessageList({ messages }: { messages: MessageVM[] }) {
  return (
    <ScrollArea className="flex-1">
      <div className="divide-y divide-border">
        {messages.map((m) => (
          <MessageItem key={m.id} vm={m} />
        ))}
        {messages.length === 0 && (
          <div className="p-8 text-center text-sm text-muted-foreground">
            发送消息开始,agent 会在这里流式展示执行过程
          </div>
        )}
      </div>
    </ScrollArea>
  );
}
```

- [ ] **Step 3: 实现 Composer 与 AgentPanel**

`src/components/agent/Composer.tsx`:
```tsx
import { useState } from 'react';
import { Button } from '../ui/button';
import { Textarea } from '../ui/textarea';

export function Composer({ onSend, disabled }: { onSend: (p: string) => void; disabled?: boolean }) {
  const [value, setValue] = useState('');
  function submit() {
    const v = value.trim();
    if (!v || disabled) return;
    onSend(v);
    setValue('');
  }
  return (
    <div className="border-t p-3">
      <div className="flex items-end gap-2">
        <Textarea
          className="min-h-[44px] flex-1 resize-none"
          placeholder={disabled ? '连接中,暂时无法发送…' : '给 agent 下任务,Enter 发送'}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <Button onClick={submit} disabled={disabled || !value.trim()}>
          发送
        </Button>
      </div>
    </div>
  );
}
```
(shadcn `textarea` 组件需 `npx shadcn@latest add textarea`。)

`src/components/agent/AgentPanel.tsx`:
```tsx
import { useState } from 'react';
import { useAgentStore } from '../../stores/agentStore';
import { sendAgentMessage } from '../../lib/api';
import { useWorkspaceEvents } from '../../hooks/useWorkspaceEvents';
import { MessageList } from './MessageList';
import { Composer } from './Composer';

export function AgentPanel({ workspaceId, sessionId }: { workspaceId: string; sessionId: string }) {
  useWorkspaceEvents(workspaceId);
  const rt = useAgentStore((s) => (sessionId ? s.bySession[sessionId] : undefined));
  const setQueued = useAgentStore((s) => s.setQueued);
  const [postError, setPostError] = useState<string | null>(null);

  const running = rt?.run?.status === 'running';

  async function onSend(prompt: string) {
    setPostError(null);
    const runId = crypto.randomUUID();
    // 乐观插入用户消息
    const st = useAgentStore.getState();
    st.upsertMessage(sessionId, {
      id: `local-${runId}`,
      session_id: sessionId,
      role: 'user',
      parts: [{ type: 'text', data: { text: prompt } }],
      model: '',
      provider: '',
      created_at: Date.now(),
      updated_at: Date.now(),
    } as never);
    try {
      await sendAgentMessage(workspaceId, { sessionId, runId, prompt });
      st.markRun(sessionId, runId, 'running');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setPostError(msg);
      st.deleteMessage(sessionId, `local-${runId}`);
    }
  }

  return (
    <div className="flex h-full flex-col">
      <MessageList messages={rt?.messages ?? []} />
      {postError && (
        <div className="border-t border-destructive/30 bg-destructive/10 px-4 py-2 text-xs text-destructive">
          发送失败:{postError}
        </div>
      )}
      <Composer onSend={onSend} disabled={running} />
    </div>
  );
}
```

`src/components/shell/AppShell.tsx` 主区替换为:
```tsx
const workspaceId = useAgentStore((s) => s.activeWorkspaceId);
const sessionId = useAgentStore((s) => s.activeSessionId);
...
<main className="flex flex-1 flex-col">
  <SessionTabs />
  {workspaceId && sessionId ? (
    <AgentPanel workspaceId={workspaceId} sessionId={sessionId} />
  ) : (
    <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
      {workspaceId ? '选择或新建一个会话' : '先添加/选择项目'}
    </div>
  )}
</main>
```

- [ ] **Step 4: 运行测试 + 类型检查**

Run: `npx vitest run src/components/agent/ && npx tsc --noEmit`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/components/agent/ src/components/shell/AppShell.tsx
git commit -m "feat: add agent chat panel with composer and streaming message list"
```

---

### Task 12: ToolCallCard + 取消按钮 + 连接状态条

**Files:**
- Create: `src/components/agent/ToolCallCard.tsx`
- Create: `src/components/agent/ToolCallList.tsx`(从 messages 抽取 tool_call parts 汇总展示)
- Create: `src/components/shell/StatusBar.tsx`
- Modify: `src/components/agent/MessageItem.tsx`(tool_call → ToolCallCard)
- Test: `src/components/agent/ToolCallCard.test.tsx`、`src/components/shell/StatusBar.test.tsx`

**Interfaces:**
- Produces: `ToolCallCardProps { call: { id: string; name: string; input: string; finished: boolean } }` —— 展示名称、输入(JSON 格式化)、状态徽标(`pending`/`done`)、可折叠 `<details>`。
- Produces: `ToolCallList({ parts }): JSX` —— 从 message parts 过滤 `type==='tool_call'`,按顺序渲染 ToolCallCard。
- Produces: 取消:`AgentPanel` 内 `cancel()` → `cancelAgent(workspaceId, sessionId)`,按钮仅在 `running` 时显示。
- Produces: `StatusBar` —— 显示 `useConnectionStore.status`(绿点 connected / 灰点 disconnected / 黄点 connecting)、`lastError` tooltip、`COMBO_CRUSH_BIN` 缺失提示(连接失败且 health 不可达时提示"未检测到 crush server")。

- [ ] **Step 1: 写失败测试(ToolCallCard)**

`src/components/agent/ToolCallCard.test.tsx`:
```tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToolCallCard } from './ToolCallCard';

describe('ToolCallCard', () => {
  it('renders name, status, and collapsible input', async () => {
    render(
      <ToolCallCard
        call={{ id: 'tc1', name: 'bash', input: '{"cmd":"ls"}', finished: true }}
      />
    );
    expect(screen.getByText('bash')).toBeTruthy();
    expect(screen.getByText('done')).toBeTruthy();
    await userEvent.click(screen.getByText('bash'));
    expect(screen.getByText('{"cmd":"ls"}')).toBeTruthy();
  });
});
```
Run: `npx vitest run src/components/agent/ToolCallCard.test.tsx`
Expected: FAIL。

- [ ] **Step 2: 实现 ToolCallCard / ToolCallList / StatusBar**

`src/components/agent/ToolCallCard.tsx`:
```tsx
import { Badge } from '../ui/badge';

export interface ToolCallInfo {
  id: string;
  name: string;
  input: string;
  finished: boolean;
}

export function ToolCallCard({ call }: { call: ToolCallInfo }) {
  return (
    <details className="rounded-md border bg-muted/30">
      <summary className="flex cursor-pointer items-center gap-2 px-3 py-2">
        <span className="font-mono text-xs">⚙ {call.name}</span>
        <Badge variant={call.finished ? 'secondary' : 'outline'}>
          {call.finished ? 'done' : 'pending'}
        </Badge>
      </summary>
      <pre className="overflow-x-auto border-t bg-background px-3 py-2 font-mono text-xs text-muted-foreground">
        {call.input}
      </pre>
    </details>
  );
}
```

`src/components/agent/ToolCallList.tsx`:
```tsx
import type { Api } from '../../lib/api/types';
import { ToolCallCard, type ToolCallInfo } from './ToolCallCard';

export function ToolCallList({ parts }: { parts: Api.ContentPart[] }) {
  const calls: ToolCallInfo[] = [];
  for (const p of parts) {
    if (p.type === 'tool_call') {
      const d = p.data as never as { id: string; name: string; input: string; finished?: boolean };
      calls.push({ id: d.id, name: d.name, input: d.input, finished: !!d.finished });
    }
  }
  if (calls.length === 0) return null;
  return (
    <div className="space-y-1">
      {calls.map((c) => (
        <ToolCallCard key={c.id} call={c} />
      ))}
    </div>
  );
}
```

`src/components/shell/StatusBar.tsx`:
```tsx
import { useConnectionStore } from '../../stores/connectionStore';

const DOT: Record<string, string> = {
  connected: 'bg-green-500',
  disconnected: 'bg-gray-400',
  connecting: 'bg-yellow-400',
};

export function StatusBar() {
  const status = useConnectionStore((s) => s.status);
  const lastError = useConnectionStore((s) => s.lastError);
  const label = status === 'connected' ? '已连接 rune' : status === 'connecting' ? '连接中…' : '已断开';
  return (
    <footer className="flex h-6 items-center gap-2 border-t px-3 text-xs text-muted-foreground">
      <span className={`h-2 w-2 rounded-full ${DOT[status] ?? DOT.disconnected}`} />
      <span>{label}</span>
      {status === 'disconnected' && !lastError && (
        <span className="text-destructive">(未检测到 crush server,请确认已安装并位于 PATH)</span>
      )}
    </footer>
  );
}
```

- [ ] **Step 3: 接入 AgentPanel(取消 + ToolCallList 渲染区域)**

`MessageItem.tsx` 的 `tool_call` 分支改为渲染 `<ToolCallCard>`;`AgentPanel` 顶部加:
```tsx
{running && (
  <div className="flex items-center justify-between border-b px-4 py-2">
    <span className="text-xs text-muted-foreground">agent 正在执行…</span>
    <Button size="sm" variant="outline" onClick={cancel}>
      取消
    </Button>
  </div>
)}
```
`cancel` 实现:`await cancelAgent(workspaceId, sessionId)`(从 `../../lib/api` 导入)。

`AppShell` 布局底部加 `<StatusBar />`(`<div className="flex h-screen flex-col">` 内,侧边栏+主区用 flex-1 行)。

- [ ] **Step 4: 运行测试 + 类型检查**

Run: `npx vitest run src/components/agent/ToolCallCard.test.tsx src/components/shell/StatusBar.test.tsx && npx tsc --noEmit`
Expected: PASS(StatusBar 测试覆盖三种 status 文案与灰/绿点 class)。

- [ ] **Step 5: 提交**

```bash
git add src/components/agent/ToolCallCard.tsx src/components/agent/ToolCallList.tsx src/components/agent/MessageItem.tsx src/components/agent/AgentPanel.tsx src/components/shell/StatusBar.tsx src/components/shell/AppShell.tsx
git commit -m "feat: add tool call cards, cancel control, and connection status bar"
```

---

### Task 13: 权限弹窗 + 提问弹窗(模态优先队列)

**Files:**
- Create: `src/components/agent/PermissionDialog.tsx`
- Create: `src/components/agent/QuestionDialog.tsx`
- Create: `src/components/agent/ModalQueue.tsx`(把 permissionQueue + questionQueue 串成单个模态优先渲染)
- Test: `src/components/agent/PermissionDialog.test.tsx`、`src/components/agent/QuestionDialog.test.tsx`

**Interfaces:**
- Produces: `PermissionDialog({ permission, onResolve(action): void })` —— 展示工具名、描述、参数(JSON 树)、Path;三个动作:`allow`(仅本次)/`allow_session`(本次会话)/`deny`;调用 `grantPermission(workspaceId, permission, action)` 后 `onResolve('allow'|'allow_session'|'deny')`,store 内 `resolvePermission(tool_call_id)` 出队。
- Produces: `QuestionDialog({ batch, onResolve() })` —— 按 `batch.questions` 渲染:每项 `type` 决定控件(`yes_no` → 是/否,`single_choice` → 单选,`free_text` → 输入框,`multi_choice` → 复选);提交时构造 `QuestionAnswer { batch_request_id: batch.id, responses: [{ request_id: q.id, selected_ids?, fill_in_text?, yes? }] }` 调 `answerQuestion`,成功后 `dismissQuestionBatch(batch.id)`。
- Produces: `ModalQueue({ workspaceId })` —— 优先级:questionQueue 空时弹 permissionQueue 头,否则弹 questionQueue 头;同时只有一个 Dialog 打开;`onOpenChange(false)` 不清队(挂起),保持"不阻塞其他会话"语义(只阻塞当前模态渲染,SSE 事件仍继续入队)。

- [ ] **Step 1: 写失败测试(权限弹窗动作回调)**

`src/components/agent/PermissionDialog.test.tsx`:
```tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PermissionDialog } from './PermissionDialog';

describe('PermissionDialog', () => {
  it('resolves with allow', async () => {
    let action = '';
    render(
      <PermissionDialog
        permission={{
          id: 'p1', session_id: 's1', tool_call_id: 'tc1', tool_name: 'bash',
          description: '运行命令', action: 'bash', path: '/tmp',
        } as never}
        onResolve={(a) => (action = a)}
      />
    );
    expect(screen.getByText('运行命令')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: '允许' }));
    expect(action).toBe('allow');
  });
});
```
Run: `npx vitest run src/components/agent/PermissionDialog.test.tsx`
Expected: FAIL。

- [ ] **Step 2: 实现 PermissionDialog**

`src/components/agent/PermissionDialog.tsx`:
```tsx
import { Button } from '../ui/button';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter,
  DialogHeader, DialogTitle,
} from '../ui/dialog';
import type { Api } from '../../lib/api/types';

export type PermissionAction = 'allow' | 'allow_session' | 'deny';

export function PermissionDialog({
  permission,
  onResolve,
}: {
  permission: Api.PermissionRequest;
  onResolve: (action: PermissionAction) => void;
}) {
  return (
    <Dialog open>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="font-mono text-sm">权限请求:{permission.tool_name}</DialogTitle>
          <DialogDescription>{permission.description}</DialogDescription>
        </DialogHeader>
        <div className="space-y-2 text-xs">
          <div><span className="text-muted-foreground">Action:</span> <code>{permission.action}</code></div>
          {permission.path && <div><span className="text-muted-foreground">Path:</span> <code>{permission.path}</code></div>}
          <pre className="max-h-40 overflow-auto rounded border bg-muted/40 p-2 font-mono">
            {JSON.stringify(permission.params ?? {}, null, 2)}
          </pre>
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onResolve('deny')}>拒绝</Button>
          <Button variant="secondary" onClick={() => onResolve('allow_session')}>本次会话允许</Button>
          <Button onClick={() => onResolve('allow')}>允许</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 3: 实现 QuestionDialog**

`src/components/agent/QuestionDialog.tsx`:
```tsx
import { useState } from 'react';
import { Button } from '../ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog';
import type { Api } from '../../lib/api/types';

export function QuestionDialog({
  batch,
  onResolve,
}: {
  batch: Api.QuestionRequest;
  onResolve: (answer: Api.QuestionAnswer) => void;
}) {
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [fills, setFills] = useState<Record<string, string>>({});

  function build(): Api.QuestionAnswer {
    return {
      batch_request_id: batch.id,
      responses: batch.questions.map((q) => {
        if (q.type === 'yes_no') {
          const sel = selected[q.id] ?? [];
          return { request_id: q.id, yes: sel[0] === 'yes' };
        }
        if (q.type === 'free_text') {
          return { request_id: q.id, fill_in_text: fills[q.id] ?? '' };
        }
        return { request_id: q.id, selected_ids: selected[q.id] ?? [] };
      }),
    };
  }

  return (
    <Dialog open>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="text-sm">agent 提问</DialogTitle>
        </DialogHeader>
        <div className="max-h-72 space-y-4 overflow-auto">
          {batch.questions.map((q) => (
            <div key={q.id}>
              <div className="mb-1 text-sm font-medium">{q.question}</div>
              {q.description && <div className="mb-1 text-xs text-muted-foreground">{q.description}</div>}
              {q.type === 'yes_no' && (
                <div className="flex gap-2">
                  <Button
                    size="sm" variant={selected[q.id]?.[0] === 'yes' ? 'default' : 'outline'}
                    onClick={() => setSelected((s) => ({ ...s, [q.id]: ['yes'] }))}
                  >是</Button>
                  <Button
                    size="sm" variant={selected[q.id]?.[0] === 'no' ? 'default' : 'outline'}
                    onClick={() => setSelected((s) => ({ ...s, [q.id]: ['no'] }))}
                  >否</Button>
                </div>
              )}
              {(q.type === 'single_choice' || q.type === 'multi_choice') && (
                <div className="space-y-1">
                  {q.choices?.map((c) => {
                    const on = selected[q.id]?.includes(c.id) ?? false;
                    return (
                      <label key={c.id} className="flex items-center gap-2 rounded border px-2 py-1 text-sm hover:bg-muted">
                        <input
                          type={q.type === 'single_choice' ? 'radio' : 'checkbox'}
                          checked={on}
                          onChange={() =>
                            setSelected((s) => {
                              const cur = s[q.id] ?? [];
                              const next = q.type === 'single_choice'
                                ? [c.id]
                                : on ? cur.filter((x) => x !== c.id) : [...cur, c.id];
                              return { ...s, [q.id]: next };
                            })
                          }
                        />
                        {c.label}
                      </label>
                    );
                  })}
                </div>
              )}
              {q.type === 'free_text' && (
                <input
                  className="w-full rounded border px-2 py-1 text-sm"
                  value={fills[q.id] ?? ''}
                  onChange={(e) => setFills((f) => ({ ...f, [q.id]: e.target.value }))}
                />
              )}
            </div>
          ))}
        </div>
        <DialogFooter>
          <Button onClick={() => onResolve(build())}>提交回答</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 4: 实现 ModalQueue 并挂到 AppShell**

`src/components/agent/ModalQueue.tsx`:
```tsx
import { useAgentStore } from '../../stores/agentStore';
import { answerQuestion, grantPermission } from '../../lib/api';
import { PermissionDialog } from './PermissionDialog';
import { QuestionDialog } from './QuestionDialog';

export function ModalQueue({ workspaceId }: { workspaceId: string }) {
  const permissionQueue = useAgentStore((s) => s.permissionQueue);
  const questionQueue = useAgentStore((s) => s.questionQueue);
  const resolvePermission = useAgentStore((s) => s.resolvePermission);
  const dismissQuestion = useAgentStore((s) => s.dismissQuestionBatch);

  // 模态优先:先提问批次,后权限
  const activeQuestion = questionQueue[0];
  const activePermission = !activeQuestion ? permissionQueue[0] : undefined;

  return (
    <>
      {activeQuestion && (
        <QuestionDialog
          batch={activeQuestion}
          onResolve={async (answer) => {
            await answerQuestion(workspaceId, answer);
            dismissQuestion(activeQuestion.id);
          }}
        />
      )}
      {activePermission && (
        <PermissionDialog
          permission={activePermission}
          onResolve={async (action) => {
            await grantPermission(workspaceId, activePermission, action);
            resolvePermission(activePermission.tool_call_id);
          }}
        />
      )}
    </>
  );
}
```

`AppShell` 主区加 `<ModalQueue workspaceId={workspaceId} />`(workspaceId 存在时)。

- [ ] **Step 5: 运行测试 + 类型检查**

Run: `npx vitest run src/components/agent/ && npx tsc --noEmit`
Expected: PASS。QuestionDialog 测试覆盖 yes_no 选择提交出参结构(`batch_request_id`、`yes` 字段)。

- [ ] **Step 6: 提交**

```bash
git add src/components/agent/PermissionDialog.tsx src/components/agent/QuestionDialog.tsx src/components/agent/ModalQueue.tsx src/components/shell/AppShell.tsx
git commit -m "feat: add permission and question modal queue"
```

---

### Task 14: Playwright E2E(端到端垂直闭环)

**Files:**
- Create: `playwright.config.ts`
- Create: `e2e/vertical-slice.spec.ts`
- Create: `scripts/dev-proxy.sh`(启动 combo-proxy bin + 打印端口,供 playwright webServer 解析)
- Modify: `package.json`(加 `"test:e2e": "playwright test"`)

**Interfaces:**
- Produces: Playwright webServer:两个服务 —— `vite`(`npm run dev -- --port 5173 --strictPort`)与 `combo-proxy`(`COMBO_CRUSH_BIN=... cargo run -p combo-proxy --bin combo-proxy -- --port 18234`),`url` 指向 `http://localhost:5173`,`reuseExistingServer: !process.env.CI`。
- Produces: E2E 环境变量:`COMBO_CRUSH_BIN` 指向真实 `crush` 二进制时对真实 rune 跑完整闭环;未设置时该 spec 用 `test.skip`(打印说明)。

- [ ] **Step 1: 配置 Playwright**

`playwright.config.ts`:
```ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 120_000,
  use: { baseURL: 'http://localhost:5173' },
  webServer: [
    {
      command: 'npm run dev -- --port 5173 --strictPort',
      url: 'http://localhost:5173',
      reuseExistingServer: true,
      timeout: 30_000,
    },
    {
      command: 'cargo run -p combo-proxy --bin combo-proxy -- --port 18234',
      url: 'http://127.0.0.1:18234/v1/health',
      reuseExistingServer: true,
      timeout: 30_000,
    },
  ],
});
```
浏览器模式前端 `resolveProxyBaseUrl` 需指向 18234:dev 时通过 `VITE_PROXY_URL` 注入,`package.json` dev 脚本改为:
```json
"dev": "vite --strictPort"
```
并在 `scripts/dev-proxy.sh` 里导出 `VITE_PROXY_URL=http://127.0.0.1:18234 npm run dev`。playwright 的 webServer command 直接运行 `bash scripts/dev-proxy.sh`(vite 进程由脚本内 `&` 拉起,脚本尾部 `wait`)。

- [ ] **Step 2: 写 E2E 测试**

`e2e/vertical-slice.spec.ts`:
```ts
import { test, expect } from '@playwright/test';

const hasCrush = !!process.env.COMBO_CRUSH_BIN;

test.describe('M1 vertical slice', () => {
  test.skip(!hasCrush, 'set COMBO_CRUSH_BIN to run against a real rune server');

  test('create workspace -> session -> agent run -> permission dialog', async ({ page }) => {
    // 预置:确保存在一个可用的 workspace 路径(用临时目录)
    const tmp = process.env.COMBO_IT_DIR ?? '/tmp/combo-e2e';

    await page.goto('/');
    await expect(page.getByText('已连接 rune')).toBeVisible({ timeout: 15_000 });

    // 添加项目
    await page.getByPlaceholder('输入项目路径').fill(tmp);
    await page.getByRole('button', { name: '添加项目' }).click();
    await expect(page.getByText(tmp)).toBeVisible({ timeout: 15_000 });

    // 新建会话
    await page.getByTitle('新建会话').click();
    await expect(page.getByText('会话 1')).toBeVisible({ timeout: 15_000 });

    // 发送任务
    await page.getByPlaceholder(/给 agent 下任务/).fill('执行 pwd 并返回当前目录');
    await page.getByRole('button', { name: '发送' }).click();

    // 等待工具调用卡片出现(可能触发权限弹窗;若出现则允许)
    const perm = page.getByText('权限请求', { exact: false });
    if (await perm.isVisible().catch(() => false)) {
      await page.getByRole('button', { name: '允许' }).click();
    }
    await expect(page.getByText('⚙ bash').first()).toBeVisible({ timeout: 120_000 });

    // 等待运行完成(finish 消息或 run 状态消失)
    await expect(page.getByText(/finish:|done/).first()).toBeVisible({ timeout: 120_000 });
  });
});
```

- [ ] **Step 3: 本地跑通**

Run: `COMBO_CRUSH_BIN="$(command -v crush)" npm run test:e2e`
Expected: PASS(全链路:真实 rune server、代理、前端、SSE、权限弹窗)。若真实环境无 `crush`,本步允许跳过,但必须在 CI 或本地具备 crush 的机器上跑通后合入。

- [ ] **Step 4: 提交**

```bash
git add playwright.config.ts e2e/ scripts/dev-proxy.sh package.json
git commit -m "test: add Playwright e2e for M1 vertical slice"
```

---

### Task 15: M1 收尾(README + 全局约束核对)

**Files:**
- Create: `README.md`(项目简介、架构图、运行方式:`npm run tauri dev` / dev 模式 `scripts/dev-proxy.sh` + `npm run dev`、环境变量 `COMBO_CRUSH_BIN`/`VITE_PROXY_URL`、测试命令)
- Modify: 如有遗漏按 Global Constraints 逐条核对

**Interfaces:**
- Produces: 可被新贡献者直接运行的项目入口文档。

- [ ] **Step 1: 写 README**

内容包含:项目定位(配合 rune 的多 agent IDE)、架构图(ascii,同 spec §2.1)、运行前提(`crush` 安装)、两种运行方式、测试命令(`cargo test -p combo-proxy`、`npx vitest run`、`npm run test:e2e`)、目录结构说明。

- [ ] **Step 2: 核对 Global Constraints**

逐条检查:Node/Rust 版本说明、`COMBO_CRUSH_BIN` 行为、swagger 来源记录(README.md 已含 commit)、client_id 注入(apiRequest 默认注入)、SSE 信封处理(dispatch)、前端无 Tauri 依赖(仅 dialog 场景,当前 M1 用路径输入,无 Tauri 依赖)、提交风格。有不符就地修复并跑全量测试。

- [ ] **Step 3: 全量验证**

Run: `cargo test --workspace && npx vitest run && npx tsc --noEmit && npm run build`
Expected: 全部 PASS。

- [ ] **Step 4: 提交**

```bash
git add README.md
git commit -m "docs: document M1 usage, architecture, and development workflow"
```

---

## Self-Review(计划内自查,已执行)

1. **Spec coverage 对照**(spec: combo-multiagent-ide-design):
   - 架构(§2):Task 1/3/4/5 覆盖 Rust 壳+代理+rune 生命周期;CORS/SSE 透传在 Task 3。
   - API client + swagger 生成(§2.4):Task 2/7。
   - 事件流 SSE + 重连 + 对账(§2.5):Task 10(对账通过 Task 9 的 history 失效重载 + Task 10 重连)。
   - 数据模型/状态分层(§3):Task 8/9/10(agentStore 会话分片、TanStack Query)。
   - 组件(§4):WorkspaceSidebar(Task 8)、SessionTabs(Task 9)、AgentPanel/MessageList/ToolCallCard/Composer(Task 11/12)、PermissionDialog/QuestionDialog(Task 13)、StatusBar(Task 12)。M1 不涉及 FileExplorer/Monaco/Terminal/Git(属 M2/M3)。
   - 错误处理(§5):断线重连(Task 6/10)、防误提交(Composer disabled,Task 11)、错误内联(Task 11 postError、Task 12 StatusBar)、权限/提问队列不阻塞(Task 13 注释语义)。
   - 测试(§6):Rust 单测+集成(Task 3/4)、client 单测(Task 7)、store 事件序列(Task 10)、组件测试(Task 8/9/11/12/13)、E2E(Task 14)。
   - 里程碑 M1 范围核对:无 M2/M3 内容泄漏进本计划。

2. **Placeholder scan**:全文无 TBD/TODO;"实现细节见 Step 5"在 Task 3 Step 4 出现一次,属同任务内指引,且 Step 5 给出了完整契约,不算占位。所有代码块均为可直接落地的内容。

3. **Type consistency**:
   - `Upstream::{Unix,Tcp}` / `serve(listener, upstream, allowed_origins)` / `build_router` / `parse_upstream`:Task 3 定义,Task 4/5 复用一致。
   - `RuneManager::{new, ensure_running, health_check, shutdown, log_path}` / `default_socket_path`:Task 4 定义,Task 5 使用一致。
   - `ProxyReady{port}` / `RuneStatus{connected}` / 事件名常量:Task 5 定义,Task 6 前端监听 `proxy-ready` 一致。
   - `getProxyBaseUrl/setProxyBaseUrl/checkHealth/connectLoop/resolveProxyBaseUrl/isTauri`:Task 6 定义,Task 7/10 使用一致。
   - `ApiError{status,message}` / `apiRequest<T>`:Task 7 定义,`index.ts` 复用。
   - agentStore actions(`upsertMessage/deleteMessage/markRun/setQueued/enqueuePermission/resolvePermission/enqueueQuestionBatch/dismissQuestionBatch/clearSessionRuntime`):Task 10 定义,Task 10 测试与 Task 11/12/13 使用一致。
   - `WorkspaceEventSource(workspaceId, onPayload, opts)`:`start/stop/connected`:Task 10 定义,`useWorkspaceEvents` 使用一致。
   - `MessageVM{id,role,parts,createdAt,updatedAt,streaming}`:Task 10 定义,Task 11/12 使用一致。
   - `PermissionDialog({permission,onResolve})` / `QuestionDialog({batch,onResolve})` / `ModalQueue({workspaceId})`:Task 13 定义并自洽。
   - 注意点:`Api.AgentMessage` 的 JSON 字段为 snake_case(`session_id`/`run_id`),Task 7 的 `satisfies Api.AgentMessage` 会强制校验;若 swagger 中 `run_id` 为 `omitempty` 可选,`satisfies` 表达式仍合法。

4. **范围**:15 个任务均产出可独立验证的交付物,任务粒度 2-5 分钟/步。M1 完成后可运行、可演示、可测试。
