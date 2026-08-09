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
cargo run -p combo-proxy --bin combo-proxy -- --port 18234   # proxy standalone(默认托管 combo-cli serve)
bash scripts/dev-backend.sh    # 一步:编译 combo-cli → 启动 combo-proxy(端口 18234,可传参)
cargo run -p combo-cli --bin combo-cli -- ask "你好"         # 自有 agent CLI(rig 驱动)
cargo test -p combo-proxy   # Rust unit + integration tests
cargo test -p combo-cli     # combo-cli 单元测试
```

> **默认 agent 是 combo-cli(本机自有 agent),不再是 crush。** proxy 无
> `--upstream` 时自动托管 `combo-cli serve`(`COMBO_CLI_BIN` 指定二进制,默认
> `combo-cli`),新项目默认 `backend=combo-cli`;crush 变为可选项——显式传
> `--upstream` 或设 `COMBO_CRUSH_BIN` 才会拉起(存量 crush 项目兼容)。
> combo-cli serve 实现 rune 兼容协议(`/v1/workspaces/{id}/agent` + SSE
> events + cancel + current-session/permissions stub),会话与历史由 proxy 的
> sqlite 镜像负责,`/agent` 请求由 proxy 注入 `history`(见
> `handler.rs::inject_history`)支撑多轮上下文;工具自动执行、无权限拦截。

**Browser dev workflow (recommended):** terminal 1 `bash scripts/dev-proxy.sh`,
terminal 2 `bash scripts/dev-backend.sh`(一步编译 combo-cli 并以它为默认 agent
启动 proxy,等价于先 `cargo build -p combo-cli` 再 `COMBO_CLI_BIN=target/debug/combo-cli
cargo run -p combo-proxy --bin combo-proxy -- --port 18234`),then open
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
| `COMBO_HOST` | Proxy 监听地址(默认 `127.0.0.1`)。域名部署时设 `0.0.0.0` 对外开放;命令行 `--host` 优先级更高。 |
| `COMBO_CLI_BIN` | combo-cli serve 二进制(默认 `combo-cli` 从 PATH 找)。设此变量才会自动托管 combo-cli serve;二进制缺失时 proxy 仍可启动(combo-cli 项目转发 502)。 |
| `COMBO_CRUSH_BIN` | 存量 crush 兼容:设此变量才自动拉起 `crush server`(不再默认启动)。 |

`crush` is **not** installed in this environment — anything requiring it
(integration/E2E tests, desktop mode) self-skips or fails unless the binary is
provided. combo-cli 同理:集成测试
(`crates/combo-proxy/tests/combo_cli_integration_test.rs`)在 `COMBO_CLI_BIN`
指定的二进制缺失时自动跳过。

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
  `GET/POST/DELETE /v1/workspaces/{id}/sessions`:创建按 workspace 后端类型
  路由——crush 转发 rune 成功后双写 sqlite,combo-cli 等其它后端直接本地
  建会话(不转发);删除先删 sqlite 再尽力转发 rune。列表直接从 sqlite 读
  (不依赖后端在线,首次访问自动回源补齐历史会话);其余 session 子路径
  (history/messages/events 等)仍走 fallback 透传(combo-cli 由 serve 端
  rune 兼容协议承接)。项目列表在左侧显示 `name`(不再是完整路径),
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

0. **combo-cli**(`crates/combo-cli`)是自有 agent CLI:基于 rig 0.41,
   **provider 结构与 crush 的 providers.json 完全一致**(`providers.rs` 的
   `ProviderInfo`/`ModelInfo`,字段:id/name/api_key/api_endpoint/type/
   default_large_model_id/default_small_model_id/models)。`--provider` 按 id
   解析,**查找顺序:配置文件内嵌 providers 数组(`config.rs` 的
   `providers` 字段,同 crush 格式)→ `~/.local/share/crush/providers.json`
   (`providers.rs::load_crush_providers`,`CRUSH_DATA_DIR` 可覆盖)→ 内置
   定义(`providers.rs::builtin_providers`)**,支持 crush 的 40 个 provider
   (opencode-zen/opencode-go/zai/deepseek/xai/zhipu/…)。`api_key`/`api_endpoint`
   支持 `$ENV_VAR` 运行时展开(`providers.rs::expand_env`);agent 按
   `type` 分派:anthropic→rig anthropic client、google→gemini、
   其余(openai/openai-compat/azure…)→`openai::CompletionsClient` builder
   (自定义 endpoint)。**opencode-zen**(crush 定义:
   `https://opencode.ai/zen/v1`,默认模型 `deepseek-v4-flash-free`):key
   从 `~/.local/share/opencode/auth.json` 的 `opencode` 条目自动回退
   (id 为 opencode 或 opencode-zen 时,见 `agent.rs::AskConfig::api_key`),
   或 `combo-cli config import` 一键导入到 combo 配置(provider=opencode)。
   子命令:
   `ask`(单轮流式)、`chat`(交互多轮流式,历史
   持久化 `COMBO_DATA_DIR`/`XDG_DATA_HOME/combo/combo-cli.db`,表
   `cli_conversations`/`cli_messages` 与 proxy 隔离)、`sessions list|show|rm`、
   `serve`(RuneManager 式进程管理,stdout 输出 `COMBO_CLI_PORT=` 供
   `combocli.rs::ComboCliManager` 解析端口;`GET /v1/health` + `POST
   /v1/control` 优雅关闭 + **rune 兼容协议**:`POST /v1/workspaces/{id}/agent`
   发起运行(请求体含 proxy 注入的 `history`)、`POST
   .../agent/sessions/{sid}/cancel` 取消、`GET /v1/workspaces/{id}/events`
   SSE 双层信封事件流(消息 created/updated + finish + run_complete,keepalive
   用 15s `: ping`,不能用 `interval.tick()`——unfold 每帧重建会首 tick 洪泛)、
   current-session/permissions-skip stub;无 API key 时也发
   `finish(reason=error)` + `run_complete` 保证前端 run 收尾)、`config
   path|init|import`(配置文件管理)。**配置文件自动生成**:首次运行在
   `$XDG_CONFIG_HOME/combo/combo-cli.toml`(`COMBO_CONFIG_DIR` 覆盖目录,
   `--config` 覆盖路径)生成带注释的默认模板;优先级
   **CLI 参数 > 配置文件 > 内置默认值**,因此 `provider/preamble/tools`
   的 clap 参数是 `Option`,不能设 `default_value`,否则永远覆盖配置文件
   (合并逻辑在 `config.rs::resolve`)。内置工具
   (时间/日期)+ 可选 MCP 工具(`--mcp-command` stdio / `--mcp-url`
   streamable HTTP,经 rig `ToolServer`+`McpClientHandler` 注册)。rig 0.41
   注意:provider client 用 `Client::from_env()`(需 `rig::prelude::*` 的
   `ProviderClient`+`AgentClientExt` trait 在作用域),agent 用
   `tool_server_handle` 共享工具集;流式接口 `stream_prompt`/`stream_chat`
   返回 `StreamingPromptRequest`,需 `.await` 后才得到 `Stream`。
   **配置与 crush 对齐**(`config.rs`):`[providers.<id>]` 内嵌多 API key
   (type/api_key/base_url/default_large_model_id,`$ENV` 运行时展开)、
   `[models.large|small]` 引用(provider/model/reasoning_effort/max_tokens,
   未显式设 provider/model 时回退到 models.large)、`[mcp.<name>]`
   (type=stdio|http,command/args/url,**可多个**,`mcp.rs::connect_many`
   经 rig ToolServer 注册,单个失败按 `skip_missing` 跳过)、
   `[lsp.<lang>]`(command/args/env,`lsp list` 检测可执行状态)、
   `skills_paths`/`disabled_skills`(与 crush 同目录约定:每 skill 一目录
   含 `SKILL.md`,frontmatter 的 description 解析后注入 preamble,
   `skills.rs::discover`,默认扫 `~/.config/crush/skills` 等)。
   provider 查找顺序:`config.providers` map → crush.json 的 `providers`
   (真实 key 所在,`providers.rs::load_crush_json_providers`)→
   `~/.local/share/crush/providers.json` → 内置;配置未写
   `default_large_model_id` 时从 crush providers.json 合并默认模型。

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

