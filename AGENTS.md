# AGENTS.md

> **查询优先级**:本仓库已接入 codebase-memory MCP。定位符号、查调用关系、
> 找定义/引用、了解架构等,**优先使用 `mcp_codebase-memory_*` 工具**
> (`search_graph` / `get_code_snippet` / `trace_path` / `get_architecture` /
> `query_graph` / `search_code`),而非直接 grep/读大文件。项目名传 `combo`。

## What this is

**combo** is a multi-agent IDE desktop app: a Tauri v2 shell + React 19/TypeScript
frontend that talks to **rune** (the Charm Crush server binary, `crush`) through an
embedded Rust reverse proxy. All UI copy, code comments, and the README are in
**Chinese** — keep new UI strings and comments in Chinese to match.

```
Tauri Webview (React/TS)
   fetch / EventSource ──→ http://127.0.0.1:<random-port>/v1/*
                              │ combo-proxy (axum, pure forwarder, CORS + SSE passthrough)
                              ▼
                    rune server (`crush server` subprocess, unix socket)
```

Three components, three languages/dirs:

- **`crates/combo-proxy`** (Rust, axum) — reverse proxy. Forwards every request
  under `/v1/*` to rune; streams SSE bodies through un-buffered. Also serves
  **local file read/write** (`fs.rs`, only `/v1/workspaces/{id}/files/*`):
  list-dir / read / write with canonicalize prefix checks against the
  workspace root (rune has no file API). Contains `RuneManager` (`src/rune.rs`),
  which spawns/guards the `crush server` subprocess (health-poll, auto-restart
  is via `ensure_running`, graceful shutdown via `/v1/control`).
- **`src-tauri`** (Rust, Tauri v2) — thin shell. `init_backend` in `src/lib.rs`
  starts `RuneManager` + proxy on `127.0.0.1:0` (random port), emits Tauri events
  `proxy-ready` (`{port}`) and `rune-status` (`{connected}`). On rune failure it
  keeps the proxy alive pointing at an unreachable TCP address so the UI shows
  "disconnected".
- **`src/`** (React 19 + Vite + TS, shadcn/ui) — the frontend. TanStack Query
  for REST data, **Zustand** (`stores/agentStore.ts`) for SSE-driven live state,
  keyed by `sessionId`.

The frontend never talks to Tauri APIs for data (`src/lib/connection.ts` detects
Tauri via `'__TAURI_INTERNALS__' in window`), so the whole app is developable in a
plain browser. M1 directory picking is a path input, not a native dialog.

## Commands

```bash
npm run dev                 # Vite dev server, strict port 5173 (browser mode)
bash scripts/dev-proxy.sh   # = VITE_PROXY_URL=http://127.0.0.1:18234 npm run dev
npm run build               # tsc -b && vite build (production build, outputs dist/)
npm run tsc                 # tsc -b (project references: tsconfig.app.json + tsconfig.node.json)
npm test                    # vitest run (jsdom; config lives inside vite.config.ts)
npm run test:e2e            # Playwright; SKIPS itself unless COMBO_CRUSH_BIN is set
npm run gen:api             # regenerate src/lib/api/types.ts from swagger/swagger.json
cargo run -p combo-proxy --bin combo-proxy -- --port 18234   # proxy standalone (auto-spawns rune)
cargo test -p combo-proxy   # Rust unit + integration tests
```

**Browser dev workflow (recommended):** terminal 1 `bash scripts/dev-proxy.sh`,
terminal 2 `cargo run -p combo-proxy --bin combo-proxy -- --port 18234`, then open
http://localhost:5173.

**Tauri desktop mode:** the README says `npm run tauri dev`, but **that does not
work out of the box** — there is no `tauri` npm script and `@tauri-apps/cli` is not
installed. You need the Tauri CLI from the Rust toolchain (`cargo tauri dev`) or to
install `@tauri-apps/cli` first. `bundle.active` is `false` in
`src-tauri/tauri.conf.json`, so packaging is not set up.

### Env vars

