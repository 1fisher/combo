# AGENTS.md

> **查询优先级**:本仓库已接入 codebase-memory MCP。定位符号、查调用关系、
> 找定义/引用、了解架构等,**优先使用 `mcp_codebase-memory_*` 工具**
> (`search_graph` / `get_code_snippet` / `trace_path` / `get_architecture` /
> `query_graph` / `search_code`),而非直接 grep/读大文件。项目名传 `combo`。

## What this is

**combo** is an Agent IDE desktop app: a Tauri v2 shell + React 19/TypeScript
frontend backed directly by **combo-cli serve**(自研 agent 服务,进程内 axum)。
原 combo-proxy 反向代理 crate 已删除,combo-cli serve 直接承担全部职责。All UI copy,
code comments, and the README are in **Chinese** — keep new UI strings and comments
in Chinese to match.

```
Tauri Webview (React/TS)
   fetch / EventSource ──→ http://127.0.0.1:<random-port>/v1/*
                              │ combo-cli serve (crates/combo-cli, 进程内 axum,
                              │   REST + 双层 SSE + CORS + 令牌鉴权 + 文件/git/终端/隧道)
                              ▼
               rig agent(多 provider:deepseek/opencode-zen/zhipu/...)
```

Three components, three languages/dirs:

- **`crates/combo-cli`** (Rust, axum + rig) — combo 完整后端(库 + 二进制)。
  `serve_listener`(`serve.rs`)提供 `/v1/*` 全部端点:agent 运行 + 双层 SSE 事件流、
  workspace/session sqlite 镜像(`store.rs`/`meta.rs`/`workspace.rs`/`session.rs`)、
  受限文件读写(`fs.rs`,仅 `/v1/workspaces/:id/files/*`,canonicalize 前缀校验对
  workspace 根)、git(`git.rs`)、令牌鉴权(`auth.rs`)、服务器目录浏览(`host.rs`)、
  终端 WS(`terminal.rs`)、隧道(`relay.rs` + `tunnel.rs`)、skills(`skills_api.rs`)、
  技能注入(`skills.rs`)。`AppState::new(cfg)` 打开默认 MetaStore 并迁移 crush 数据;
  `reconcile_all` 已并入构造函数。
- **`src-tauri`** (Rust, Tauri v2) — thin shell. `init_backend` in `src/lib.rs`
  加载 combo 配置、构造 `combo_cli::serve::AppState`、绑定 `127.0.0.1:18236`
  (被占用自动 +1,与独立 serve 行为一致)、spawn `serve_listener`(同进程内嵌,无子进程)。
  端口经 Tauri events `proxy-ready` (`{port}`) 与 `rune-status` (`{connected}`) 推给前端。
  **系统托盘**(`src/tray.rs`,macOS/Windows,tauri features `tray-icon`+`image-png`):
  右键菜单[新建任务/退出 Combo],左键点击切换主窗口显隐;
  「新建任务」先唤起窗口再 emit `tray-new-task`,`WorkspaceSidebar` 监听后复用
  `onNewTaskRef`(与 ⌘N 同路径);主窗口「关闭」被拦截为隐藏到托盘,真正退出走
  托盘菜单(macOS 另处理 `RunEvent::Reopen`,Dock 图标点击可重新显示窗口)。
- **`src/`** (React 19 + Vite + TS, shadcn/ui) — the frontend. TanStack Query
  for REST data, **Zustand** (`stores/agentStore.ts`) for SSE-driven live state,
  keyed by `sessionId`.

The frontend never talks to Tauri APIs for data (`src/lib/connection.ts` detects
Tauri via `'__TAURI_INTERNALS__' in window`), so the whole app is developable in a
plain browser. M1 directory picking is a path input, not a native dialog.

## Commands

```bash
npm run dev                 # Vite dev server, strict port 5173 (browser mode)
bash scripts/dev-proxy.sh   # = VITE_PROXY_URL=http://127.0.0.1:18236 npm run dev
npm run build               # tsc -b && vite build (production build, outputs dist/)
npm run tsc                 # tsc -b (project references: tsconfig.app.json + tsconfig.node.json)
npm test                    # vitest run (jsdom; config lives inside vite.config.ts)
npm run test:e2e            # Playwright; SKIPS itself unless COMBO_CLI_BIN is set
npm run gen:api             # regenerate src/lib/api/types.ts from swagger/swagger.json
cargo run -p combo-cli -- serve --port 18236                # 后端独立运行(combo 全部 API;默认 18236,被占用自动 +1)
bash scripts/dev-backend.sh    # 一步:编译 combo-cli → serve 模式跑在 :18236(可传参)
cargo run -p combo-cli -- ask "你好"                          # 自有 agent CLI(rig 驱动)
make install                   # 安装 `combo` 命令到 ~/.cargo/bin,之后全局可用 `combo ask/serve/...`
cargo test -p combo-cli     # combo-cli 单元测试
cargo test -p combo         # src-tauri 单元测试
```

> **combo-cli serve 就是唯一的后端。** 无反向代理、无多后端选项。serve 实现
> rune 兼容协议(`/v1/workspaces/{id}/agent` + 双层 SSE events + cancel +
> current-session/permissions stub);会话与历史由 serve 自己的 sqlite 镜像
> (`store.rs`)负责,多轮上下文由 `run_agent_ws` 从
> `state.meta.db().list_messages(ws_id, session_id)` 读历史注入
> (`serve.rs::history_to_messages`);工具自动执行、无权限拦截。
> **消息持久化在服务端**:`run_agent_ws` 直接把用户消息、工具结果与
> assistant 快照(节流 ~1.5s + 最终版)upsert 进 sqlite,前端不再经 SSE 回写。
> **多会话并发**:`RunState.active`(session_id → {ws_id, run_id})跟踪进行中
> 的 run——同一 session 并发发起返回 409,跨 workspace/session 完全并发;
> run 启动/结束广播 `session` 事件(含 `is_busy` 与 `run_id`),`RunGuard`
> 的 Drop 保证任意退出路径(含 panic)释放 busy;SSE 订阅建立时补发该
> workspace 的 busy 快照;`GET .../sessions` 列表带 `is_busy`,前端
> (`useSessions::reconcileRunsFromSessions` + `useWorkspaceEvents`)据此
> 恢复/收敛运行态,修复「切走再切回时 run 永远转圈、无法再次发起」。
> 历史版本写入的 `backend=crush` / `backend=combo-cli` workspace 会在
> `AppState::new` 时自动归一化迁移(`workspace.rs::reconcile_all`)。

