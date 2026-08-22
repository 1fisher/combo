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
  **托盘忙碌动画**:`init_backend` 构造 `AppState` 后 spawn `tray::watch_busy`
  轮询 `RunState::any_busy()`(空闲 400ms/动画帧 80ms)——任一项目(含自动化
  任务)的 run 进行中时,托盘图标播放「combo」字母**逐个展示**动画(共
  `LETTER_FRAMES×5 = 170` 帧程序化生成):每帧底图 = 静态图**去掉白色 C
  字形**(白色连同抗锯齿灰边涂黑,只留黑色圆角方块——避免动画字母与静态
  字形叠成杂乱复合形状),**白色**像素字模字母(3/5 列宽、5 行高)在方块内
  逐个表演「从右缘幕后 ease-out 减速滑入中心(裁剪在方块内,缘外不画)→
  落定果冻 squash & stretch(`osc = e^(−2.5t)·cos(2π·1.5t)` 衰减振荡:先
  压扁变宽变矮 32%/26%,再回弹拉高变窄,12 帧收敛)→ 静止停顿 5 帧 →
  ease-in 加速滑出左缘」的循环,每字母 34 帧 ≈ 2.7s;字母字号随水平位置
  缩放(中心满字号 cell = w/10、字母高 = 画布高一半,边缘缩至 0.6 倍,
  滑入渐大/滑出渐小),tooltip 提示「任务执行中」;忙碌帧与空闲帧同为
  **非 template** 彩色图直接渲染(`set_icon_with_as_template(_, false)`,
  黑底白字与静态图标配色统一,浅色/深色菜单栏均自带对比;原子设置避免
  分两次调用的渲染闪烁);全部结束后恢复静态原图。图标更新经 tauri
  `TrayIcon::set_icon` 内部派发主线程,后台任务调用安全。
- **`src/`** (React 19 + Vite + TS, shadcn/ui) — the frontend. TanStack Query
  for REST data, **Zustand** (`stores/agentStore.ts`) for SSE-driven live state,
  keyed by `sessionId`.

The frontend never talks to Tauri APIs for data (`src/lib/connection.ts` detects
Tauri via `'__TAURI_INTERNALS__' in window`), so the whole app is developable in a
plain browser. M1 directory picking is a path input, not a native dialog.

## Git 开发流程(worktree + feat 分支)

所有功能开发一律采用 **git worktree + feat 分支** 工作流,不直接在主分支上改代码。

> **动手前先自检**:任何代码改动前先 `git branch --show-current`,若当前在
> `main` 上,必须先建 worktree + feat 分支再改(pre-commit hook 会直接拒绝
> 在 main 上提交代码,见本节末尾)。**文档(*.md)改动同样走 PR**,main 上
> 不允许任何本地提交与直接推送(远端分支保护对管理员也强制生效)。

1. **建 worktree + 分支**:每个功能/修复在独立的 worktree 中开发,分支命名
   `feat/<简短描述>`(修复类可用 `fix/<描述>`)。主仓在 `main` 分支时:

   ```bash
   git worktree add ../combo-feat-xxx -b feat/xxx   # 从当前 main 创建 worktree + 分支
   cd ../combo-feat-xxx
   ```

   worktree 目录与主仓共享同一 `.git`,无需重复 clone;`target/`、`node_modules/`
   等构建产物在各 worktree 内独立(互不干扰,可并行开发多个功能)。

2. **在 worktree 内开发**:正常编码、`cargo test -p combo-cli`、`npm test`
   验证,小步提交到 `feat/xxx` 分支。

3. **完成后走 PR 合并**:开发完成、测试通过后,push 分支并发起 PR 合并
   (GitHub 分支保护要求所有改动——含管理员的——必须经 PR 进 main,
   直接 push 到 main 会被一律拒绝):

   ```bash
   git push -u origin feat/xxx
   gh pr create --fill
   gh pr merge --merge --delete-branch   # 所需 approve 数为 0,可直接自合

   # 收尾:回主仓同步并清理 worktree
   cd <主仓路径> && git pull origin main
   git worktree remove ../combo-feat-xxx
   ```

   合并后删除远端/本地 feat 分支与 worktree,保持仓库干净。

注意:多个 worktree 共享同一仓库,`cargo` 的 `target/` 不共享,各 worktree
首次构建需全量编译;Rust 依赖变更(`Cargo.lock`)合并时留意冲突。

**强制机制(pre-commit hook)**:`scripts/git-hooks/pre-commit` 安装到全局
`core.hooksPath` 目录(combo 署名功能接管的 `~/.config/combo/git-hooks/`,
repo 内 `.git/hooks` 在 hooksPath 存在时会被忽略),在 main 上做任何本地提交
(含 `*.md`)都直接拒绝(仅放行合并提交,避免本地 merge 卡在半途;
正常合并请用 `gh pr merge`)。
脚本自带仓库守卫,仅对 combo 主仓及 worktree(目录名 `combo` / `combo-*`)生效。
新 clone 需手动安装一次:

```bash
cp scripts/git-hooks/pre-commit ~/.config/combo/git-hooks/
chmod +x ~/.config/combo/git-hooks/pre-commit
```

