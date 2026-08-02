# 多 Agent 后端支持设计

- **日期**: 2026-08-02
- **状态**: 已批准（设计阶段），待实现规划
- **作者**: combo 团队
- **相关分支**: `feat/m1-vertical-slice`

## 1. 背景与动机

combo 目前是一个**单后端**应用：前端（React/TS）与 Rust 代理层（`crates/combo-proxy`）深度耦合到 **crush（rune server）** 这一个 agent 后端。整个应用层契约——REST 端点、双层 SSE 事件信封、消息部件类型、权限/问答模型——都是 crush 的原生协议，且**没有任何抽象层**（代理层是纯字节转发）。

用户希望 combo 能作为**多个不同 agent 后端**的统一前端，第一批目标：

| 后端 | 接口形态 | 集成难度 |
|------|----------|----------|
| crush (rune) | HTTP REST + SSE（unix socket） | 已集成（基线） |
| OpenCode | HTTP REST + SSE（`opencode serve`，`:4096`） + 官方 TS/Py SDK | 低（与 crush 同构） |
| Claude Code | 纯 CLI/stdio，`claude -p --output-format stream-json` 产 newline-delimited JSON；Agent SDK（Py/TS）经 stdio 交互 | 高（需 stdio→事件合成） |
| Codex (OpenAI) | `codex app-server` 是 JSON-RPC 2.0（stdio/ws/unix）；或 `codex exec --json` 产 JSONL | 高（需 JSON-RPC→REST/SSE 合成） |

**pi、zcode**：同为 agent，但接口未明，**本次不在范围内**，待后续确认接口特性后按对应模式（同构走阶段 1，process 型走阶段 2）接入。

## 2. 核心设计决策

经讨论确认两个根本性架构选择：

### 决策 1：统一抽象层（Canonical Adapter）

combo 定义自己的内部协议（统一的消息/工具/权限/SSE 事件模型），代理层为每个后端实现 adapter，把后端原生协议翻译成 combo 的统一模型。前端只与统一模型打交道，不关心后端是谁。

**否决的备选**：前端为每个后端写原生 API client（前端要维护 N 套，UI 组件要适配多模型，维护成本高）。

### 决策 2：适配层放在 Rust 代理层（combo-proxy）

所有协议翻译在 `crates/combo-proxy` 内完成。后端差异（stdio streaming-JSON / JSON-RPC / HTTP）全部在 Rust 层吸收，对外始终暴露 combo 统一的 REST + SSE。**前端几乎零改动**（继续调现有的 `/v1/*`）。

理由：
- combo-proxy 已在做进程管理（`RuneManager` spawn crush），是天然的抽象边界。
- Rust 擅长子进程生命周期、streaming 解析、高性能流式翻译。
- 改动集中在一个语言（Rust），前端耦合深、改动风险大，保持前端协议不变可把风险降到最低。

## 3. 统一内部协议——以 crush 协议为基线

**最关键、最省力的策略**：combo 的「统一内部协议」≈ crush 现有的 REST + SSE 形状，但收归为 combo 自己的定义（去掉对 crush Go 包名、socket 约定的依赖）。

理由：
- 前端已经在用这套协议，**零改动**即可继续工作。
- `CrushBackend` 适配器几乎是**恒等映射**（pass-through），改造它等于免费获得第一个后端。
- 其他后端各自负责把自己的协议翻译成这个形状。

combo-proxy 对外永远是同一套 `/v1/*` REST + 双层 SSE 信封：
```
{ type: <PayloadType>, payload: { type: "created"|"updated"|"deleted", payload: <data> } }
```
对内根据 workspace 绑定的后端类型，分派到不同 adapter。

## 4. Backend 抽象（Rust）

### 4.1 Backend trait

定义承载所有后端差异的 trait：

```rust
#[async_trait]
pub trait Backend: Send + Sync {
    /// 启动后端（拉起进程/建立连接），返回就绪
    async fn ensure_running(&self) -> Result<()>;
    /// 健康探测
    async fn health(&self) -> Result<()>;
    /// 优雅关闭
    async fn shutdown(&self) -> Result<()>;

    /// 处理一个 combo 协议请求 → 返回响应（body 可为流式）
    async fn handle(&self, req: ComboRequest) -> Result<ComboResponse>;

    /// 订阅事件流（转成 combo 统一 SSE 信封）
    fn events(&self, client_id: &str) -> EventStream;

    /// workspace 的本地根目录（供文件服务用，不再依赖后端）
    fn workspace_root(&self) -> &Path;
}
```