**Browser dev workflow (recommended):** terminal 1 `bash scripts/dev-proxy.sh`,
terminal 2 `bash scripts/dev-backend.sh`(一步编译 combo-cli 并以 serve 模式跑在
:18236,等价于 `cargo build -p combo-cli` 后运行 `target/debug/combo serve
--port 18236`),then open http://localhost:5173.

**Tauri desktop mode:** the README says `npm run tauri dev`, but **that does not
work out of the box** — there is no `tauri` npm script and `@tauri-apps/cli` is not
installed. You need the Tauri CLI from the Rust toolchain (`cargo tauri dev`) or to
install `@tauri-apps/cli` first. `bundle.active` is `false` in
`src-tauri/tauri.conf.json`, so packaging is not set up.

### Env vars

| Var | Meaning |
|---|---|
| `COMBO_IT_DIR` | E2E workspace directory (default `/tmp/combo-e2e`). |
| `COMBO_DATA_DIR` | combo 数据目录(默认与配置目录同为 `~/.config/combo`;macOS/Linux 一致,不再用 `~/.local/share/combo`)。combo.db、combo-cli.db、providers.json、logs 都在此目录;启动时自动把旧 `~/.local/share/combo` 的内容迁移过来。 |
| `VITE_PROXY_URL` | Proxy base URL for browser mode (e.g. `http://127.0.0.1:18236`). combo-cli serve 默认监听 18236,被占用自动 +1;Tauri 模式取内嵌 serve 事件端口;连接失败时前端自动扫描本机 18236+ 端口匹配 combo-cli。 |
| `COMBO_HOST` | serve 监听地址(默认 `127.0.0.1`)。域名部署时设 `0.0.0.0` 对外开放;命令行 `--host` 优先级更高。 |
| `COMBO_CLI_BIN` | E2E 开关:设置后 Playwright spec 才运行(验证真实 agent 工作流)。 |
| `COMBO_CONFIG_DIR` | combo-cli 配置文件目录(默认 `~/.config/combo`,文件 `combo-cli.toml`)。未设 `COMBO_DATA_DIR` 时数据文件也落在此目录。 |
| `COMBO_SKILLS_DIR` | 覆盖 combo 专属技能目录(默认 `~/.config/combo/skills`)。技能扫描共四个目录,项目级优先:项目 `.combo/skills`、项目 `.agents/skills`、combo 专属、通用 `~/.agents/skills`,同名 skill 靠前的路径优先。 |

## Architecture & data flow

- **Token 用量记录与手动压缩(compact)**:token 计数全部来自 **rig 原生 usage**
  (`GetTokenUsage`,多轮工具循环中每次 completion 调用各自上报,serve 用 rig
  `Usage` 的 `AddAssign` 累计整轮消耗)。`agent.rs::RunUsage` 同时携带最后一次
  调用(input+output ≈ 当前上下文占用)与 run 累计(total_input/total_output);
  finish part 与 `run_complete` 的 `usage` JSON 内嵌两者(`input_tokens`/
  `output_tokens` + `total_*_tokens`,wire 向后兼容)。run 结束时 serve 把两项
  落库到 sqlite `conversations` 行:`context_tokens`(rig 上报的当前上下文占用,
  由 `add_usage` 覆盖写入)与 `context_window`(本次所用模型的窗口大小,
  `store.rs::set_context_window`;rig 的 openai 兼容客户端不提供模型窗口元数据,
  按 `compact.rs::context_window` 的 provider 模型列表(含手动覆盖)→ 内置定义
  → 128k 默认解析),`GET .../sessions` 列表 JSON 一并回传。**上下文压缩只手动
  触发**:run 启动不再自动压缩(`start_agent_run` 原「3.5 自动压缩」已删),
  由 agent 按需调用 `compact` 工具——工具用 rig `TokenWindowMemory` +
  `HeuristicTokenCounter`(`compact.rs::plan_compaction`)逐消息统计 token
  (中文按 3 字节/token 保守估算,parts 全部内容含 tool_call/tool_result 计入),
  预算 = context_window×0.75 − 5000 固定开销,从最新往旧累计、预算耗尽处切分,
  超出预算的前缀总结为摘要并删除;压缩完成后 `set_context_tokens` 重置占用;
  摘要消息 `created_at` 取"保留尾部第一条消息时间戳-1",保证 `list_messages`
  (按 created_at 升序)中摘要在最近消息之前、注入 LLM 的历史顺序正确。
  **context_window 的单一来源是 combo-cli 配置**:设置界面「上下文窗口(手动)」
  经 `POST /v1/providers/context-window` 写入配置
  `[providers.<id>].context_windows`(`config.rs::set_model_context_window`,
  `providers::apply_context_windows` 在 `workspace_effective_cfg`/
  `list_providers`/`find_provider` 统一应用,models JSON 额外回传
  `context_window_override` 原始覆盖值),与前端 Composer 用量环共用同一份值。
- **File service** (`crates/combo-cli/src/fs.rs`): `GET .../files/list?path=`
  lists one directory (hidden files skipped, dirs first), `GET .../files/content`
  reads text (≤1MB, binary rejected), `PUT .../files/content` writes atomically.
  `path` must be relative; serve resolves the workspace root from sqlite
  `MetaStore`. Frontend: `src/lib/api` wrappers +
  `stores/editorStore.ts` + `FileExplorer`/`EditorPane`.
- **Sqlite 持久化** (`crates/combo-cli/src/store.rs`): combo 自有元数据落盘在
  sqlite(默认 `~/.config/combo/combo.db`,与配置同目录,`COMBO_DATA_DIR` 可覆盖;
  首次启动自动从旧 `~/.local/share/combo` 迁移,见 `paths.rs`)。
  表 `workspaces`(项目元数据,含可重命名的 `name`)与 `conversations`
  (会话的本地镜像)。`MetaStore` (`meta.rs`)是 sqlite-backed:
  `WorkspaceMeta.name` 创建时默认取目录 basename,`PATCH /v1/workspaces/{id}`
  可重命名并跨重启保留。**Session** (`session.rs`)本地接管
  `GET/POST/DELETE /v1/workspaces/{id}/sessions`:创建/删除/列表全部直接在
  sqlite 操作,不依赖后端在线。会话列表在左侧显示 `name`(不再是完整路径),
  hover 出现铅笔按钮可重命名。