| Var | Meaning |
|---|---|
| `COMBO_CRUSH_BIN` | Path to the rune server binary (default: `crush` from PATH). Required for E2E and rune integration tests. |
| `COMBO_RUNE_IT` | Set to `1` to enable the rune integration test in `crates/combo-proxy/tests/rune_integration_test.rs` (skips otherwise). |
| `COMBO_IT_DIR` | E2E workspace directory (default `/tmp/combo-e2e`). |
| `COMBO_DATA_DIR` | combo sqlite 数据目录(默认 `$XDG_DATA_HOME/combo`,macOS 无 XDG 时 `~/.local/share/combo`)。 |
| `VITE_PROXY_URL` | Proxy base URL for browser mode (e.g. `http://127.0.0.1:18234`). In Tauri mode the port comes from the `proxy-ready` event with a 2s fallback to `:18234`. |

`crush` is **not** installed in this environment — anything requiring it
(integration/E2E tests, desktop mode) self-skips or fails unless the binary is
provided.

## Architecture & data flow

- **File service** (`crates/combo-proxy/src/fs.rs`): `GET .../files/list?path=`
  lists one directory (hidden files skipped, dirs first), `GET .../files/content`
  reads text (≤1MB, binary rejected), `PUT .../files/content` writes atomically.
  `path` must be relative; the proxy resolves the workspace root by calling
  `GET /v1/workspaces/{id}` on rune. Frontend: `src/lib/api` wrappers +
  `stores/editorStore.ts` + `FileExplorer`/`EditorPane`.
- **Sqlite 持久化** (`crates/combo-proxy/src/db.rs`): combo 自有元数据落盘在
  sqlite(默认 `~/.local/share/combo/combo.db`,`COMBO_DATA_DIR` 可覆盖)。
  表 `workspaces`(项目元数据,含可重命名的 `name`)与 `conversations`
  (rune session 的本地镜像)。`MetaStore` (`meta.rs`)是 sqlite-backed:
  `WorkspaceMeta.name` 创建时默认取目录 basename,`PATCH /v1/workspaces/{id}`
  可重命名并跨重启保留。**Session 镜像** (`session.rs`)拦截
  `GET/POST/DELETE /v1/workspaces/{id}/sessions`:创建/删除转发 rune 成功后
  双写 sqlite,列表直接从 sqlite 读(不依赖 rune 在线,首次访问自动回源
  补齐历史会话);其余 session 子路径(history/messages/events 等)仍走
  fallback 透传给 rune。项目列表在左侧显示 `name`(不再是完整路径),
  hover 出现铅笔按钮可重命名。
- **Selection persistence**: `agentStore` uses `zustand/persist`
  (`localStorage` key `combo.agent`) storing only `activeWorkspaceId` +
  `activeSessionId`; SSE state stays in-memory. `setActiveWorkspace` clears the
  session when switching projects; `useSessions` clears restored-but-invalid
  session ids (guarded by a `lastCreated` ref so a freshly created session is
  never clobbered while the list refetches).
- **`client_id` is the identity mechanism.** `apiRequest` (`src/lib/api/client.ts`)
  auto-injects a `client_id` query param (UUID persisted in `localStorage`
  `combo.clientId`; `randomUUID` in `src/lib/clientId.ts` deliberately avoids
  `crypto.randomUUID` for insecure LAN contexts). **Gotcha:** `createWorkspace`
  must ALSO put `client_id` in the request body — rune validates it from the body,
  not the query string. SSE subscription also passes it as a query param.
- **SSE envelope is double-nested.** `GET /v1/workspaces/{id}/events?client_id=...`
  with `Accept: text/event-stream`. Each frame's `data:` is
  `{ type: <PayloadType>, payload: { type: "created"|"updated"|"deleted", payload: <real data> } }`.
  `src/lib/events/dispatch.ts` unwraps one level and writes into the Zustand store;
  `payloadTypes.ts` lists all known `PayloadType`s. Unhandled types are silently
  ignored (`run_complete` marks the run done, `message` upserts, permission/question
  types feed the modal queues). `useWorkspaceEvents` intercepts `session` events to
  invalidate the TanStack sessions query instead.