### 4.2 两种后端形态

| 形态 | 后端 | combo-proxy 如何处理 |
|------|------|----------------------|
| **Server 型** | crush、OpenCode | 后端监听 HTTP/Unix socket，adapter 转发请求 + 做轻量协议字段映射，SSE 直接桥接。OpenCode 同构，几乎直通。 |
| **Process 型** | Claude Code、Codex | combo-proxy 直接管理子进程的 stdin/stdout，把 streaming-JSON（claude `--output-format stream-json`）或 JSON-RPC（codex app-server）解析后，**合成** combo 的 REST 响应 + SSE 事件流。 |

Process 型是工作量大头：combo-proxy 内部要为它们起一个「虚拟后端」，把无状态/会话化的 stdio 流映射成 combo 的 workspace/session 模型。

### 4.3 目录结构

```
crates/combo-proxy/src/
  backend/
    mod.rs          # Backend trait、BackendType 枚举、工厂/注册表
    proto.rs        # combo 统一协议定义（请求/响应/SSE 事件模型）
    crush.rs        # crush 适配器（≈ 现有 rune.rs 进程管理 + 恒等转发）
    opencode.rs     # OpenCode（HTTP 同构，轻量字段映射 + SSE 桥接）
    claude_code.rs  # Claude Code（stdio streaming-JSON → REST/SSE 合成）
    codex.rs        # Codex（JSON-RPC app-server → REST/SSE 合成）
  rune.rs           # 保留为 CrushBackend 的进程管理实现细节，或并入 backend/crush.rs
  fs.rs             # 改为调 Backend::workspace_root()，不再硬查 crush /v1/workspaces/{id}
  handler.rs / router.rs  # 改为把请求分派给当前 workspace 的 Backend
  meta.rs           # combo 元数据层（workspace 持久化，见第 6 节）
```

## 5. 统一事件模型

combo 定义自己的 SSE 事件分类（以现有 `src/lib/events/payloadTypes.ts` 的 `PAYLOAD_TYPES` 为基线收归为 combo 自有）。前端 M1 用到的子集及其各后端映射：

| combo 事件 | crush | OpenCode | Claude Code | Codex |
|------------|-------|----------|-------------|-------|
| `message`（部件: text/reasoning/tool_call/tool_result/image） | 直通 upsert | `message.part.updated` | `assistant` + `stream_event` delta（`content_block_delta`） | `item/agentMessage/delta`、`item/commandExecution`、`item/fileChange` |
| `run_complete` | `run_complete` | `session.idle` | `result` | `turn/completed` |
| `permission_request` | 直通 | `permission.asked` | `--permission-prompt-tool` / SDK `canUseTool` 回调 | `item/*/requestApproval` |
| `question_batch_request` | 直通 | 映射到 elicitation | `tool/requestUserInput` | `mcpServer/elicitation/request` |
| `session` (created/updated/deleted) | session 事件 | `session.*` 事件 | `thread.started` / 会话生命周期 | `thread/started` |

每个 adapter 在 `events()` 里把原生流翻译成这张表——这是 adapter 的核心职责。`ContentPart` 部件类型保持现有联合（`reasoning | text | image_url | binary | tool_call | tool_result | finish | shell_command`），各后端映射到最接近的部件。

## 6. workspace ↔ backend 绑定与元数据层

### 6.1 关键演进：workspace 归 combo 所有

当前 workspace 元数据（id/path）存在 crush 里（`.crush/`），combo 只是转发。多后端下——OpenCode 叫 "session"、Claude Code 只有 session 无 workspace、Codex 是 thread——**workspace 概念必须由 combo 自己拥有**。

### 6.2 设计

- **combo 引入轻量元数据层**（`meta.rs`）：combo 自己存 workspace（`id`、`path`、`backend_type`、`config`），用 SQLite（经 `rusqlite`，纯 Rust，无外部依赖）或本地 JSON 文件。存于 combo 数据目录（如 `~/.combo/meta.db`）。
- combo-proxy 持 `HashMap<workspace_id, Arc<dyn Backend>>`，按 workspace 分派请求。
- **session/message 委托给后端**（各后端有自己的会话模型），combo 通过 adapter 读写；workspace 元数据归 combo。
- 创建 workspace 时选 `backend_type`（默认 crush）。`agentStore`（`src/stores/agentStore.ts`）的 persist（localStorage key `combo.agent`）扩展存该字段。