## 远端 Web / 移动端支持

combo 支持前后端分离部署:proxy 只当 API 服务,前端(dist/)部署到任意静态托管
(nginx/Vercel 等),浏览器/手机通过 `VITE_PROXY_URL`(构建期)或「设置」里的
**运行时代理地址覆盖**(`localStorage["combo.proxyUrl"]`,见 `connection.ts`
`get/set/clearProxyUrlOverride`)指向远端 proxy。`resolveProxyBaseUrl` 优先级:
运行时覆盖 → `VITE_PROXY_URL` → Tauri 内置端口 → `127.0.0.1:18234`。SSE 与
health 都走同一 base,跨域由 CORS 放开。

- **CORS**:proxy `--origin` 白名单;未传时读 `COMBO_CORS_ORIGINS`(逗号分隔)
  环境变量,两者都缺省则全开放(见 `main.rs`)。
- **服务器目录浏览**(`host.rs`,`/v1/host/*`):`GET /v1/host/home` 返回缺省起点
  (HOME 或浏览根),`GET /v1/host/dirs?path=<绝对路径>` 列出单层子目录
  (过滤隐藏项,dir 在前)。只读;`--browse-root` / `COMBO_BROWSE_ROOT` 可限制
  浏览范围,越界 403。前端 `listHostDirs` + `DirectoryPicker`(目录点选 +
  手动路径兜底)接管浏览器/移动端「添加项目」「更换目录」流程;桌面端仍走
  Tauri 原生目录对话框。