远端已开启 GitHub 分支保护(经 `gh api` 配置):push 到 main **必须走 PR**
(所需 approve 数为 0,单人可自合)、禁止强推与删除分支;
`enforce_admins=true`,**对管理员同样强制生效、无直推逃生口**。
调整/查看/关闭:

```bash
gh api repos/1fisher/combo/branches/main/protection          # 查看
gh api -X DELETE repos/1fisher/combo/branches/main/protection  # 关闭
```

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

**Tauri desktop mode:** use `cargo tauri dev` (Rust toolchain Tauri CLI) or
`npx tauri dev` (`@tauri-apps/cli` is a devDependency, and package.json has a
`tauri` script). `bundle.active` is `true` — `make bundle` / `make dmg` produce
`.app` + `.dmg`.

**DMG 智能打包(`make dmg` → `scripts/build-dmg.sh`)**:对 Rust 输入
(`crates/`、`src-tauri/{src,capabilities,icons,fallback-frontend}`、根与
src-tauri 的 `Cargo.toml`/`tauri.conf.json`/`build.rs`/`Info.plist`/
`entitlements.plist`、`Cargo.lock`、`vendor/`)做内容指纹(存
`target/.dmg-rust-inputs.sha256`):未变化且 `target/release/Combo` 存在时
仅 `npm run build` + **`npx tauri bundle --bundles dmg`**(只打包、不跑
cargo),前端变更不再牵连 Rust 编译;有变化则走完整
`npx tauri build --bundles dmg --config '{"build":{"beforeBuildCommand":""}}'`
——用 `--config` 置空 beforeBuildCommand,前端只由脚本构建一次(tauri-cli
对空字符串 hook 直接跳过;不置空的话 tauri build 会再跑一遍
`npm run build`,前后端各构建两次)。
配套机制(让「复用旧二进制 + 新 dist」成为完整新版本):
① `tauri.conf.json` 的 `frontendDist` 指向稳定兜底页
`src-tauri/fallback-frontend/`——tauri-codegen 原本会把 frontendDist 下所有
文件 `include_bytes!` 内嵌进二进制,前端任何改动都会重编译+重链接 `combo`
crate;真实前端只经 `bundle.resources`(`{"../dist/": "dist/"}`)随包分发,
打包阶段现读现拷。② `src-tauri/src/lib.rs` 的 `ResourceFirstAssets` 在
`generate_context!()` 之后替换 `Context.assets`,webview 的
`tauri://localhost` 请求优先读磁盘 `Resources/dist`(解析逻辑与
`resolve_static_dir` 一致:env → resource_dir → exe/cwd 探测),磁盘缺失才
回退内嵌兜底页;磁盘模式「全有或全无」,单文件缺失不与内嵌混搭。注意:
直接改 dist 内容仍会经 tauri-build 对 `bundle.resources` 的 rerun-if-changed
触发一次 combo crate 重编译(仅在真正跑 cargo 的路径上,如
`make build-desktop`);`make dmg` 快速路径完全不跑 cargo,不受影响。


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
- **API 调用次数(rig turns)与 agent 命名**:rig 多轮循环每次 completion 调用
  完成都会产出 `MultiTurnStreamItem::CompletionCall`(即 tracing 日志
  `Current conversation Turns: N/200` 的计数值,N 为本次 run 内第 N 次模型
  调用)。`agent.rs::stream_run` 据此逐次上报 `RunEvent::Turns(n)`,serve
  (`start_agent_run`)以 run 启动时的库内 `conversations.api_calls` 为基数,
  实时广播 SSE `usage` 事件(双层信封,`{session_id, api_calls}` 为会话
  **累计**值),run 结束 `store.rs::add_api_calls` 把本次 run 的调用数累加
  落库;`GET .../sessions` JSON 回传 `api_calls`,finish part 与
  `run_complete` 的 usage JSON 附带本次 run 的 `turns`。前端
  `agentStore.apiCallsBySession`(`setApiCalls` 单调取大)经 dispatch 的
  `usage` 分支实时更新、`useSessions` 用列表 `api_calls` 播种,Composer
  底部「调用次数」显示该值——**不再按 assistant 消息数估算**(一次 run 的
  多轮工具循环只对应一条 assistant 消息,旧逻辑严重低估)。agent builder
  统一 `.name("Combo")`,rig 遥测 span 的 `gen_ai.agent.name` 不再显示
  "Unnamed Agent"。
- **File service** (`crates/combo-cli/src/fs.rs`): `GET .../files/list?path=`
  lists one directory (hidden files skipped, dirs first), `GET .../files/content`
  reads text (≤1MB, binary rejected), `PUT .../files/content` writes atomically.
  `path` must be relative; serve resolves the workspace root from sqlite
  `MetaStore`. Frontend: `src/lib/api` wrappers +
  `stores/editorStore.ts` + `FileExplorer`/`EditorPane`.