- **Run lifecycle:** `AgentPanel.doSend` generates a `runId` (UUID), optimistically
  inserts a user message with id `` `local-${runId}` `` (fake `created_at` via
  `Date.now()`), POSTs `/v1/workspaces/{id}/agent`, then marks the run `running`.
  If no session is active yet, it first creates one via `useSessions().create`
  (title = 首条消息截断 20 字). On failure it deletes the optimistic message.
  `run_complete` sets the run to `done`. Note: `MessageVM.streaming` is set to
  `true` on every upsert and never flipped back — completion is signaled by run
  status, not message flags.
- **Proxy gotchas** (`crates/combo-proxy/src/handler.rs`): strips `HOST`,
  `CONNECTION`, `CONTENT_LENGTH`, `TRANSFER_ENCODING` headers in both directions.
  Unix-socket upstream URIs must be `unix://<hex-encoded-socket-path>/<path>`.
  Rune's default socket is `$XDG_RUNTIME_DIR/crush-<uid>.sock` (falls back to
  `temp_dir()`, and to `crush.sock` when uid unknown); path is capped at 104 bytes
  (macOS `sun_path` limit) in `rune.rs::default_socket_path`. Rune stdout goes to
  `$TMPDIR/combo-rune.log`. When `--origin` flags are absent, CORS is fully
  permissive; Tauri mode passes `tauri://localhost` and `http://localhost:5173`.

## Code organization & conventions

- **Rust:** module-per-concern under `crates/combo-proxy/src/` (`handler`, `router`,
  `rune`, `upstream`), `pub` API re-exported from `lib.rs`. Workspace root
  `Cargo.toml` has members `crates/combo-proxy` and `src-tauri`.
- **Frontend layout:** `src/components/{ui,shell,agent}` — `ui/` is generated
  shadcn primitives, `shell/` is app chrome, `agent/` is the chat/tool/modal UI.
  The shell is a 1:1 仿写 ZCode 的 agent 布局:左侧 `WorkspaceSidebar`(默认 372px,
  可拖拽调宽/收起,含 新建任务/搜索/自动化/技能 按钮、「分组/项目」视图切换、
  「项目/任务/文件」可折叠分区、底部用户与连接状态) + 可拖拽分隔条 + 主内容区
  (顶栏帮助/终端按钮;无会话时显示 `ChatEmptyState` 问候语 + 订阅横幅 + 模板卡片,
  会话中显示消息列表,底部为 ZCode 风格 `Composer` 输入坞:项目 chip + 工具栏
  [添加上下文/模式/用量环/后端/思考等级/发送])。`index.html` 固定 `class="dark"`,
  新增 theme token(`--surface`/`--foreground-subtle`/`--brand` 等,见 `index.css`)。
  `StatusBar` 已从布局移除,连接状态折进侧边栏底部;`EditorPane`(文件编辑器)
  仍在右侧,打开文件时才渲染。
  `src/hooks/` wraps TanStack queries + SSE lifecycle;
  `src/lib/api/` is the typed client (`types.ts` generated, `index.ts` hand-written
  endpoint wrappers); `src/lib/events/` is SSE + dispatch; `src/lib/connection.ts`
  is proxy address discovery + health polling; `src/stores/` is Zustand.
- **Generated types are NOT purely generated.** `npm run gen:api` runs
  `openapi-typescript` over `swagger/swagger.json` (vendored from the rune repo at
  commit `28ed89ff`, see `swagger/README.md`) then **appends a hand-maintained
  `Api` namespace** (in `scripts/gen-api.sh`) because the swagger is incomplete
  (question types, parts, etc. missing). Hand-edit that appended block when the
  wire types change; `src/lib/api/contract.test.ts` is a type-level compile check
  guarding the shapes.
- **Naming:** kebab-case filenames, PascalCase components, camelCase functions,
  `use` prefix on hooks, wire types under the `Api` namespace. Tests are colocated
  as `*.test.ts` / `*.test.tsx`.
