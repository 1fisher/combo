# combo 多 Agent IDE 设计文档

日期:2026-08-01
状态:已评审(经 brainstorming 流程)

## 1. 背景与目标

构建一个 **Tauri 桌面应用**形式的完整 IDE(combo),前端基于 **React + TypeScript + shadcn/ui**,与
**rune**(Charm Crush,Go 终端 AI 编程助手)配合,在 GUI 中复刻并超越其 TUI 能力:多项目、
多会话、agent 任务执行、工具调用、权限审批、提问、文件编辑、终端、git 等全部功能。

### 已确认的决策

| 维度 | 决策 |
|---|---|
| 架构 | Tauri 桌面应用(Rust 壳 + React/TS 前端),Rust 内置反向代理 |
| 多 agent | 多 workspace(项目)+ 项目内多会话并行 |
| IDE 形态 | 完整 IDE:文件树 + Monaco + 终端(xterm.js)+ git 面板 + agent 面板 |
| 呈现保真度 | 高保真:流式消息/工具调用实时展开/diff/权限弹窗/提问弹窗/进度 |
| 首个里程碑 | M1 垂直切片:项目 + 会话 + agent 执行闭环 |
| Provider | 只读展示,配置沿用 rune(crush.json/CLI),支持会话内切换模型 |

## 2. 总体架构

### 2.1 进程模型

```
Tauri Webview (React/TS)
   fetch / EventSource ──→ http://127.0.0.1:<随机端口>/v1/*
                                  │ axum 反向代理(仅转发,无业务逻辑)
                                  ▼
                        rune server (crush server 子进程, unix socket)
```

### 2.2 Rust 壳职责

- **启动/守护 rune server**:检测默认 socket(`$XDG_RUNTIME_DIR`/tmp 下 `crush-<uid>.sock`),
  不存在时自动 spawn `crush server` 子进程;子进程 stdout/stderr 写入日志。
- **健康检查**:轮询 `GET /v1/health` 直到就绪,后续持续监控;崩溃后自动重启(带退避)。
- **优雅关停**:应用退出时 `POST /v1/control {"command":"shutdown"}`,并回收子进程。
- **反向代理**:监听 `127.0.0.1:0`(随机端口),转发方法/路径/请求头/body 到 rune 的 unix
  socket;**SSE 流式透传**(flusher,不缓冲)。CORS 放行 `tauri://localhost` 与
  `http://localhost:5173`(vite dev)。
- **端口下发**:代理端口通过 Tauri event 推送给前端;前端可轮询/等待该事件。

### 2.3 技术栈

| 层 | 选型 |
|---|---|
| 壳 | Tauri 2.x,Rust(axum 反向代理) |
| 前端框架 | React 18 + TypeScript + Vite |
| UI 组件 | shadcn/ui(Radix + Tailwind CSS) |
| 服务端状态 | TanStack Query(REST 数据/缓存/失效) |
| 实时状态 | Zustand(SSE 事件流/UI 态,以 sessionId 分片) |
| 编辑器 | Monaco(`@monaco-editor/react`) |
| 终端 | xterm.js(`@xterm/addon-fit`) |
| API client | 复制 rune 的 `internal/swagger/swagger.json` 到本仓库,`openapi-typescript` 生成类型 + fetch 封装 |
| 测试 | Vitest + Testing Library、Playwright(Rust 侧 Rust 单测 + 集成测试) |

### 2.4 API client

- `swagger.json` 固定复制一份入库(带来源 commit 说明),`openapi-typescript` 生成 TS 类型。
- 轻量 fetch 封装:`baseURL` 动态取自代理端口;统一解析 `proto.Error`;超时与重试策略;
  类型安全覆盖 rune 全部 `/v1` 接口。

### 2.5 事件流

- `GET /v1/workspaces/{id}/events`(SSE)作为唯一事件入口,按事件类型分发:
  消息、工具调用、diff、agent 事件(error/response/summarize)、权限请求、提问、filetracker 变更。
- 前端 SSE 客户端:指数退避自动重连;重连后对激活会话执行一次 `history` 拉取对账补漏。
- 断线时状态栏显示"连接中/已连接/已断开",agent 面板在断线时防误提交。

## 3. 数据模型与状态管理

### 3.1 领域模型(对齐 rune proto)