- **Git 提交设置与 AI 生成提交信息**(`git.rs` + 设置「Git 提交」分组):设置里
  两个全局开关均持久化在 combo-cli.toml——①「提交携带署名」
  (`commit_attribution`,`GET/POST /v1/settings/commit-attribution`,开启时
  serve 安装全局 commit-msg hook 给 `core.hooksPath`,命令行/其他工具的提交
  也自动追加 `Generated with Combo v<版本>`;署名含构建期版本号
  (`git.rs::commit_attribution` 用 `CARGO_PKG_VERSION`,`scripts/version.sh`
  统一四文件版本),hook 每次启动重新同步,版本升级后自动携带新版本号;
  重复检测按稳定前缀 `Generated with Combo` 匹配,旧版本署名不重复追加);②「生成提交信息使用全局模型」
  (`[git]` 段 `commit_model_enabled/_provider/_model`,
  `GET/POST /v1/settings/commit-model`)。前端 GitPanel 提交框「AI 生成」按钮
  调 `POST .../git/commit-message`:后端取 staged diff(截断 16k)+ 最近 10
  条提交风格,经 `agent::ask_answer` 单轮无工具生成一行 conventional commit;
  模型 = 全局提交模型(开启时)优先,否则回退 `workspace_effective_cfg` 的
  会话模型;返回经 `sanitize_commit_message` 清理(去围栏/引号/前缀),前端
  填充提交框并识别自带 type 前缀避免双前缀。
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
- **Composer 斜杠命令**(`/` 命令,`src/lib/slashCommands.ts` + `Composer.tsx`
  submit 拦截 + `AgentPanel.tsx::handleCommand`):输入 `/` 弹命令菜单
  (复用 `useMention` 的 command 类型,选中后插入输入框,回车发送时本地拦截
  执行,不再发给 LLM;命令后可跟参数,如 `/summary 重点看代码`)。两类命令:
  `local` 纯前端执行——`/new` 新建会话并切换(与侧边栏「新建任务」同路径)、
  `/clear` 清空当前会话;`prompt` 展开为固定提示词走正常 doSend——
  `/summary`(总结对话)/`/review`(审查 git 变更)/`/tests`(跑项目测试)。
  未注册的 `/xxx`(如路径 `/usr/bin`)不拦截,照常作为普通消息发送。
  `/clear` 经 `POST /v1/workspaces/{id}/sessions/{sid}/clear`(`session.rs::clear`)
  落地:run 进行中 409;删除 sqlite 全部消息 + `store.rs::reset_session_usage`
  把 `context_tokens`/`api_calls` 归零(token 账目保留为历史消耗),回收
  todos/questions 内存态,并广播 session updated 事件(payload 带 `cleared: true`),
  各端 `useWorkspaceEvents` 据此清内存消息并 invalidate 历史缓存(多端联动)。
  前端同时 `clearSessionRuntime` + `agentStore.resetApiCalls`(`setApiCalls`
  单调取大,清零需专用方法)。