- **敏感目录访问授权(只询问一次)** (`dirperm.rs` + `store.rs` 表 `dir_grants`):
  创建项目 / 更换绑定目录时,若目录位于敏感位置(macOS TCC 保护域:
  `~/Desktop`/`~/Documents`/`~/Downloads`、`~/Library/Mobile Documents`(iCloud)、
  `/Volumes/*` 外置卷/移动硬盘),且 sqlite `dir_grants` 没有覆盖该路径的授权,
  `workspace::create`/`rename` 返回 403 `{code: "dir_permission_required", path}`
  (路径全部 **词法规范化**,不 `canonicalize`——避免检查本身触碰磁盘提前触发
  系统 TCC 弹窗;mac/win 大小写不敏感比较)。前端 `useDirPermission` hook 捕获
  该错误弹「允许访问该目录?」(`DirPermissionDialog`),「允许」→
  `POST /v1/dir-grants` 持久记住并自动重试原请求(仅重试一次);已授权目录
  (含子目录,祖先前缀覆盖)永不再问。REST:`GET/POST /v1/dir-grants`、
  `DELETE /v1/dir-grants/:id`;设置弹窗「目录访问授权」区可查看/撤销。
  存量旧项目不受影响(无启动期回溯检查);`src-tauri/Info.plist` 提供
  NSDocuments/RemovableVolumes 等 macOS 隐私用途声明文案(打包时与 Tauri
  自动生成的 Info.plist 合并)。
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
  must ALSO put `client_id` in the request body — the backend validates it from
  the body, not the query string. SSE subscription also passes it as a query param.
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
  `run_complete` sets the run to `done`(`dispatch.ts` 会按 run_id 忽略过期
  run 的收尾事件);serve 侧同一 session 的并发 POST 返回 409。运行态跨
  workspace 切换自愈:`session` 事件的 `is_busy`(启动携带 `run_id`,SSE
  订阅时 serve 补发快照)恢复 running,`useSessions` 的
  `reconcileRunsFromSessions` 依据列表 `is_busy=false` 收敛卡死的 running。
  Note: `MessageVM.streaming` is set to `true` on every upsert and never
  flipped back — completion is signaled by run status, not message flags.
  消息持久化由 serve 在运行时直接落库;`hydrateMessages` 按 id+updatedAt
  跳过无变化的重放(仅比 id 会漏掉「服务端收尾后的内容刷新」)。
- **serve gotchas** (`crates/combo-cli/src/serve.rs`): CORS 由 `build_router` 的
  `CorsLayer` 处理,`allowed_origins` 为空则全开放(独立 `serve` 模式);
  Tauri 模式传 `tauri://localhost` 和 `http://localhost:5173`。
- **模型选择按 workspace 隔离(不联动)**:`POST .../config/model` 把
  provider/model/推理强度写入 sqlite `workspace_config.model` 列
  (`store.rs::WorkspaceModel`),仅对该项目生效、跨重启保留;`agent_info` 与
  `run_agent_ws` 经 `serve.rs::workspace_effective_cfg` 解析「全局默认 +
  该 workspace 记忆」的生效配置,未单独设置的项目回落 `state.cfg` 全局默认。
  切换某项目模型不再改写全局,并发 run 各自快照互不影响。前端
  `agentStore.modelSelections` 本就按 workspace 键控持久化,与服务端双份记忆。

## Code organization & conventions

- **Rust:** module-per-concern under `crates/combo-cli/src/` (`serve`, `agent`,
  `automation`, `store`, `meta`, `workspace`, `session`, `auth`, `fs`, `git`,
  `host`, `terminal`, `relay`, `tunnel`, `skills`, `skills_api`, `graph`), `pub` API
  re-exported from `lib.rs`(`AppState` / `run` / `serve_listener`)。Workspace root
  `Cargo.toml` has members `crates/combo-cli`, `crates/combo-relay` and `src-tauri`.
- **自动化(定时任务)** (`crates/combo-cli/src/automation.rs`):combo 后台定时
  触发 agent 运行。调度模型四种:`once`(一次性 run_at)、`interval`(每
  every_seconds 秒)、`daily`(每天 HH:MM)、`weekly`(每周 weekday=1周一..7周日
  HH:MM),`Schedule::next_after` 基于 chrono::Local 计算下一次触发,不引入 cron
  依赖。`AutomationScheduler` 挂在 `AppState.automations`,serve_listener 启动时
  `start(state.clone())`,后台每 15 秒 `tick` 扫描 sqlite 中
  `enabled AND next_run_at <= now` 的任务;到期后在目标 workspace 新建会话
  (标题 `⏰ {任务名}`)并复用 `serve::start_agent_run` 发起 agent 运行,运行结束
  经完成回调把结果写入 `automation_runs` 表并更新任务 `last_status`
  (success/error/cancelled/skipped)。REST 端点:
  `GET/POST /v1/automations`、`GET/PATCH/DELETE /v1/automations/:id`、
  `POST /v1/automations/:id/run`(手动触发,不推进排期)、
  `GET /v1/automations/:id/runs`(历史)。sqlite 表 `automations` +
  `automation_runs`(见 `store.rs`),删除项目时 `workspace::delete` 级联清理。
  前端 `AutomationPanel.tsx`(侧边栏「自动化」按钮打开)作为**主内容区视图**(与
  会话/终端/编辑器同级,非 Dialog;顶栏有自动化切换按钮,点击侧边栏「自动化」
  或顶栏图标在 agent ↔ automation 视图间切换)三视图:列表(启用开关/
  立即运行/历史/编辑/删除)/ 表单(名称/目标项目/提示词/调度类型)/ 运行历史。