- **移动端适配**:`useIsMobile`(<768px)驱动 AppShell 侧边栏变为全屏抽屉
  (遮罩 + 顶栏按钮开关,进入移动端自动收起,选中项目/会话后自动关闭);
  分隔条与后退/前进在移动端隐藏;终端/编辑器已是全内容区切换。触屏下
  悬停才显示的操作(重命名笔、右键菜单)改为 `md:` 前缀常驻 + 行内
  `⋯`(MoreHorizontal)按钮打开同一上下文菜单(桌面右键行为不变)。
- **访问令牌(远程连接鉴权)**:移动端扫码远程访问时由 proxy 强制校验令牌。
  桌面端打开「移动端远程控制」(`MobileConnectDialog`)时调
  `POST /v1/auth/token` 生成新令牌(默认 7 天有效),令牌嵌入二维码 URL
  (`?token=<xxx>`)。手机扫码打开前端页面后,`main.tsx` 调
  `extractTokenFromUrl` 从 URL 提取令牌存入 localStorage(`combo.token`)并
  从地址栏移除。此后每个请求自动携带:`apiRequest`/SSE 走
  `Authorization: Bearer <token>` header,终端 WebSocket 走 `?token=` query
  (浏览器 WebSocket 不能设 header)。后端鉴权中间件
  (`auth::require_token`,axum `from_fn_with_state`,在 router CORS 之内、
  `with_state` 之前)对**非回环、非公开端点**的请求强制校验:本地回环
  (127.0.0.1/::1,通过 `into_make_service_with_connect_info` 注入的
  `ConnectInfo<SocketAddr>` 判定)和公开端点(`/v1/health`、`/v1/auth/*`)放行,
  其余无有效令牌返回 401。令牌落盘 sqlite `access_tokens` 表(`db.rs`,
  支持撤销/过期/记录最后使用时间),刷新令牌时撤销旧令牌。令牌明文由
  `/dev/urandom` 生成 32 字节 hex(64 字符),不可用时回退到时间+pid 哈希。
- **域名远程访问**:`connection.ts` 的 `getExternalUrl`/`setExternalUrl`/
  `clearExternalUrl`(localStorage `combo.externalUrl`)管理外部访问域名。
  在「设置」对话框中配置(如 `https://combo.example.com`),`MobileConnectDialog`
  二维码优先使用该域名作为基础地址;未配置时回退到 `window.location`(仅限
  局域网)。配置域名后手机扫码即可通过公网/域名访问,无需额外设置代理地址。
  Proxy 监听地址可通过 `COMBO_HOST` 环境变量(或 `--host` 参数)指定,域名部署时
  设 `0.0.0.0`。