- **多 agent 协作(agent-as-tool,`multiagent.rs`)**:主 agent 通过 `agent` 工具
  把子任务派发给独立子 agent(rig `Agent` 实例,基于 rig 0.41 的 DynamicTool 原语,
  supervisor/worker 模式)。单任务传 `{agent, task}`,互不依赖的子任务传 `tasks`
  数组(≤5,`join_all` 并行)。内置角色:researcher(只读调研)/ coder(全量工具)/
  reviewer(只读审查),`combo-cli.toml` 的 `[agents.<name>]` 段
  (description/preamble/provider/model/reasoning_effort/readonly/disabled)可覆盖
  字段、新增自定义角色或禁用内置角色(`collect_defs` 合并;全部禁用时 serve 不注入
  该工具)。子 agent 配置由主 run 的 `AskConfig` 派生(`resolve_sub_cfg`):继承
  provider/key/MCP/skills,替换 preamble 为角色提示词(再经 `with_workspace` 拼
  AGENTS.md + skills),可换 provider/model(换 provider 未指定模型时回落其默认大
  模型);`readonly: true` 的角色经 `AskConfig.readonly_tools` 使用
  `tools::builtin_tools_readonly`(无 write/replace/bash,杜绝写副作用)。子 run
  三条硬约束:**空历史**(上下文隔离,task 需自包含)、**无交互工具**(不注入
  question/todo/compact/agent,子 agent 不能再派生孙 agent 防递归)、**共享主 run
  的 cancel watch**(用户停止主任务时全部子任务中止)。实时进度:子任务状态经
  `subagent_update` SSE(双层信封,与 `todo_update` 同构;400ms 节流,TextDelta
  只保留尾部 240 字符预览,ToolCall 强制广播)推给前端,`agentStore.subagents` +
  `SubAgentPanel`(输入坞上方,与 TodoList 同区域:角色 badge + 任务 + 动作预览 +
  工具调用数)实时展示,`run_complete` 时清空(最终报告在消息流 tool_result 卡
  片)。用量归账:子 run 的 rig usage/API 调用次数直接 `add_usage`/
  `add_api_calls` 累加进所属会话并广播 `usage` 事件(前端 setApiCalls 单调取大);
  工具结果为 Markdown 报告(每子任务一节:agent 名 + 任务 + 最终文本 + 用量摘要)
  返回主 agent 汇总。
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
- **路由历史(顶栏后退/前进)**(`stores/navStore.ts`):AppShell 顶栏左上角的
  后退/前进箭头走浏览器式历史栈,条目 = `{view, workspaceId, sessionId}` 三元组。
  `AppView`/`SideView` 类型定义在 navStore(AppShell re-export 保持旧导入路径),
  `view` 状态本体也从 AppShell 本地 useState 迁入 navStore(否则 back/forward 无法
  驱动它)。记录来源两条:`setView`(视图切换)与 `useAgentStore.subscribe` 订阅
  (项目/会话变化,含自动选中)。合并/防噪规则:① 首次变化先把「变化前」状态落为
  历史第一步(后退才可用),但启动期项目还是 null 时不落——避免刚开应用就能
  「后退回空首页」;② 同视图同项目下会话从 null → 非 null 原位升级(切项目清空
  会话后列表加载自动选中首个/busy 会话,不合并会多一条无意义中间态);③ push 截断
  游标之后的条目(浏览器语义);④ back/forward 恢复期间 `applying` 计数器抑制订阅
  再次记录。恢复顺序必须「先项目后会话」(`setActiveWorkspace` 会清空会话)。
  历史栈内存态不持久化,上限 100 条。
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
- **全项目事件聚合订阅**(`useWorkspaceEvents.ts::WorkspaceEventsManager`,挂
  AppShell):对项目列表中**每个**项目各维持一条 SSE 连接(替代旧「仅当前活跃项目
  订阅」),后台项目(agent 运行/自动化任务)的 question/权限请求/任务完成才能到
  达前端并触发通知与卡片。store 全部状态按 session_id 键控,跨 workspace 派发天然
  安全;AgentPanel 不再自行订阅。question 批次入队时记录来源 workspace
  (agentStore `questionWorkspaces`:batch_id → ws_id),问题卡片可能跨项目展示,
  回答时 `answerQuestion(来源ws)` 按此路由;question/permission 事件在 dispatch
  按 batch_id/tool_call_id 去重(切换项目瞬间新旧连接短暂并存会重复送达同一帧);
  项目删除(404)时 onGone invalidate `['workspaces']` 并在删除的是选中项时清空
  选中态。
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
  `automation`, `multiagent`, `store`, `meta`, `workspace`, `session`, `auth`, `fs`, `git`,
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
  立即运行/历史/编辑/删除)/ 表单(名称/目标项目/运行模型/思考强度/提示词/调度
  类型;模型选择紧邻目标项目,复用与 Composer 同一套 `ModelPicker`——搜索 +
  最近使用 + 按 provider 分组跨选,顶部带「跟随项目默认」清除项)/ 运行历史。
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
- **provider 流截断自动重试(`agent.rs::stream_one`)**:rig 在 provider 的 SSE 流
  **没有任何终止记录**(无带 finish_reason 的 chunk、无 `[DONE]`)时判定为截断并抛
  `CompletionError: ResponseError: provider stream ended without a terminal record;
  treating the turn as truncated`——常见于 openai 兼容网关(如 opencode-go)在
  长上下文/超长输出时主动掐断连接。combo 对该类错误(`is_truncation_error`
  匹配 terminal record/stream ended/truncated)**自动重试一次**:`consume_stream`
  在消费流时把已完成的工具调用循环(assistant tool_call + user tool_result
  配对消息)收集进 `tool_history`,重试时拼接进历史让模型从断点继续,**不会
  重复执行已有副作用的工具**;纯文本对话直接重发。重试前广播 `RunEvent::Retrying`
  → serve 转发 `retry_notice` SSE 事件(双层信封,`{session_id, text}`)→ 前端
  `agentStore.setRetryNotice` 写入 `SessionRuntime.retryNotice`,输入区上方显示
  琥珀提示条(run running 期间显示,下次 run 启动清空)。429/401/余额不足等
  服务商明确拒绝的错误、空闲超时错误不重试。重试仍失败时 `friendly_error`
  给出「Provider 流被截断」中文提示(建议切换模型/新建会话)。
- **本地图片 OCR(`ocr.rs` + tools.rs 的 `ocr` 工具)**:macOS 系统 Vision 框架
  (`VNRecognizeTextRequest`,经 `objc2`/`objc2-vision` 绑定,仅
  `[target.'cfg(target_os = "macos")'.dependencies]` 引入,其他平台编译零影响)
  的本地离线文字识别,无需联网/API key。工具参数:path(workspace 内相对
  路径,PNG/JPEG/HEIC/TIFF/BMP/GIF/WEBP,PDF 不支持,≤50MB)、languages
  (默认 `["zh-Hans","en-US"]`,zh 需 macOS 13+)、level(fast/accurate,默认
  accurate)、correct(语言纠错,默认关——会改写 URL/编号字面量)。注册进
  `builtin_tools` 与 `builtin_tools_readonly`(只读无副作用,调研/审查子
  agent 也可用);`performRequests` 阻塞,工具内 `spawn_blocking` 执行;
  结果按 Vision 阅读顺序逐行返回。非 macOS 调用返回友好错误文案。单元测试
  内嵌 base64 PNG fixture(`HELLO 42`)锁定真实识别回归。
