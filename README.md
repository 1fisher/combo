# combo

<div align="center">

[![CI / Release](https://github.com/1fisher/combo/actions/workflows/release.yml/badge.svg)](https://github.com/1fisher/combo/actions/workflows/release.yml)
[![Release](https://img.shields.io/github/v/release/1fisher/combo)](https://github.com/1fisher/combo/releases)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Last Commit](https://img.shields.io/github/last-commit/1fisher/combo)](https://github.com/1fisher/combo)

**一个界面,多个 Agent 后端。**

combo 是一款开源的多 Agent IDE 桌面应用:用统一的界面同时驱动
[combo-cli](crates/combo-cli)(combo 自有 agent,rig 驱动)、[OpenCode](https://github.com/sst/opencode)、
[Claude Code](https://docs.anthropic.com/en/docs/claude-code) 等 coding agent,
在一个工作区里并发跑多个会话、对比不同模型的输出。

Tauri v2 桌面端 + React 19 / TypeScript 前端,通过内置 Rust 反向代理
(`combo-proxy`)与各 agent 后端通信——所有协议差异(REST、stdio streaming-JSON、
JSON-RPC)都在代理层吸收,前端永远只面对一套统一的 REST + SSE 契约。

</div>

---

## 功能特性

- 🤖 **多后端统一前端** —— 在同一个 UI 里切换 / 并发使用 combo-cli、OpenCode、Claude Code、Codex。
  代理层为每个后端实现 adapter,把原生协议翻译成 combo 统一的消息 / 工具 / 权限 / SSE 模型。
- 💬 **多会话并发** —— 每个工作区可同时打开多个会话,SSE 实时推送,按 `sessionId` 分片管理状态。
- 🛠️ **工具调用与权限弹窗** —— agent 的工具调用、权限请求、提问都在 UI 内以模态队列呈现,
  支持逐条批准 / 拒绝。
- 📂 **内置文件浏览与编辑** —— 代理层提供本地文件读写服务(目录列表 / 读取 / 原子写入),
  前端 FileExplorer + EditorPane 可直接查看与编辑工作区文件。
- 🖥️ **纯浏览器可开发** —— 前端不依赖任何 Tauri API,`npm run dev` 即可在浏览器中完整调试。
- 🔌 **进程托管** —— Tauri 壳内 `ComboCliManager` 自动 spawn / 守护 combo-cli serve 子进程,
  健康轮询、崩溃自动重启、退出优雅关停。
- 🌊 **SSE 流式透传** —— 代理层不缓冲流式响应,token 逐字到达前端。

## 架构

```
┌──────────────────────────────────────────────────────────────┐
│                    Tauri Webview (React / TS)                │
│   fetch / EventSource                                        │
└──────────────────────────┬───────────────────────────────────┘
                           │  http://127.0.0.1:<随机端口>/v1/*
                           ▼
┌──────────────────────────────────────────────────────────────┐
│            combo-proxy  (axum 反向代理 + adapter 层)          │
│   Backend trait  →  ComboCliBackend / OpenCodeBackend /          │
│                    ClaudeCodeBackend / CodexBackend           │
│   · 协议翻译 (REST / stdio JSON / JSON-RPC → 统一模型)        │
│   · CORS + SSE 流式透传                                       │
│   · 本地文件读写服务 (fs.rs)                                  │
└──────┬───────────────┬──────────────┬──────────────┬─────────┘
       ▼               ▼              ▼              ▼
  combo-cli serve   opencode serve   claude -p      codex app-server
  (:4096 HTTP)      (:4096 HTTP)    (stdio JSON)   (JSON-RPC)
```

三大组件:

| 组件 | 目录 | 说明 |
|------|------|------|
| **combo-proxy** | `crates/combo-proxy/` | Rust 反向代理 + adapter 层。监听 `127.0.0.1:0` 随机端口,把 `/v1/*` 路由到工作区绑定的后端 adapter;SSE 流式透传;CORS 放行 `tauri://localhost` 与 `http://localhost:5173`。 |
| **Tauri 壳** | `src-tauri/` | 启动 `ComboCliManager` + 代理,健康轮询,崩溃自动重启,退出优雅关停;代理端口通过 Tauri event 推送给前端。 |
| **前端** | `src/` | React 19 + Vite + shadcn/ui(Radix + Tailwind)。TanStack Query 管 REST,Zustand 按 `sessionId` 分片管 SSE 实时状态。 |

## 运行前提

- **Node.js** ≥ 20 与 npm
- **Rust** ≥ 1.80(确保 `~/.cargo/bin` 在 `PATH` 中)
- **Tauri 系统依赖**:
  - macOS:Xcode Command Line Tools
  - Linux:`libwebkit2gtk-4.1-dev libgtk-3-dev libdbus-1-dev pkg-config build-essential`
  - Windows:Microsoft C++ Build Tools 与 WebView2
- **Agent 后端二进制**(按需,至少一个):
  - [combo-cli](crates/combo-cli)(combo 自有 agent,rig 驱动)—— **默认后端**,`cargo build -p combo-cli` 后把二进制放入 `PATH` 或设 `COMBO_CLI_BIN`
  - [opencode](https://github.com/sst/opencode)
  - [claude](https://docs.anthropic.com/en/docs/claude-code)(Claude Code CLI)
  - [codex](https://github.com/openai/codex)

## 安装与使用

### 方式一:桌面应用(Tauri)

```bash
git clone https://github.com/1fisher/combo.git
cd combo
npm install
```

使用 Tauri CLI 启动(需 Rust 工具链自带的 `cargo tauri`):

```bash
cargo tauri dev
```

Tauri 壳会自动启动 combo-proxy 与 combo-cli serve(默认 agent),无需手动配置。
启动后通过 UI「添加项目」创建工作区,选择后端类型即可开始对话。

> ⚠️ 注意:仓库内**没有** `tauri` npm 脚本,也未安装 `@tauri-apps/cli`,
> 请使用 `cargo tauri dev`(Rust 工具链)。`bundle.active` 当前为 `false`,
> 打包流程尚未配置。

### 方式二:纯浏览器开发模式(推荐日常调试)

需要两个终端。

**终端 1** —— 启动 Vite,并通过 `VITE_PROXY_URL` 直连 combo-proxy:

```bash
bash scripts/dev-proxy.sh
# 等价于:VITE_PROXY_URL=http://127.0.0.1:18234 npm run dev
```

**终端 2** —— 一步编译并启动 combo-proxy(自动构建 combo-cli 并托管为默认 agent):

```bash
bash scripts/dev-backend.sh          # 等价于:构建 combo-cli → 以 target/debug/combo-cli 为默认 agent 启动 proxy
```

然后浏览器打开 **http://localhost:5173**。

## 环境变量

| 变量 | 说明 |
|------|------|
| `COMBO_CLI_BIN` | combo-cli serve 二进制路径(默认取 `PATH` 上的 `combo-cli`)。默认 agent,缺失时 proxy 仍可启动(combo-cli 项目 502)。E2E 与 combo-cli 集成测试依赖它。 |
| `COMBO_IT_DIR` | E2E 工作区目录(默认 `/tmp/combo-e2e`)。 |
| `VITE_PROXY_URL` | 浏览器模式下代理基地址,如 `http://127.0.0.1:18234`。Tauri 模式自动取代理事件端口(2s 回退到 `:18234`)。 |

## 常用脚本

```bash
npm run dev                 # Vite dev server(strictPort 5173,浏览器模式)
npm run build               # tsc -b && vite build(生产构建,输出 dist/)
npm run tsc                 # tsc -b(项目引用增量类型检查)
npm test                    # vitest run(jsdom 环境)
npm run test:e2e            # Playwright(未设 COMBO_CLI_BIN 时自动跳过)
npm run gen:api             # 由 swagger/swagger.json 重新生成 src/lib/api/types.ts
cargo test -p combo-proxy   # Rust 单测 + 集成测试
cargo run -p combo-proxy --bin combo-proxy -- --port 18234   # 代理独立运行
```

## 测试

```bash
# 前端
npm test                              # Vitest 单测(Testing Library + jsdom)
npx tsc --noEmit                      # 类型检查
npm run build                         # 生产构建

# Rust
cargo test -p combo-proxy             # 单测 + proxy 集成(内存 stub upstream)

# E2E(需真实 combo-cli 二进制)
COMBO_CLI_BIN=/path/to/combo-cli npx playwright test
```

> E2E 会在运行前**清空工作区目录**(`/tmp/combo-e2e`)。未设置 `COMBO_CLI_BIN` 时 spec 自动跳过。

## 持续集成 (CI)

GitHub Actions 工作流 [CI / Release](.github/workflows/release.yml) 自动运行在
每次 push 到 `main` 与 PR 上,包含:

| 作业 | 内容 |
|------|------|
| **CI Frontend** | `npm ci` → `npm run tsc` → `npm test` → `npm run build`(Node 22) |
| **CI Backend** | `cargo check --workspace` → `cargo test --workspace`(Rust stable,含 Tauri Linux 系统依赖) |
| **Bump Version** | `workflow_dispatch` 手动触发:版本 bump + 生成 changelog + 打 tag 推送 |
| **Build** | 对 tag(`v*`) 推送或手动触发,多平台矩阵构建安装包 |
| **Publish Release** | 构建产物发布为 GitHub Release |

工作流状态与最新发布版本见 README 顶部徽章。

## 目录结构

```
combo/
├── crates/combo-proxy/   Rust 反向代理 + Backend adapter 层(库 + 二进制)
│   └── src/              handler / router / combocli / upstream / fs / backend trait
├── src-tauri/            Tauri 壳(启动 ComboCliManager + 代理,init_backend)
├── src/                  前端(React 19 + Vite + TS + shadcn/ui)
│   ├── components/       ui/(shadcn 基础组件) shell/(应用骨架) agent/(对话/工具/弹窗)
│   ├── hooks/            TanStack Query hooks + SSE 生命周期(useWorkspaceEvents)
│   ├── lib/
│   │   ├── api/          API client(types.ts 由 swagger 生成 + 手维护 Api 命名空间)
│   │   ├── events/       SSE 客户端 + 事件分发(dispatch 解包双层信封)
│   │   └── connection.ts 代理地址发现 + 健康轮询
│   └── stores/           Zustand(agentStore:按 sessionId 分片,权限 / 提问队列)
├── swagger/              从 rune 仓库复制的 OpenAPI 契约(来源 commit 见 swagger/README.md)
├── e2e/                  Playwright 端到端测试
├── docs/superpowers/     设计文档与实现计划(specs / plans)
└── scripts/              开发辅助脚本(dev-proxy.sh、gen-api.sh)
```

## 工作原理要点

- **统一内部协议**:combo 对外永远暴露同一套 `/v1/*` REST + 双层 SSE 信封
  `{ type, payload: { type, payload } }`,以 rune 兼容协议为基线。`ComboCliBackend` 近似恒等映射,
  其他后端各自把自己的协议(stdio JSON / JSON-RPC)翻译成这套形状。前端无需关心后端是谁。
- **`client_id` 身份机制**:`apiRequest` 自动注入 `client_id` 查询参数(UUID,持久化于
  `localStorage`)。注意 `createWorkspace` 必须把 `client_id` **同时放进请求 body**(后端从
  body 校验)。SSE 订阅也携带它。
- **SSE 双层信封**:`GET /v1/workspaces/{id}/events?client_id=...`,`Accept: text/event-stream`。
  每个 `data:` 是 `{ type: <PayloadType>, payload: { type: "created"|"updated"|"deleted", payload: <data> } }`,
  由 `src/lib/events/dispatch.ts` 解包一层后写入 Zustand store。
- **Run 生命周期**:`onSend` 生成 `runId`,乐观插入用户消息,POST 后标记 run 为 `running`;
  `run_complete` 事件标记 `done`。注意 message 的 `streaming` 标志一旦置 `true` 不会重置——
  完成与否看 **run 状态**,不是 message 标志。
- **前端不依赖 Tauri API**:整个应用在纯浏览器中可开发调试;目录选择用路径输入框降级。

## 贡献

欢迎提 Issue 与 Pull Request!请确保:

1. 新增 / 修改的代码附带相应测试(Rust `cargo test`、前端 `npm test` 通过)。
2. 用户可见文案保持**中文**(与现有 UI、e2e 选择器一致)。
3. 涉及 API 契约变更时,同步更新 `swagger/` 与重新生成 `types.ts`(`npm run gen:api`)。
4. 提交信息遵循 [Conventional Commits](https://www.conventionalcommits.org/)。

## 许可证

本项目基于 [MIT License](./LICENSE) 开源,欢迎自由使用、修改与分发。