- **Alias:** `@/*` → `./src/*` (configured in both `vite.config.ts` and
  `tsconfig.app.json`). Vitest config lives **inside** `vite.config.ts`
  (jsdom env, globals, excludes `e2e/**`).

## Testing

- **Unit (Vitest + Testing Library, jsdom):** `apiRequest` tests stub global fetch
  with `vi.stubGlobal` and drive the base URL via `setProxyBaseUrl` (a module-level
  mutable in `connection.ts` — reset per test). `dispatch-real.test.ts` replays
  captured real rune SSE envelopes through `applyEvent`. Store and component tests
  assert against the Zustand store directly. **`src/test-setup.ts`** polyfills
  `localStorage` (jsdom 25 + Node 26 下 getter 失效)和 `ResizeObserver`
  (radix ScrollArea 依赖),并在每个测试前清空持久化状态,所有 Vitest 测试共用。
- **Rust:** in-module `#[cfg(test)]` units plus `tests/proxy_test.rs` (spins an
  in-memory stub axum upstream and asserts proxying incl. SSE passthrough) and
  `tests/rune_integration_test.rs` (real rune, gated on `COMBO_RUNE_IT=1`).
  sqlite 用 `ComboDb::in_memory()`,不落盘。
- **E2E (Playwright):** `playwright.config.ts` `webServer` auto-starts both Vite
  (`bash scripts/dev-proxy.sh`) and the proxy (`cargo run ... --port 18234`) with
  `reuseExistingServer: true`. The spec skips itself unless `COMBO_CRUSH_BIN` is
  set. It **wipes the workspace dir (`/tmp/combo-e2e`) before running** because
  rune persists state (`.crush/`) inside the workspace. Selectors rely on Chinese
  UI text (e.g. button `添加项目`, `发送`, title `新建会话`);项目在左侧以
  basename 显示,会话列表在中间(`ConversationList`)。「添加项目」在
  桌面模式弹原生目录对话框,浏览器模式仅提示;e2e 改为经 API 创建工作区.

## Gotchas summary

1. `npm run tauri dev` (README) is wrong as-is — no tauri npm script/CLI installed.
2. Browser dev needs the proxy on `:18234`; that port is hard-coded as fallback in
   `connection.ts`, `dev-proxy.sh`, `playwright.config.ts`, and the e2e spec.
3. `client_id` goes in query params everywhere, but must also be in the
   `createWorkspace` request body.
4. SSE envelopes are double-nested; don't read `env.payload` directly.
5. Message `streaming` flag never resets; use run status for completion.
6. Don't "fix" the appended `Api` namespace block in `types.ts` by moving it into
   the generated section — it must be re-appended by `gen-api.sh`.
7. Keep Chinese for user-facing strings; the e2e suite depends on it.
8. `tsc -b` (project references) is incremental; `tsconfig.node.tsbuildinfo` /
   `tsconfig.app.tsbuildinfo` are gitignored but regenerate on build.
9. `agentStore` SSE state is in-memory only — reloading loses live messages;
   history is refetched via `getSessionHistory` when a session is activated.
   Only the active workspace/session selection is persisted (see above).
10. **axum 0.7 route params use `:id`, not `{id}`** (that's axum 0.8 syntax).
    The file-service routes in `router.rs` and the stub in `proxy_test.rs` both
    use `:id`; a `{id}` route silently falls through to the proxy fallback.
11. **会话列表来自 sqlite 镜像,不是 rune。** `GET .../sessions` 由
    `session.rs` 本地接管(从 sqlite 读);新建会话必须走 proxy
    (`POST .../sessions`),直接调 rune 创建的会话不会进 sqlite 镜像,
    需要删库或等首次空列表回源补齐(仅当该 workspace 无任何记录时)。
12. **sqlite 用 `std::sync::Mutex<Connection>`**,`rusqlite` 连接不是 `Sync`;
    `list_*` 方法里 lock 的临时值要绑定到 `let`,否则借用检查报 E0716。