- **本地语音识别(`asr.rs`,Composer 语音输入)**:输入框话筒按钮的听写服务
  (快捷键 ⌘/Ctrl+I 与按钮同路径 `dictation` `toggle`,`Composer.tsx` 全局
  keydown,Shift/Alt 变体让位浏览器开发者工具 ⌘⇧I),完全本地离线。**模型可选**(`AsrModel`,配置 `[asr] model` 或设置界面
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
  开启/关闭录音有 Web Audio 合成的提示音(轻盈气泡声:高频短促正弦 + 频率指数
  滑动模拟水泡「啵」,开启两颗升调气泡、关闭两颗降调气泡,`audio.ts` 的
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
  可选 `piper-zh-chaowen`/`vits-zh-fanchen-c`/**`vits-zh-en-melo`(MeloTTS
  中英双语,~163MB,lexicon 自带中英词典,英文按单词发音)**)。模型为
  k2-fsa/sherpa-onnx
  `tts-models` release 资产(piper 中文 int8 各 ~14MB、HF 高质量 ~113MB),
  与 ASR 共用 `<数据目录>/models/<id>/` 下载/解压/懒加载流程
  (`COMBO_TTS_MODEL_URL` 可换镜像);加载配置统一为
  `model=*.onnx + tokens=tokens.txt + lexicon=lexicon.txt + rule_fsts=
  phone.fst,date.fst,number.fst`(fst 在模型根目录,fanchen-C 多说话人用
  `sid=100`),合成结果封装 44 字节 WAV 头(PCM16)返回。**拉丁文本本地化**:
  中文 TTS 模型是 char 级词库,英文字母/英文词直接合成会被当作 OOV 静默丢弃
  (sherpa-onnx 日志 `Ignore OOV 'Combo'`),合成前 `localize_latin_text` 把
  拉丁字母串逐字母转成中文读音(如 `Combo`→`西 欧 艾姆 比 欧`),保证英文
  词/标识符可完整念出(数字与符号保留,由 rule_fsts 处理);**MeloTTS 双语
  模型跳过该转写**(`TtsModel::supports_english`),英文原样按单词发音,适合
  中英混读场景。端点:
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
  供设置区「试听」按钮预览音色)、**`POST /v1/speech/stream`(流式合成,
  NDJSON chunked)**:请求体 `{"text", "test"}`(`test=true` 不要求开关,
  供试听/通知播报),服务端把文本切成**片段**(`split_tts_fragments`:句末
  标点。!?…;换行为硬边界,逗号/顿号/分号/冒号为软边界——模型在这些标点
  处会生成 0.3~0.8s 静音,是「逗号长停顿」的来源,切开成独立片段后停顿交
  由播放端短间隙控制;数字间千分位逗号不切;单片段 ≤100 字符),逐个
  `spawn_blocking` 合成、合成一个就流出一行
  `{"type":"chunk","seq","hard","sample_rate","pcm":"<base64 PCM16LE>"}`,
  末行 `{"type":"done"}`/错误行 `{"type":"error"}`(经 `futures::stream::unfold`
  + `Body::from_stream`,`x-accel-buffering: no` 防代理缓冲);每片段首尾
  静音已 `trim_silence` 裁剪、`GenerationConfig.silence_scale=0.08` 压模型
  内部静音;文本经 `normalize_tts_text` 去除 markdown 残留符/折叠空白,
  非双语模型额外删 ASCII 空格(char 级词库里空格=长停顿)。旧端点
  `/v1/speech`、`/v1/speech/test` 保留但同样片段化(片段间插入固定短静音
  后拼 WAV)。**模型下载进度前端展示**:
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
  `waitSpeechModelReady` 触发下载并等就绪,再经 `streamSpeech`
  (`POST /v1/speech/stream`,`test=true`)流式合成测试句播放,不受朗读开关
  影响。前端 `useSpeechOutput`
  (`src/hooks/useSpeechOutput.ts`,挂 `AppShellInner`)订阅 agentStore 当前
  会话 assistant **text part** 文本增量(只读本次 run 的增量:run 开始时把
  已有消息全部标记已消费,避免朗读历史),按句末标点/换行断句(代码块围栏
  内容跳过、围栏状态跨增量保留,`src/lib/ttsSplit.ts` 纯函数,单句 >100 字符
  强制切),完整句子积压成批经 `streamSpeech`(`api/index.ts`,底层
  `client.ts::apiRequestNdjson` 逐行解析 NDJSON;PCM 经 `src/lib/pcm.ts::
  pcm16ToAudioBuffer` 直接转 AudioBuffer,不经 decodeAudioData)流式合成:
  片段到达即按**播放时间轴无缝排期**(`AudioBufferSourceNode.start(at)`,
  `nextStartRef` 累加,硬/软边界间隙 0.26s/0.14s)——后续片段在前一段播放
  期间继续合成与排期,句间无「等合成」空档;`pump` 发送泵保证同一时刻仅一个
  在途流请求(片段顺序即到达顺序),批次失败丢弃不重试(除 `tts_not_ready`
  等就绪后重试一次)。通知语音播报 `notifyVoice.ts` 与试听同走该流式通道。
  打断(新发消息/切会话/关开关/run 出错)中止流请求 + 停掉全部已排期音频 +
  清缓冲。设置界面
  `TtsSection`(开关 + 模型下拉,开关写 `[tts] enabled` 并联动朗读 hook)。
- **音效共享 AudioContext 与「假 running」自愈**(`src/lib/sfx.ts`):combo
  特效音、听写气泡音(`audio.ts::playDictationChime`)、任务提示音
  (`playNotifyDone/Cancel/Error/Attention`)、TTS 朗读与通知播报全部复用
  `getSharedAudioContext()` 这一个播放上下文(WebKit 对同页 AudioContext
  有数量上限,各处自建会互相挤占致全静音)。自愈分层:① `closed`/
  `interrupted` 状态直接丢弃重建(close 被弃实例释放配额);② `suspended`
  靠常驻手势监听(pointerdown/keydown,不摘除)在手势内 resume;③
  **假 running 兜底**——WKWebView 在睡眠唤醒/切换音频设备/CoreAudio 重启后
  可能停在 `state==='running'` 但输出管线已死(无报错、手势救不回、重启才
  恢复),无法直接探测,按三信号在**下一个用户手势内**静默换新上下文:
  高龄(`MAX_CTX_AGE_MS` 10 分钟)、待重建标记(非手势路径发现高龄或
  `visibilitychange`→visible 时置位)、连续 ≥3 次 resume 无效
  (`suspendStreak`)。换新必须延迟到手势内(新实例要靠手势 resume 才能出声,
  SSE 路径换出来是哑巴);近期有排期(`markAudioScheduled`,10s 宽限,
  masterOut/playBubbleTone/TTS 排期各路径上报)则推迟,避免拦腰切断朗读。
  `window.__comboSfxDebug()`(`sfxDebugInfo`)供控制台诊断 state/龄/排期。
  测试注意:`vi.resetModules` 后旧模块的常驻监听仍挂在共享 window 上,
  各用例 afterEach 必须调 `disposeAudioHooksForTests()` 摘除。
- **Frontend layout:** `src/components/{ui,shell,agent}` — `ui/` is generated
  shadcn primitives, `shell/` is app chrome, `agent/` is the chat/tool/modal UI.
  The shell is a 1:1 仿写 ZCode 的 agent 布局:左侧 `WorkspaceSidebar`(默认 372px,
  可拖拽调宽/收起,含 新建任务/搜索/自动化/技能/MCP/LSP/统计/图谱 导航按钮、
  「任务/项目」视图切换:
  「项目」视图只列项目(可折叠分区),「任务」视图以当前项目名为分区标题、只列出
  当前项目的任务(`ConversationList`,不再展示所有项目的分组任务)、
  底部用户与连接状态) + 可拖拽分隔条 + 主内容区
  (顶栏帮助/终端按钮;无会话时显示 `ChatEmptyState` 问候语 + 订阅横幅 + 模板卡片,
  会话中显示消息列表,底部为 ZCode 风格 `Composer` 输入坞:项目 chip + 工具栏
  [添加上下文/完全访问指示(仅此一个权限模式,静态展示,权限全部自动放行)/用量环/
  Provider/模型/思考等级/发送;Provider 切换后模型列表按该
  Provider 过滤,并自动选用其默认大模型])。`index.html` 固定 `class="dark"`,
  新增 theme token(`--surface`/`--foreground-subtle`/`--brand` 等,见 `index.css`)。
  `StatusBar` 已从布局移除,连接状态折进侧边栏底部;`EditorPane`(文件编辑器)
  仍在右侧,打开文件时才渲染。
  `src/hooks/` wraps TanStack queries + SSE lifecycle;
  `src/lib/api/` is the typed client (`types.ts` generated, `index.ts` hand-written
  endpoint wrappers); `src/lib/events/` is SSE + dispatch; `src/lib/connection.ts`
  is proxy address discovery + health polling; `src/stores/` is Zustand.
- **LSP 服务管理**(`LspView.tsx`,侧边栏「LSP」按钮,AppView=`'lsp'`,快捷键
  ⌘/Ctrl+⇧L):对 combo-cli.toml 的 `[lsp.<lang>]` 段做可视化管理,与 MCP 视图
  同构(列表/hero 模板/双栏表单)。REST(`serve.rs`):`GET /v1/lsp`(列表 +
  `lsp::find_executable` 实时检测可执行状态与路径)、`POST /v1/lsp`
  (`{name,command,args?,env?}`,`config.rs::upsert_lsp_server` 落盘——lang 仅
  字母/数字/`-`/`_`,command 必须是纯可执行文件名、参数走 args 串经
  `mcp::shell_words` 拆分,env 为 KEY=VALUE 表)、`POST /v1/lsp/remove`、
  `POST /v1/lsp/check`(表单保存前检测命令是否在 PATH)。增删后
  `reload_lsp_into_runtime` 把配置同步进 `state.cfg.lsp`,下一次 run 的
  `builtin_tools` 立即注册/注销 diagnostics/definition/references/hover 工具。
  前端 `useLsp.ts` + `api/index.ts` 的 `listLspServers/upsertLspServer/
  removeLspServer/checkLspCommand`;表单语言标识带 datalist 建议(与
  `ext_to_lang` 扩展名映射一致),环境变量按行解析(注释行忽略)。
- **LSP 一键安装(自动配置 + 安装服务)**:`lsp.rs::LSP_INSTALL_PLANS` 内置
  rust/typescript/javascript/python/go 五语言的安装方案,每个方案按优先级列
  候选包管理器(rust→rustup/brew、ts/js→npm/pnpm/yarn/bun/brew、python→
  pipx/uv/brew/pip3、go→go/brew),`resolve_install_command` 按**本机 PATH**
  取第一个命中的候选。**可执行文件解析含常见目录兜底**:`find_executable`
  在进程 PATH 之外追加 `~/.cargo/bin`(rustup)、`~/.local/bin`(pipx/uv)、
  `/opt/homebrew/bin`(Apple Silicon Homebrew)、`/usr/local/bin`——GUI
  (Finder/Dock)启动的进程 PATH 只有系统目录,rustup 装的 rust-analyzer
  在 `/v1/lsp` 里显示「未找到」、且 `LspClient::start` 直接
  `Command::new` 会 spawn 失败,所以**检测与 spawn 共用 `find_executable`
  的解析口径**(裸命令先解析为绝对路径再启动),否则会出现「检测已安装、
  实际拉起失败」的不一致。**一键安装的 spawn 同口径**:
  `lsp.rs::resolve_spawn_program` 把安装命令 argv[0](如 `npm`)先解析为
  绝对路径再启动(`serve.rs::run_lsp_install`,Windows 经 `cmd /C` 包装的
  同样传解析结果)——否则受限 PATH 下检测说「可安装」、启动却报
  `No such file or directory (os error 2)`;启动失败 message 带解析后的
  命令路径便于排查。**登录 shell PATH 补全**(`paths.rs::
  ensure_gui_path`,main 与 Tauri `run()` 启动最早期调用):GUI/launchd
  启动的进程不读 `.zshrc`,PATH 缺 `$HOME` 下目录时从 `$SHELL -ilc`
  解析用户完整 PATH 合并(shell 顺序在前,进程独有目录追加;VS Code
  shell-env 同思路),`~/.cargo/bin`、`/opt/homebrew/bin` 等用户目录由此
  进入进程 PATH——与 find_executable 兜底互为双保险。**spawn 时统一注入
  shell 环境**(`lsp.rs::spawn_path_for` 构造子进程 PATH = 已解析命令所在
  目录 → 登录 shell PATH(`paths.rs::login_shell_path_cached`,`$SHELL -ilc`
  探测、OnceLock 缓存、进程 PATH 已含 HOME 目录时跳过)→ 进程 PATH →
  `extra_bin_dirs` 兜底):只把命令解析成绝对路径**不够**——npm /
  typescript-language-server 等是 `#!/usr/bin/env node` 脚本,shebang 解释器
  仍按 **PATH** 查找,受限 PATH 下报 `env: node: No such file or directory`
  (退出码 127);命令所在目录排最前,保证 node 与 npm 同目录(Homebrew
  `/opt/homebrew/bin`、nvm 版本目录)命中同版本解释器,子进程派生的
  node/git 也继承。三处 spawn 统一走该口径:`run_lsp_install`(安装命令)、
  `LspClient::start`(LSP server 子进程,`[lsp.<lang>]` env 显式配了 PATH
  时尊重之)、`tools.rs::run_bash_command`(agent bash 工具,不再原样透传
  进程 PATH)。探测实现为 `paths.rs::query_login_shell_path_from`(shell
  路径可注入,测试不改写进程 `$SHELL`——bash 工具测试并行读它,改写会
  互相污染)。REST(`serve.rs`,`AppState.lsp_install` 共享状态,
  同一时刻至多一个任务):`GET /v1/lsp/plans`(方案列表,`install_command`
  为解析后的实际命令,null=本机缺包管理器)、`POST /v1/lsp/install`
  (`{name}` 后台 spawn 执行安装命令,运行中再发起 409;Windows 上 npm 等
  .cmd 脚本经 `cmd /C` 包装)、`GET /v1/lsp/install/status`(轮询:running/
  success/failed/cancelled + message + 日志尾部 80 行,日志总量截尾 400 行)、
  `POST /v1/lsp/install/cancel`(watch channel → kill 子进程)。安装命令
  退出码 0 即成功:自动 `upsert_lsp_server` 写入 `[lsp.<lang>]` 配置并同步
  `state.cfg.lsp`;PATH 暂未刷新找不到可执行文件时仍保存配置,message 提示
  重启生效。前端(`LspView.tsx`):hero 模板卡直接显示安装命令、点击即
  「确认→安装」(无方案回退表单预填);安装横幅四态(进度含实时日志尾部/
  成功/失败+重试/取消),`useLspInstallStatus` 运行中每秒轮询、终态自动
  invalidate 列表与方案;列表行「未找到」且有方案时提供「安装」按钮;表单
  检测未找到且语言在方案内时提供「一键安装」。
- **会话界面 LSP 检测提示**(`LspStatusBanner.tsx`):`GET
  /v1/workspaces/:id/languages`(`lsp.rs::workspace_languages`)按扩展名统计
  workspace 各语言源文件数(walkdir 只遍历文件名不读内容,跳过忽略目录/
  隐藏文件,上限 4000 文件截断,`spawn_blocking`;语言标识与 `ext_to_lang`
  即 `[lsp.<lang>]` 配置键同口径)。前端 `useWorkspaceLspStatus` 把语言统计与
  `['lsp-servers']` 缓存(同 LSP 视图,安装终态 invalidate 后自动收敛)交叉,
  `lib/lspStatus.ts::computeLspIssues` 只保留「有意义」的语言(文件数 ≥3 且
  ≥ 最多语言数的 5%,最多 4 条,避免仓库零散脚本噪音),在 AgentPanel 消息区
  顶部渲染横幅:`not-found`(已配置 server 但 `executable === false`,如 rust
  配了 rust-analyzer 却不在 PATH)为红色「语言服务检测异常」、`missing`(项目
  有该语言源码但未配置 server)为琥珀「语言服务未配置」,逐语言展示源文件数、
  命令与建议命令;「去配置」跳 LSP 视图,「忽略」为内存态、**切换项目后自动
  复位重检**(AgentPanel 对 workspaceId 的 effect 清零)。
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
   `[agents.<name>]`(multi-agent 子 agent 角色:description/preamble/provider/
   model/reasoning_effort/readonly/disabled,覆盖内置 researcher/coder/reviewer
   或新增自定义角色,见 `multiagent.rs`)、
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
  - **持久化 + 重启自动恢复**:用户开启过「移动端远程控制」后,隧道配置
    (relay_url/token)落盘 sqlite 单行表 `relay_config`(`store.rs`),
    `serve_listener` 启动时 `relay::restore_persisted_relay` 自动重建隧道
    (本地代理地址用当前实际端口重建,防重启后端口 +1 变化)——桌面端重启
    后手机端仍可随时访问,**令牌超期/撤销前持续保持**。令牌有效性与「超期
    即停」由 `spawn_token_watchdog`(60s 轮询:配置被换/清除则过时退出,
    令牌撤销/过期则停隧道+清配置)兜底;`revoke_token`/`revoke_all_tokens`
    撤销的是当前持久化令牌时立即清配置(无竞态:只删旧配置,用户刷新令牌
    时 `start_relay` 会重新写入新配置)。`RelayStatus` 扩展
    `persisted/token/expires_at/token_valid` 字段:前端
    `MobileConnectDialog` 重开时优先**复用现有令牌**(不重新生成、不断开
    手机端;隧道未连接时用现有令牌重连),侧边栏移动端按钮经
    `useRelayStatus`(30s 轮询)显示「已开启」绿点;隧道已连接时对话框提供
    「关闭连接」按钮(`stopRelayTunnel` 停隧道+清持久化配置 + 撤销当前令牌),
    关闭后绿点熄灭、重启不再自动恢复,断开态提供「开启访问」重新生成并连接。
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
- **Android 壳(Capacitor,`android/` + `capacitor.config.json`)**:可安装的 Android
  App(先做 Android,iOS 后续同构接入)。架构是「薄启动器」:原生壳只承载
  **移动端连接设置屏**(`MobileConnectScreen`,与 PWA 复用同一组件)——扫码
  (`getUserMedia` + BarcodeDetector/jsqr,CAMERA 权限经 Capacitor
  BridgeWebChromeClient 映射为系统运行时授权;Manifest 声明 CAMERA +
  `uses-feature required=false`)或手动输入地址+令牌——成功后 WebView **整页导航**
  到目标页面(`<server>/?token=..&lan=..`,`server.allowNavigation: ['*']`),
  之后 100% 复用 Web 端远程链路(token 提取 / P2P / 中转 / SSE / 终端 WS),
  不在原生层重写任何连接逻辑。关键配置:`androidScheme: 'http'`(壳内 origin 为
  http://localhost,加载 http 局域网目标不触发 mixed content)+ `cleartext` +
  `allowMixedContent`(支持直连 http://192.168.x.x)。原生检测不经 import
  (@capacitor/core),读全局 `window.Capacitor.isNativePlatform()`
  (`src/lib/native.ts`);`shouldShowMobileConnect` 对原生壳恒真(壳 origin 无业务
  含义);原生模式跳过 `/v1/health` 预检(壳内 fetch 受 CORS/混合内容影响不可靠,
  导航后页面自身有完整连接态 UI),并记忆最近连接地址(`combo.nativeLastServer`)
  下次启动预填。深色主题/启动屏(对齐 #101116)与全套 mipmap 图标由
  `public/combo-icon.png` 程序化生成。命令:`npm run cap:sync`(build + 同步资源)、
  `npm run cap:android`(Android Studio 打开)、`npm run apk`(本机 gradle 出
  Debug APK,需 ANDROID_SDK_ROOT 或 android/local.properties);
  CI:`.github/workflows/android.yml`(workflow_dispatch,ubuntu runner 自带
  SDK,上传 combo-debug-apk artifact)。**选型/构建注意**:固定 **Capacitor 6.x**
  ——@capacitor/android 库自 7.x 起 `build.gradle` 硬编码 `sourceCompatibility 21`
  (需 JDK 21),本项目本机/CI 均为 **JDK 17**,故用 6.x(VERSION_17);配置用
  `capacitor.config.json` 而非 `.ts`(Capacitor 6 CLI 的 TS 加载器与本仓库
  TypeScript 7(tsgo)不兼容,JSON 由 CLI 直接解析)。`variables.gradle` 里
  `compileSdkVersion=35/targetSdkVersion=35`(本机 SDK 仅装 platform 35/36)。
  `android/.gitignore` 已忽略 web 资源拷贝(`app/src/main/assets/public`)与
  local.properties;正式发布签名待配置 keystore
  后接入 release 流程。