### 6.3 文件服务解耦

`fs.rs` 当前通过 `GET /v1/workspaces/{id}` 查 crush 拿 workspace 的 `path`。改造后：combo 从自己的元数据层拿 `path`（`Backend::workspace_root()`），文件服务的 list/read/write 逻辑不变，仅数据来源切换。文件服务路由（`/v1/workspaces/:id/files/*`）继续由 combo-proxy 本地处理，不转发给后端。

## 7. 分阶段路线图

| 阶段 | 内容 | 验证目标 |
|------|------|----------|
| **0. 重构（行为不变）** | 引入 `Backend` trait + `proto.rs`；把现有 crush 逻辑重构为 `CrushBackend`（恒等转发）；`fs.rs` 改用 `workspace_root()`；引入 combo 元数据层（`meta.rs`）。 | 现有 Rust 测试 + 前端行为**完全不变**。纯结构性重构，是一切的基础与安全网。 |
| **1. OpenCode** | 同构 HTTP adapter + SSE 桥接；workspace 增加 backend 选择 UI。 | 验证 server 型 adapter 可行，成本最低。 |
| **2. Claude Code** | stdio `stream-json` → REST/SSE 合成；permission 经 MCP tool。 | 验证 process 型 adapter，映射最复杂。 |
| **3. Codex** | JSON-RPC app-server → REST/SSE 合成。 | 第二个 process 型，复用阶段 2 模式。 |
| **4. 前端打磨** | backend 选择 UI、健康/状态展示、后端配置项。 | 完整产品体验。 |

每个阶段都值得独立的 spec→plan→实现周期。**阶段 0 是最高优先级**：它不改变任何用户可见行为，但为后续所有阶段奠定抽象基础。

> **本spec 是多 agent 支持的总体设计文档。** 它不描述单一实现任务的全部细节，而是确立架构方向与各阶段边界。下一步的实现规划（plan）将**首先聚焦阶段 0（行为不变的重构）**；阶段 1+ 各自后续生成独立 plan。

## 8. 前端改动（最小化）

得益于「适配层在代理层」决策，前端改动极小：
- `agentStore` persist 扩展：存 `activeBackendType`（或随 workspace 元数据一起）。
- workspace 创建流程增加 backend 选择 UI（`src/components/`，中文文案，e2e 依赖）。
- 其余 API 调用（`src/lib/api/index.ts`）、SSE 解析（`src/lib/events/`）、UI 组件（`agent/`）**完全不变**。

## 9. 风险与未决项

| 风险/未决项 | 说明 | 缓解 |
|-------------|------|------|
| Process 型会话映射 | Claude Code/Codex 的 session/thread 模型与 crush 的 session 不完全对应（如会话恢复、fork）。 | adapter 内维护映射表；M1 先支持基本对话流，会话恢复等高级特性后续迭代。 |
| 权限模型差异 | 各后端权限粒度/动作不同（crush 的 allow/allow_session/deny vs codex 的 accept/acceptForSession/decline/cancel）。 | 统一映射到 combo 的 `PermissionGrant`（`allow`/`allow_session`/`deny`），未覆盖的动作降级到最接近项。 |
| 元数据层引入新依赖 | SQLite（`rusqlite`）需 bundled feature 或系统 sqlite。 | 优先用 `rusqlite` 的 `bundled` feature（编译自带 sqlite，无系统依赖）；或退而用 JSON 文件（M1 数据量小）。 |
| SSE 信封双嵌套 | combo 继续沿用 crush 的双层信封，process 型 adapter 需主动构造这层包装。 | 在 `proto.rs` 提供构造辅助函数，所有 adapter 复用。 |
| 二进制发现 | 各后端 CLI 路径（`claude`/`codex`/`opencode`）需配置。 | 沿用 `COMBO_CRUSH_BIN` 模式，新增 `COMBO_CLAUDE_BIN`/`COMBO_CODEX_BIN`/`COMBO_OPENCODE_BIN` 环境变量，带 PATH 探测。 |

## 10. 不在本次范围内

- **pi、zcode** 接入（接口未明，待确认后按对应模式接入）。
- 多 agent **并发编排**（同时运行多个 agent 协作）——本次仅支持「一次会话一个后端，可切换」。
- 后端的高级特性对齐（MCP/LSP/config 管理、会话 fork/revert/summarize 等）——超出 M1 范围，后续按需补齐。
- combo 元数据层的多用户/同步/迁移工具——M1 单机单用户即可。