- **项目知识图谱**(`graph.rs` + `GraphView.tsx`,侧边栏「图谱」按钮):`GET
  /v1/workspaces/:id/graph` 扫描 workspace 源码(上限 2500 文件,跳过
  node_modules/target 等目录与隐藏目录),启发式正则解析文件间 import 依赖
  (TS/JS 相对路径与 `@/` 别名、Python 相对/绝对 import、Rust `use crate::`/
  `mod x;`、Go 按 `go.mod` module 前缀、C/C++ `#include "..."`),返回文件级
  依赖图(nodes/edges)+ 外部依赖聚合(裸包名计数,top 100)+ 语言/行数/定义数
  统计;`spawn_blocking` 跑扫描,解析为 `Resolution::{Internal,External,None}`。
  前端 `GraphView`(lazy 全页视图,AppView=`'graph'`)用 `d3-force` 力导向布局 +
  canvas 渲染:节点按语言着色、大小随连接度,支持缩放/平移/拖拽节点/hover 高亮
  邻居/点选查看详情(依赖/被依赖/外部依赖,可跳编辑器打开文件)、搜索高亮、
  目录过滤、「仅看有依赖的文件」开关。注意 canvas 的 `setPointerCapture` 需要
  try-catch(合成事件下 pointerId 未激活会抛 NotFoundError 打断整个交互)。
- **serve run 公共入口**:`serve::start_agent_run(state, ws_id, req, on_finish)`
  是发起一次 agent 运行的唯一入口(HTTP handler `run_agent_ws` 与自动化调度器
  共用)。`on_finish: Option<AgentFinishCallback>` 在后台 run 真正结束时调用
  (reason: end_turn|cancelled|error + 友好错误文案),自动化任务据此落运行结果;
  普通对话传 None。
