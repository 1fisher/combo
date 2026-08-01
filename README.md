# combo

combo 是一款配合 [rune](https://charm.sh/crush)(Charm Crush 服务端)的多 agent IDE。Tauri 桌面壳 + React/TypeScript 前端,前端通过内置反向代理与 rune server 通信,支持多个工作区/会话并发的 agent 对话、工具调用、权限与提问弹窗。

## 架构

```
Tauri Webview (React/TS)
   fetch / EventSource ──→ http://127.0.0.1:<随机端口>/v1/*
                                  │ combo-proxy(axum 反向代理,仅转发,CORS + SSE 透传)
                                  ▼
                        rune server(crush server 子进程, unix socket)
```

- **combo-proxy**(`crates/combo-proxy`):纯转发反向代理,监听 `127.0.0.1:0` 随机端口,把 `/v1/*` 转发到 rune 的 unix socket;SSE 流式透传不缓冲;CORS 放行 `tauri://localhost` 与 `http://localhost:5173`。
- **RuneManager**(`src-tauri/src/lib.rs`):Tauri 壳内启动/守护 rune 子进程(`crush server`),健康轮询,崩溃自动重启,退出时优雅关停;代理端口通过 Tauri event 推送给前端。
- **前端**:React 19 + Vite + shadcn/ui(Radix + Tailwind)。TanStack Query 管 REST 数据,Zustand 以 sessionId 分片管 SSE 实时状态。

## 运行前提

- Node.js ≥ 20,npm
- Rust ≥ 1.80(`~/.cargo/bin` 记得加入 PATH)
- [crush](https://charm.sh/crush) 二进制(可选;桌面模式自动 spawn,dev 模式通过 `COMBO_CRUSH_BIN` 指定)
- Tauri 系统依赖(`libwebkit2gtk-4.1-dev libgtk-3-dev libdbus-1-dev pkg-config build-essential`)

## 运行方式

### 桌面应用(Tauri)

```bash
npm install
npm run tauri dev
```

Tauri 壳自动启动 combo-proxy 与 rune server,无需手动配置。

### 纯浏览器开发模式(推荐日常调试)

终端 1:启动 Vite,并通过 `VITE_PROXY_URL` 直连 combo-proxy

```bash
bash scripts/dev-proxy.sh   # 等价于 VITE_PROXY_URL=http://127.0.0.1:18234 npm run dev
```

终端 2:启动 combo-proxy(自动 spawn rune;rune 二进制默认取 PATH 上的 `crush`,可用环境变量覆盖)

```bash
cargo run -p combo-proxy --bin combo-proxy -- --port 18234
# COMBO_CRUSH_BIN=/path/to/crush 覆盖 rune 二进制路径
```

然后浏览器打开 http://localhost:5173。

## 环境变量

| 变量 | 说明 |
|---|---|
| `COMBO_CRUSH_BIN` | rune 服务端二进制路径(默认取 PATH 上的 `crush`) |
| `VITE_PROXY_URL` | 浏览器模式下代理基地址,如 `http://127.0.0.1:18234`;Tauri 模式自动取代理事件端口 |

## 测试

```bash
cargo test -p combo-proxy              # Rust 单测 + 集成(含 rune 集成,需 COMBO_CRUSH_BIN)
npx vitest run                         # 前端单测(Vitest + Testing Library)
npx tsc --noEmit                       # 类型检查
npm run build                          # 生产构建
COMBO_CRUSH_BIN=/path/to/crush npx playwright test   # E2E(需真实 rune 二进制)
```

## 目录结构

```
crates/combo-proxy/   Rust 反向代理(库 + 二进制)
src-tauri/            Tauri 壳(启动 RuneManager + 代理)
src/
  components/         UI(shadcn 基础组件 + shell/agent 业务组件)
  hooks/              TanStack Query hooks + SSE 生命周期(useWorkspaceEvents)
  lib/
    api/              API client(types.ts 由 swagger 生成,index.ts 封装)
    events/           SSE 客户端 + 事件分发(dispatch 处理 rune 事件信封)
    connection.ts     代理地址发现 + 健康轮询
  stores/             Zustand(agentStore:按 sessionId 分片,权限/提问队列)
swagger/              从 rune 仓库复制的 OpenAPI 契约(来源 commit 见 swagger/README.md)
e2e/                  Playwright 端到端测试
scripts/              开发辅助脚本(dev-proxy.sh、gen-api.sh)
```

## 关键约定

- API 契约以 `swagger/swagger.json` 为准(复制自 rune 仓库,来源 commit 见 `swagger/README.md`);运行 `npm run gen:api` 重新生成 `src/lib/api/types.ts`。
- 所有 rune 请求由 `apiRequest` 自动注入 `client_id` 查询参数(UUID,持久化于 localStorage `combo.clientId`);`createWorkspace` 额外在 body 携带 `client_id`(rune 从 body 校验)。
- SSE 订阅:`GET /v1/workspaces/{id}/events?client_id=<uuid>`,`Accept: text/event-stream`。事件信封为 `{ "type": "<payload_type>", "payload": { "type": "created|updated|deleted", "payload": <真实数据> } }`,由 `src/lib/events/dispatch.ts` 解包后写入 store。
- 前端数据路径不依赖 Tauri API(纯浏览器可开发调试);M1 的目录选择用路径输入框降级方案。