```ts
Workspace { id, name, path, config, provider 状态, activeSessionId }
Session    { id, title, model, status: idle|running|summarizing, updatedAt }
Message    { id, role: user|assistant|tool, content, toolCalls?, createdAt }
ToolCall   { id, name, input, output?, status: pending|running|done|error, fileDiffs? }
PermissionRequest { id, type, description, args, granted? }   // POST /permissions/grant
Question   { id, prompt, choices?, answered? }                // POST /questions/answer
```

### 3.2 状态分层

- **TanStack Query**:workspaces、sessions 列表、历史消息(分页)、providers、LSP 诊断;
  可缓存、按需失效。
- **Zustand(`agentStore`)**:激活会话消息流、进行中的 tool calls、权限/提问队列、
  SSE 连接状态。SSE 事件 → store action → React 渲染,单向数据流。
- **每会话独立分片**:多会话并行时以 `sessionId` 为 key 存储,互不干扰。

## 4. 核心组件

```
<AppShell>                        // Tauri 窗口布局:侧边栏 + 主区
├─ <WorkspaceSidebar>            // 项目列表(多 workspace 切换,激活态高亮)
├─ <SessionTabs>                 // 当前项目内多会话 tab + 新建会话
├─ <AgentPanel>                  // 核心:流式消息/工具调用/diff
│  ├─ <MessageList>              // 虚拟滚动,Markdown 渲染
│  ├─ <ToolCallCard>             // 名称/参数/状态/折叠输出
│  ├─ <FileDiffView>             // 工具产生的文件改动(与 rune diff 对齐)
│  ├─ <PermissionDialog>         // 权限请求:详情 + 允许/拒绝/记住
│  └─ <QuestionDialog>           // agent 提问:单选/自由输入
├─ <FileExplorer> + <MonacoEditor>   // 只读+可编辑落盘(与 filetracker 同步)
├─ <TerminalPanel>(xterm.js)     // 内嵌 shell,与 rune 工作目录一致
└─ <GitPanel>                    // 分支/状态/diff,操作走 agent 或本地 git
```

### 关键交互

- 发送消息 → `POST /agent`(带 run_id)→ SSE 事件驱动渲染;多个会话可并发各自运行。
- 权限/提问弹窗为**模态优先队列**:多个请求排队,逐个人工处理。
- 文件改动:agent 改文件后 filetracker 事件 → 编辑器对应 tab 刷新 + diff 徽标。
- 模型切换:`GET /v1/.../providers` 只读展示,`PUT session` 切换模型。

## 5. 错误处理与边界

| 场景 | 处理 |
|---|---|
| rune server 未启动/崩溃 | Rust 壳自动拉起并轮询 `/v1/health`;状态栏显示连接状态 |
| SSE 断线 | 指数退避重连;重连后拉取 history 对账补漏;断线时防误提交 |
| 并发冲突 | 多会话并行编辑同一文件 → diff 视图标注冲突,不自动覆盖 |
| 权限/提问超时 | 60s 无响应 → 标记挂起,可手动处理,不阻塞其他会话 |
| 错误展示 | 统一 `proto.Error` 解析,错误卡片内联在对应消息/tool call 下 |

## 6. 测试策略

| 层 | 方式 |
|---|---|
| Rust 代理 | axum 路由单测 + 对真实 rune server 的集成测试(启动子进程发请求) |
| API client | openapi 生成类型 + fetch 封装单测(mock 响应) |
| Zustand store | SSE 事件序列 → store 状态断言(核心:多会话并发不串数据) |
| 组件 | Vitest + Testing Library:MessageList / ToolCallCard / 权限弹窗 |
| E2E | Playwright(dev 模式连本地代理):建会话→发消息→收流式回复→权限弹窗→完成 |

## 7. 里程碑

- **M1 垂直切片**:Rust 壳 + 代理 + rune 自动启动 → 项目列表 → 会话 tab → 流式聊天 +
  工具调用折叠 + 权限/提问弹窗。端到端"下任务→执行→完成"。
- **M2 文件与编辑**:文件树 + Monaco + filetracker 同步 + 文件 diff 视图 + LSP 诊断展示。
- **M3 终端与 git**:xterm 内嵌终端 + Git 面板。
- **M4 打磨**:模型切换 UX、多会话编排视图、设置页、打包分发。

每个里程碑可独立运行,验证方式见测试策略。

## 8. 非目标(v1 不做)

- 不做 agent 编排/团队模式(多角色分工协作)。
- 不做 provider 配置管理(只读展示,配置沿用 rune)。
- 不做云端/多人协作,纯本地单机。