- **本地语音识别(`asr.rs`,Composer 语音输入)**:输入框话筒按钮的听写服务,
  完全本地离线。**模型可选**(`AsrModel`,配置 `[asr] model` 或设置界面
  「语音识别模型」切换,`POST /v1/transcribe/model` 运行时切换并写入配置
  跨重启保留;模型文件按 id 隔离在 `<数据目录>/models/<id>/`;默认
  `sense-voice`):
  - `sense-voice`(中文):阿里 SenseVoice-small int8(~230MB),中英日韩粤
    多语,自带标点与数字规整(ITN);
  - `moonshine-zh`(中文):Moonshine v2 base 中文量化版(~135MB,
    `encoder_model.ort` + `decoder_model_merged.ort` .ort 格式,中英双语,
    需 `modeling_unit="cjkchar"`);
  - `moonshine-en`(英文):Moonshine v2 base 英文量化版(仅英文)。
  依赖为**官方 `sherpa-onnx` crate**(v1.13.5,k2-fsa 官方 Rust 封装,替代已
  弃用的 thewh1teagle/sherpa-rs;静态链接 `features=static`,构建时从 GitHub
  release 下载预编译库——**网络受限时需设 HTTP(S)_PROXY**)。各模型均为
  **离线(非流式)识别器**,边说边出字由服务端「能量 VAD 分段 + 周期性
  重解码当前段」模拟(`Segmenter`:30ms 帧 RMS<0.01 判静音,尾部静音 ≥1.2s
  固化该段并重置缓冲,单段上限 28s 强制切分,解码时尾部静音最多保留 0.3s
  防幻觉;partial 每累计 1s 新音频重解码一次);解码经共享识别器互斥锁串行,
  多连接安全。切换模型时清空已加载识别器并回到未就绪(与进行中的下载/加载
  互斥,经 `prepare_lock` 串行),下次使用自动下载新模型。REST:
  `GET /v1/transcribe/status`(模型阶段 not_ready/downloading/loading/
  ready/failed + 下载进度 + 当前 `model`)、`POST /v1/transcribe/prepare`
  (幂等触发下载/加载,后台执行)、`POST /v1/transcribe/model`(切换模型,
  非法 id 400)、`POST /v1/transcribe?sample_rate=16000`(整段转写,请求体为
  16kHz 单声道 PCM16 小端原始字节,内部按静音分段解码后拼接,响应
  `{text,lang}`;模型未就绪 503 code=asr_not_ready;body limit 32MB)、
  `GET /v1/transcribe/stream`(**WebSocket 流式听写**:客户端持续推 PCM16
  二进制帧,服务端回发 `{"type":"partial","text":..,"finalized":..}` 增量
  (`text` 为累计文本 = 已固化分段 + 当前段推断,`finalized` 为已固化前缀,
  单调增长;分段收尾重解码裁剪推断尾巴时也会下发,前端据此稳定保留确认
  文字、只修正推断尾巴);发 `{"type":"finish"}` 后回 `{"type":"final"}`
  并关闭;`?token=` 传远程令牌,同终端 WS)。模型文件缺失
  时自动从 sherpa-onnx release 下载(`COMBO_ASR_MODEL_URL` 可换镜像),解压到
  模型子目录,懒加载一次常驻(`AppState.asr`,解码在 spawn_blocking 中执行)。
  **音频采集与 PCM 转换在前端**:`useDictation`(`src/hooks/useDictation.ts`)
  用 AudioWorklet(inline Blob,`combo-pcm-collector`)以 16kHz 直接采集、
  降混、聚帧(~100ms)成 PCM16,经 `src/lib/asrStream.ts` 的 `AsrStream`
  WebSocket 直发;首录模型未就绪时音频在客户端缓冲(≤5min),就绪后自动建连
  并补发,下载与录音并行。状态机 idle/recording/transcribing(10min 上限),
  识别文本以「预输入」方式实时拼进输入框末尾(`useDictation` 的 `confirmedText`/
  `partialText` 分开维护,不写入受控 value;停止后 final 经 `appendTranscript`
  正式追加;录音中手动编辑输入框会经 `cancel` 放弃识别)。**已确认(分段固化)
  文本单调稳定、说话中不会消失,推断部分随重解码就地修正,分段收尾回缩时
  保留旧推断待下一段替换**(`mergeDictationTail` 合并,类似输入法组合动画);
  Composer 听写时渲染镜像层区分确认(实色)/推断(半透明斜体)文本。
  开启/关闭录音有 Web Audio 合成的提示音(上扬/下抑双音,`audio.ts` 的
  `playDictationChime`;开启音在点击手势内同步播放以解锁 autoplay 策略,
  关闭音在收尾时播放,自动取消不播)。
  最终文本经 `appendTranscript` 追加进输入框(中英边界智能补空格)。macOS
  麦克风权限声明在 `src-tauri/Info.plist`(`NSMicrophoneUsageDescription`)。
  **注意 TCC 权限的两道门槛**:① hardened runtime 应用必须带
  `com.apple.security.device.audio-input` entitlement(见
  `src-tauri/entitlements.plist`,tauri.conf.json `bundle.macOS.entitlements`
  引用)——缺失时 macOS **静默拒绝**麦克风,不弹授权框、系统设置列表也不显示
  应用(tccd 日志: "requires entitlement com.apple.security.device.audio-input
  but it is missing ... Policy disallows prompt ... denied");② macOS 按「代码
  签名身份」记录隐私权限,ad-hoc 签名(`signingIdentity "-"`)每次构建 CDHash
  都变,TCC 视为新应用、列表不显示。根治靠 Developer ID 签名(稳定
  designated requirement):release.yml 已按 secrets 是否配置自动启用
  「Developer ID 签名 + 公证」(需在 GitHub 配置
  APPLE_CERTIFICATE/APPLE_CERTIFICATE_PASSWORD/APPLE_SIGNING_IDENTITY/
  APPLE_ID/APPLE_PASSWORD/APPLE_TEAM_ID 六项,见 CI 注释)。排查/重置命令:
  `sudo tccutil reset Microphone dev.combo.ide && sudo killall tccd` 后重启应用。
  本地开发可 `bash scripts/macos-sign-dev.sh`(自动建自签名证书并带 entitlement
  重签 Combo.app,身份稳定,TCC 列表可正常显示;每次重新构建后重跑一次)。
- **本地语音合成(TTS,`tts.rs`,朗读 agent 回复)**:与 ASR 对称的语音输出。
  配置 `[tts] enabled`(开关,默认关)+ `[tts] model`(默认 `piper-zh-xiaoya`;
  可选 `piper-zh-chaowen`/`vits-zh-fanchen-c`)。模型为 k2-fsa/sherpa-onnx
  `tts-models` release 资产(piper 中文 int8 各 ~14MB、HF 高质量 ~113MB),
  与 ASR 共用 `<数据目录>/models/<id>/` 下载/解压/懒加载流程
  (`COMBO_TTS_MODEL_URL` 可换镜像);加载配置统一为
  `model=*.onnx + tokens=tokens.txt + lexicon=lexicon.txt + rule_fsts=
  phone.fst,date.fst,number.fst`(fst 在模型根目录,fanchen-C 多说话人用
  `sid=100`),合成结果封装 44 字节 WAV 头(PCM16)返回。**拉丁文本本地化**:
  中文 TTS 模型是 char 级词库,英文字母/英文词直接合成会被当作 OOV 静默丢弃
  (sherpa-onnx 日志 `Ignore OOV 'Combo'`),合成前 `localize_latin_text` 把
  拉丁字母串逐字母转成中文读音(如 `Combo`→`西 欧 艾姆 比 欧`),保证英文
  词/标识符可完整念出(数字与符号保留,由 rule_fsts 处理)。端点:
  `GET /v1/speech/status`(开关 + 模型 + 下载/加载阶段 + 进度 + 语速)、
  `POST /v1/speech/prepare`(幂等触发下载/加载,后台执行,镜像
  `/v1/transcribe/prepare`)、
  `POST /v1/speech/config`(`{enabled}`,写 `[tts] enabled`)、
  `POST /v1/speech/speed`(`{speed}`,语速倍率 0.5~2.0,写 `[tts] speed`,
  越界 400;运行时经 `TtsService::set_speed` 生效,合成时传入
  `GenerationConfig.speed`——piper 直接用,vits 由 sherpa-onnx 内部映射
  `length_scale=1/speed`)、
  `POST /v1/speech/model`(切模型并持久化)、`POST /v1/speech`(单句文本 →
  `audio/wav`;关闭时 400 `tts_disabled`,未就绪 503 `tts_not_ready`,
  超 500 字符 400 `tts_text_invalid`)、`POST /v1/speech/test`(试听:
  与正式合成共用 `synthesize_impl`,唯一区别是**不要求朗读开关打开**,
  供设置区「试听」按钮预览音色)。**模型下载进度前端展示**:
  首次合成未就绪时后端后台触发下载并立即 503(不阻塞请求,避免下载期间
  挂起 30s 合成超时);前端 `useSpeechOutput` 捕获 `tts_not_ready` 后轮询
  status(镜像 `useDictation::ensureModelReady`;共用
  `src/lib/speech.ts::waitSpeechModelReady`:not_ready/failed 触发
  prepare,downloading 更新进度,onProgress 回调进度),把 `modelProgress`(0~1)返回
  `AppShellInner` 在顶栏显示「朗读模型 NN%」,就绪后重试该句;设置
  `TtsSection` 提供「立即下载」按钮 + 进度条(模型未就绪或缓存状态与所选
  模型不一致时持续轮询,downloading/loading 1s、其余 1.5s,就绪即停;本地
  无模型直接显示下载按钮,下载失败显示错误文案 + 「重新下载」按钮,切换
  模型后 invalidate 状态查询刷新),模型下拉旁有「试听」按钮:未就绪先经
  `waitSpeechModelReady` 触发下载并等就绪,再经 `synthesizeSpeechTest`
  (`POST /v1/speech/test`)合成测试句播放,不受朗读开关影响。前端 `useSpeechOutput`
  (`src/hooks/useSpeechOutput.ts`,挂 `AppShellInner`)订阅 agentStore 当前
  会话 assistant **text part** 文本增量(只读本次 run 的增量:run 开始时把
  已有消息全部标记已消费,避免朗读历史),按句末标点/换行断句(代码块围栏
  内容跳过、围栏状态跨增量保留,`src/lib/ttsSplit.ts` 纯函数,单句 >100 字符
  强制切),完整句子经 `synthesizeSpeech` 合成后 `AudioContext` FIFO 顺序
  播放;打断(新发消息/切会话/关开关/run 出错)停播 + 清缓冲。设置界面
  `TtsSection`(开关 + 模型下拉,开关写 `[tts] enabled` 并联动朗读 hook)。
- **Frontend layout:** `src/components/{ui,shell,agent}` — `ui/` is generated
  shadcn primitives, `shell/` is app chrome, `agent/` is the chat/tool/modal UI.
  The shell is a 1:1 仿写 ZCode 的 agent 布局:左侧 `WorkspaceSidebar`(默认 372px,
  可拖拽调宽/收起,含 新建任务/搜索/自动化/技能 按钮、「分组/项目」视图切换、
  「项目/任务/文件」可折叠分区、底部用户与连接状态) + 可拖拽分隔条 + 主内容区
  (顶栏帮助/终端按钮;无会话时显示 `ChatEmptyState` 问候语 + 订阅横幅 + 模板卡片,
  会话中显示消息列表,底部为 ZCode 风格 `Composer` 输入坞:项目 chip + 工具栏
  [添加上下文/模式/用量环/Provider/模型/思考等级/发送;Provider 切换后模型列表按该
  Provider 过滤,并自动选用其默认大模型])。`index.html` 固定 `class="dark"`,
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
  captured real SSE envelopes through `applyEvent`. Store and component tests
  assert against the Zustand store directly. **`src/test-setup.ts`** polyfills
  `localStorage` (jsdom 25 + Node 26 下 getter 失效)和 `ResizeObserver`
  (radix ScrollArea 依赖),并在每个测试前清空持久化状态,所有 Vitest 测试共用。
- **Rust:** in-module `#[cfg(test)]` units (dedicated `AppState::test_state(meta,
  browse_root)` in `serve.rs` for handler tests in `auth.rs` / `host.rs` / `fs.rs`
  etc.; sqlite 用 in-memory `ComboDb`/`MetaStore`,不落盘)。`cargo test -p combo-cli`
  跑全部单元测试(70+ 项)。
- **E2E (Playwright):** `playwright.config.ts` `webServer` auto-starts both Vite
  (`bash scripts/dev-proxy.sh`) and the backend (`bash scripts/dev-backend.sh
  18236`,即 `combo-cli serve`) with `reuseExistingServer: true`. The spec skips
  itself unless `COMBO_CLI_BIN` is set. It **wipes the workspace dir
  (`/tmp/combo-e2e`) before running**.
  Selectors rely on Chinese UI text (e.g. button `添加项目`, `发送`, title `新建会话`);
  项目在左侧以 basename 显示,会话列表在中间(`ConversationList`)。「添加项目」在
  桌面模式弹原生目录对话框,浏览器模式仅提示;e2e 改为经 API 创建工作区.

## Gotchas summary

0. **combo-cli**(`crates/combo-cli`)是自有 agent CLI:基于 rig 0.41,
   **provider 结构为 JSON 数组格式**(`providers.rs` 的
   `ProviderInfo`/`ModelInfo`,字段:id/name/api_key/api_endpoint/type/
   default_large_model_id/default_small_model_id/models)。`--provider` 按 id
   解析,**查找顺序:配置文件内嵌 providers 数组(`config.rs` 的
   `providers` 字段)→ `~/.config/combo/providers.json`
   (`providers.rs::load_combo_providers`,`COMBO_DATA_DIR` 可覆盖)→ 内置
   定义(`providers.rs::builtin_providers`)**,支持 40 个 provider
   (opencode-zen/opencode-go/zai/deepseek/xai/zhipu/…)。`api_key`/`api_endpoint`
   支持 `$ENV_VAR` 运行时展开(`providers.rs::expand_env`);agent 按
   `type` 分派:anthropic→rig anthropic client、google→gemini、
   其余(openai/openai-compat/azure…)→`openai::CompletionsClient` builder
   (自定义 endpoint)。**opencode-zen**(内置定义:
   `https://opencode.ai/zen/v1`,默认模型 `deepseek-v4-flash-free`):key
   从 `~/.local/share/opencode/auth.json` 的 `opencode` 条目自动回退
   (id 为 opencode 或 opencode-zen 时,见 `agent.rs::AskConfig::api_key`),
   或 `combo-cli config import` 一键导入到 combo 配置(provider=opencode)。
   子命令:
   `ask`(单轮流式)、`chat`(交互多轮流式,历史
   持久化 `COMBO_DATA_DIR`/`~/.config/combo/combo-cli.db`,表
   `cli_conversations`/`cli_messages` 与 serve 的表隔离)、`sessions list|show|rm`、
   `serve`(进程守护,stdout 输出 `COMBO_CLI_PORT=` 供外部脚本解析;
   `GET /v1/health` + `POST /v1/control` 优雅关闭 + **rune 兼容协议**:
   `POST /v1/workspaces/{id}/agent` 发起运行(serve 从 sqlite 读历史注入)、`POST
   .../agent/sessions/{sid}/cancel` 取消、`GET /v1/workspaces/{id}/events`
   SSE 双层信封事件流(消息 created/updated + finish + run_complete,keepalive
   用 15s `: ping`,不能用 `interval.tick()`——unfold 每帧重建会首 tick 洪泛)、
   current-session/permissions-skip stub;无 API key 时也发
   `finish(reason=error)` + `run_complete` 保证前端 run 收尾)、`config
   path|init|import`(配置文件管理)。**配置文件自动生成**:首次运行在
   `~/.config/combo/combo-cli.toml`(`COMBO_CONFIG_DIR` 覆盖目录,
   `--config` 覆盖路径)生成带注释的默认模板;优先级
   **CLI 参数 > 配置文件 > 内置默认值**,因此 `provider/preamble/tools`
   的 clap 参数是 `Option`,不能设 `default_value`,否则永远覆盖配置文件
   (合并逻辑在 `config.rs::resolve`)。**`.env` 默认值**:启动时
   `config.rs::load_dotenv` 加载配置文件同目录的 `.env` 到进程环境
   (已有环境变量优先,支持注释/引号/`$VAR` 展开),供 `$ENV_VAR`
   形式的 api_key 引用取默认值;`.env` 不存在时由
   `write_default_dotenv` 自动生成模板(默认启用 `RUST_LOG=info`,
   含各 provider 的 key 占位),且 `.env` 在 tracing 初始化前加载
   使 `RUST_LOG` 生效。内置工具
   (时间/日期)+ 可选 MCP 工具(`--mcp-command` stdio / `--mcp-url`
   streamable HTTP,经 rig `ToolServer`+`McpClientHandler` 注册)。rig 0.41
   注意:provider client 用 `Client::from_env()`(需 `rig::prelude::*` 的
   `ProviderClient`+`AgentClientExt` trait 在作用域),agent 用
   `tool_server_handle` 共享工具集;流式接口 `stream_prompt`/`stream_chat`
   返回 `StreamingPromptRequest`,需 `.await` 后才得到 `Stream`。
   **配置**(`config.rs`):`[providers.<id>]` 内嵌多 API key
   (type/api_key/base_url/default_large_model_id,`$ENV` 运行时展开)、
   `[models.large|small]` 引用(provider/model/reasoning_effort/max_tokens,
   未显式设 provider/model 时回退到 models.large)、`[mcp.<name>]`
   (type=stdio|http,command/args/url,**可多个**,`mcp.rs::connect_many`
   经 rig ToolServer 注册,单个失败按 `skip_missing` 跳过)、
   `[lsp.<lang>]`(command/args/env,`lsp list` 检测可执行状态)、
   `skills_paths`/`disabled_skills`(每 skill 一目录
   含 `SKILL.md`,frontmatter 的 description 解析后注入 preamble,
   `skills.rs::discover`,默认扫 项目 `.combo/skills` → 项目
   `.agents/skills` → combo 专属 `~/.config/combo/skills` →
   通用 `~/.agents/skills` 四个目录,项目级优先;
   技能开关经 `GET/POST /v1/workspaces/{id}/config[/set]` 读写,per-workspace
   的 disabled_skills 落 sqlite `workspace_config` 表,`run_agent_ws` 运行时
   合并全局禁用后经 `AskConfig::with_disabled_skills` 重建 preamble)。
   provider 查找顺序:`config.providers` map →
   `~/.config/combo/providers.json` → 内置;配置未写
   `default_large_model_id` 时从 combo providers.json 合并默认模型。

1. `npm run tauri dev` (README) is wrong as-is — no tauri npm script/CLI installed.
2. Browser dev needs the backend on `:18236`; combo-cli serve 默认监听 18236,端口被占用时自动 +1,前端连接失败会自动扫描匹配本机 combo-cli(见 `connection.ts`)。
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
    All serve routes in `serve.rs` (`build_router`) and its tests use `:id`;
    a `{id}` route silently 404s.
11. **会话列表来自 sqlite 镜像,直接由 serve 处理。** `GET .../sessions` 与
    `POST .../sessions` 都由 `session.rs` 本地接管(从 sqlite 读/写)。
12. **sqlite 用 `std::sync::Mutex<Connection>`**,`rusqlite` 连接不是 `Sync`;
    `list_*` 方法里 lock 的临时值要绑定到 `let`,否则借用检查报 E0716。
    `ComboDb::open` 已启用 **WAL + busy_timeout(5s)**:桌面安装版、tauri dev、
    独立 serve 可能多进程共享同一 combo.db,默认 rollback journal 下跨进程写
    立刻报锁错,且文件被对端进程(目录迁移等)替换后旧连接会退化成 readonly
    (表现为「创建会话失败: attempt to write a readonly database」)。
13. **历史 `backend=crush` 数据自动迁移。** `BackendType::parse("crush")`
    归一化为 ComboCli;`AppState::new` 时 `reconcile_all` 会把 sqlite 里遗留的 crush
    workspace 迁移为 combo-cli,无需手工处理。
14. **combo-cli 同时有 lib 与 bin target。** lib 声明全部模块(`src/lib.rs`,
    `pub mod`),bin(`src/main.rs`)通过 `use combo_cli::...` 引用;`--lib` 测试与
    `--bin` 测试都会跑。Tauri 内嵌用 `combo_cli::serve::{AppState, serve_listener}`;
    `AppState::new(cfg)` 已含 reconcile 与 COMBO_BROWSE_ROOT 解析,构造后需手动
    设置 `local_port`。`RelayManager::new()` 返回 `Arc<Self>`,不能二次 `Arc::new`。
15. **serve 配置加载**:独立 `serve` 模式若有配置缺失(找不到 provider)会退出;
    Tauri 内嵌(`init_backend`)失败时回退内置 opencode provider,仅保证
    health/文件/会话等端点可用,agent 运行无 key 时以 finish(error) 收尾。
16. **rig-core 本地补丁(vendor/rig-core)**:根 `Cargo.toml` 的
    `[patch.crates-io]` 把 rig-core 0.41.0 指向 `vendor/rig-core`(从 crates.io
    registry 拷贝,源码内 `combo patch` 注释标记改动)。修复:OpenAI 兼容 SSE 流
    收到 `data: [DONE]` 哨兵后原实现只 continue,turn 要等 HTTP 连接真正关闭才
    结束;部分网关/中转保持连接不关,导致最后一条流式消息长时间挂起(此前只能靠
    `COMBO_STREAM_IDLE_TIMEOUT` 空闲超时兜底)。补丁改为收到 `[DONE]` 即 break
    结束流(共三处:chat completions 兼容路径、openai responses_api 流式、cohere),
    回归测试 `done_sentinel_ends_stream_even_when_transport_stays_open` 用
    "发完 [DONE] 但连接永不关闭"的 mock 客户端锁定行为。升级 rig 版本时记得
    重新 vendor 并重放补丁,或确认上游已修复后删掉 patch 与 vendor 目录。

## 远端 Web / 移动端支持

combo 支持前后端分离部署:combo-cli serve 只当 API 服务,前端(dist/)部署到任意静态托管
(nginx/Vercel 等),浏览器/手机通过 `VITE_PROXY_URL`(构建期)或「设置」里的
**运行时后端地址覆盖**(`localStorage["combo.proxyUrl"]`,见 `connection.ts`
`get/set/clearProxyUrlOverride`)指向远端 serve。`resolveProxyBaseUrl` 优先级:
运行时覆盖 → `VITE_PROXY_URL` → Tauri 内置端口 → 本机端口扫描(18236 起,serve 被占用自动 +1)。SSE 与
health 都走同一 base,跨域由 CORS 放开。

- **CORS**:serve 的 `build_router` 接收 `allowed_origins` 白名单;独立运行时为空即
  全开放,Tauri 模式传 `tauri://localhost` 与 `http://localhost:5173`。
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
- **访问令牌(远程连接鉴权)**:移动端扫码远程访问时由 serve 强制校验令牌。
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
  其余无有效令牌返回 401。令牌落盘 sqlite `access_tokens` 表(`store.rs`,
  支持撤销/过期/记录最后使用时间),刷新令牌时撤销旧令牌。令牌明文由
  `/dev/urandom` 生成 32 字节 hex(64 字符),不可用时回退到时间+pid 哈希。
- **域名远程访问**:`connection.ts` 的 `getExternalUrl`/`setExternalUrl`/
  `clearExternalUrl`(localStorage `combo.externalUrl`)管理外部访问域名。
  在「设置」对话框中配置(如 `https://combo.example.com`),`MobileConnectDialog`
  二维码优先使用该域名作为基础地址;未配置时回退到 `window.location`(仅限
  局域网)。配置域名后手机扫码即可通过公网/域名访问,无需额外设置后端地址。
  serve 监听地址可通过 `COMBO_HOST` 环境变量(或 `serve --host` 参数)指定,域名
  部署时设 `0.0.0.0`。
- **中转服务器(combo-relay)与 tunnel-all 模式**:combo-relay 是独立部署的中转服务器,
  桌面端通过 WebSocket 反向隧道(`wss://relay/v1/relay/tunnel?token=`)连出。
  两种部署模式:
  1. **静态托管模式**(`--static-dir dist/`):中转服务器直接提供前端页面,
     `/v1/*` API 通过隧道转发到桌面端 combo-cli serve。
  2. **tunnel-all 模式**(默认,无 `--static-dir`):**所有请求**(含前端 HTML/JS/CSS)
     通过隧道转发到桌面端。桌面端需以 `--static-dir` 启动 combo-cli serve
     (或在 Tauri 应用中自动检测 dist/)。此模式下:
     - 令牌查找:`Authorization Bearer` → `?token=` → `combo.token` cookie → 单隧道自动选用
     - 浏览器首次访问带 `?token=xxx` 时中转设置 `combo.token` cookie,
       后续加载 JS/CSS 等静态资源自动携带 cookie 关联隧道
     - 无隧道连接时返回「等待桌面端连接」HTML 页面(3 秒自动刷新)
  - combo-cli serve 的 `--static-dir` 参数(或 `COMBO_STATIC_DIR` 环境变量)启用
    前端静态服务 + SPA fallback(index.html)。非 `/v1/` 路径走静态文件,
    不受鉴权中间件保护(前端资源为公开内容)。Tauri 应用在 `init_backend` 中
    自动检测 dist/(`COMBO_STATIC_DIR` → Tauri resource_dir → 开发模式 auto-detect)。
- **隧道保活与断线重连(远程软件式)**:防「手机锁屏 / 桌面息屏后连接死亡」:
  - **双向心跳 + 半开检测**:桌面端隧道写循环每 20s 发 WS Ping
    (`tunnel.rs`),中转每 30s Ping;**两端读循环各设 75s 空闲超时**——
    休眠唤醒/NAT 失效造成的半开 TCP(收不到 RST、写进缓冲不报错)会被
    超时判定死亡:桌面端 break 后由外层指数退避重连(1s→30s),中转端
    break 后清理 `tunnels` 表(`remove_tunnel_if_owned` 已处理同 token
    快速重连竞态),手机端请求立刻拿到干净的 502 而非长时间挂起。
  - **系统保活**:远程访问启用期间(`RelayManager::start`)macOS 持有
    `caffeinate -i -s -w <pid>`(阻止系统休眠、允许屏幕关闭;子进程随本
    进程退出自动释放),`stop` 时 kill 恢复默认休眠策略;非 macOS 为 no-op。
  - **手机端恢复**:SSE(`WorkspaceEventSource`)监听 `visibilitychange`/
    `online` 立即重连(退避可被唤醒);P2P dead 状态在页面恢复可见时清零
    冷却立即重试(`bindResumeRetry`,绕过 2 分钟 RETRY_AFTER_MS);终端 WS
    断开后自动退避重连(1s→10s,页面恢复可见立即重连,`TerminalPanel`)。
- **P2P 直连(扫码后优先直连,中转兜底)**:移动端扫码后的连接方式按优先级
  自动选择,三级回退,**LAN 直连 → WebRTC P2P → relay 中转**:
  1. **局域网直连**:桌面端(Tauri 模式)默认绑定 `0.0.0.0`(可用
     `COMBO_HOST=127.0.0.1` 关闭),`GET /v1/lan-info`(combo-cli `lan.rs`)探测
     本机局域网 IP(UDP connect 技巧,不实际发包)返回直连候选 URL。二维码在
     token 之外携带 `&lan=http://<ip>:<port>`;手机扫码打开中转页后由
     `src/lib/lanDirect.ts` 提取并**整页跳转**到桌面直连页(https 中转页无法
     fetch 探测 http 局域网地址——mixed content,只能导航),每会话
     (sessionStorage `combo.lanTried`)只自动跳一次,失败回到中转页不再跳。
  2. **WebRTC P2P**:手机留在中转页时异步协商 DataChannel 直连
     (`src/lib/p2p/transport.ts` + combo-cli `p2p.rs`,webrtc 0.20 trait 风格 API,
     桌面端为 answer 方、非 trickle ICE)。**信令经中转**:`/v1/relay/signal?token=`
     WS(combo-relay `ws_signal_handler`)↔ `TunnelMsg::Signal`/`DesktopMsg::Signal`
     透传 ↔ 桌面隧道读循环 → `P2pManager::handle_signal`。连接成功后
     `apiRequest`/SSE 走 DataChannel(`DcFrame` JSON 帧:req/body 分片
     start/chunk/end,单帧 b64 ≤12KB、响应分片 ≤8KB,DataChannel 单消息 16KB
     上限);STUN 默认 `stun.l.google.com:19302`(`COMBO_STUN_URLS` 可覆盖)。
     终端 WS 仍走中转代理。失败/断开自动回退 relay,`GET /v1/p2p/status` 查询
     状态,侧边栏连接状态显示 `局域网直连/P2P/中转`(`connectionStore.transport`)。
     **旧版中转服务器不认识 Signal 消息**——P2P 需要新版 combo-relay 配套部署。
