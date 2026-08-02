# 阶段 1：OpenCode 后端适配器 设计

- **日期**: 2026-08-02
- **状态**: 已批准
- **依赖**: 阶段 0（Backend trait、CrushBackend、MetaStore）已完成
- **总体设计文档**: `docs/superpowers/specs/2026-08-02-multi-agent-backend-support-design.md`

## 1. 范围

完整支持 OpenCode 作为 agent 后端：基础聊天 + 权限弹窗 + 问答弹窗。

### 包含
- OpenCode 进程管理（`opencode serve`）
- 多后端路由（按 workspace_id 分派到 crush 或 OpenCode）
- workspace 元数据由 combo 拥有（MetaStore 双写策略）
- OpenCodeBackend：REST 端点翻译（session/message/agent/cancel/permission/question）
- SSE 翻译（OpenCode 事件 → crush 双层信封）
- 前端：workspace 创建时选择后端类型

### 不包含
- OpenCode 配置管理（API key 设置等——通过 OpenCode 自己的 config）
- OpenCode 高级特性（fork/revert/share/summarize/init）
- OpenCode 内置文件服务（继续用 combo-proxy 的本地文件服务）

## 2. 多后端路由

### 2.1 BackendRegistry

`AppState` 演进为持有 `BackendRegistry`：

```rust
pub struct AppState {
    pub meta: Arc<MetaStore>,
    pub registry: Arc<BackendRegistry>,
}

pub struct BackendRegistry {
    crush: Arc<dyn Backend>,
    opencode: Option<Arc<dyn Backend>>,
}
```

`BackendRegistry` 方法：
- `get_for_workspace(&self, ws_id: &str) -> &Arc<dyn Backend>`：查 MetaStore 确定后端类型，返回对应 Backend。找不到时默认 crush。
- `get_by_type(&self, bt: BackendType) -> &Arc<dyn Backend>`

### 2.2 请求路由

proxy handler 改为：
1. 从 URL 解析 workspace_id
2. 查 MetaStore 确定后端类型
3. 调用对应 backend 的 forward()

### 2.3 workspace 双写

| 操作 | crush workspace | OpenCode workspace |
|------|-----------------|-------------------|
| `POST /v1/workspaces` | 转发给 crush 创建 + 写入 MetaStore（backend_type=Crush） | 仅写入 MetaStore（backend_type=OpenCode），combo 生成 ID |
| `GET /v1/workspaces` | 合并：MetaStore 中的所有 workspace | 同左 |
| `GET /v1/workspaces/{id}` | 从 MetaStore 返回 | 同左 |

## 3. REST 翻译映射

### 3.1 端点映射

| combo 端点 | OpenCode 调用 | 说明 |
|------------|--------------|------|
| `GET /v1/workspaces` | 本地 MetaStore | 无需后端 |
| `POST /v1/workspaces` | 本地 MetaStore (+ crush if crush) | 双写 |
| `GET /v1/workspaces/{id}` | 本地 MetaStore | 无需后端 |
| `GET /v1/workspaces/{id}/sessions` | `GET /session?directory={path}` | 字段映射 |
| `POST /v1/workspaces/{id}/sessions` | `POST /session` (body: `{title?}`) | 字段映射 |
| `GET .../sessions/{sid}/history` | `GET /session/{sid}/message` | 结构重组：`[{info, parts}]` → `Message[]` |
| `POST .../agent` | `POST /session/{sid}/prompt_async` | body 翻译 |
| `POST .../agent/sessions/{sid}/cancel` | `POST /session/{sid}/abort` | 直通 |
| `POST .../permissions/grant` | `POST /permission/{reqID}/reply` | action 映射 |
| `POST .../questions/answer` | `POST /session/{sid}/command` 或 question reply | 按实现而定 |
| `POST .../current-session` | 本地 MetaStore | 无需后端 |
| `GET .../events` | 连接 OpenCode `GET /event` | SSE 翻译（见 §4） |
| `GET /v1/health` | `GET /global/health` | 直通 |

### 3.2 Session 字段映射

| combo Session 字段 | OpenCode Session 字段 |
|--------------------|-----------------------|
| `id` | `id` |
| `title` | `title` |
| `message_count` | 从 `GET /session/{sid}/message` 推算（或默认 0） |
| `prompt_tokens` | 累加 AssistantMessage `tokens.input` |
| `completion_tokens` | 累加 AssistantMessage `tokens.output` |
| `cost` | 累加 AssistantMessage `cost` |
| `created_at` | `time.created`（毫秒→秒，需确认） |
| `updated_at` | `time.updated` |
| `is_busy` | 从 `GET /session/status` 推算 |

M1 简化：`message_count`/`prompt_tokens`/`completion_tokens`/`cost` 可用 0 或从最后一条 assistant message 取近似值。

### 3.3 Message 结构映射

OpenCode 返回 `[{info: Message, parts: Part[]}]`。翻译为 combo Message：

```
combo Message {
  id:          info.id,
  role:        info.role,  // "user"|"assistant"
  session_id:  info.sessionID,
  parts:       parts.map(part_to_content_part),
  model:       info.modelID || "",
  provider:    info.providerID || "",
  created_at:  info.time.created / 1000,
  updated_at:  (info.time.completed || info.time.created) / 1000,
}
```

### 3.4 ContentPart 映射

| OpenCode Part type | combo ContentPart |
|--------------------|-------------------|
| `{type:"text", text}` | `{type:"text", data:{text}}` |
| `{type:"reasoning", text}` | `{type:"reasoning", data:{thinking:text, signature:""}}` |
| `{type:"tool", tool, state:{status:"completed", output}}` | `{type:"tool_result", data:{tool_call_id:callID, name:tool, content:output}}` |
| `{type:"tool", tool, state:{status:"running"|pending}}` | `{type:"tool_call", data:{id:callID, name:tool, input:JSON.stringify(state.input)}}` |
| `{type:"step-finish", reason}` | `{type:"finish", data:{reason}}` |
| 其余（file/patch/agent/subtask） | 跳过 |

### 3.5 sendAgentMessage body 翻译

combo 收到 `{session_id, run_id, prompt}`，翻译为 OpenCode：
```json
POST /session/{sid}/prompt_async
{
  "parts": [{ "type": "text", "text": "<prompt>" }]
}
```
返回 204（异步）。流式结果通过 SSE 到达。

### 3.6 Permission 映射

| combo PermissionGrant | OpenCode reply |
|----------------------|----------------|
| `action: "allow"` | `{response: "once"}` |
| `action: "allow_session"` | `{response: "always"}` |
| `action: "deny"` | `{response: "reject"}` |

combo 的 `permission.tool_call_id` 对应 OpenCode 的 permission request ID。

## 4. SSE 翻译

### 4.1 架构

OpenCodeBackend 的 SSE 处理：
1. 连接 `GET /event?directory={workspace_path}`（OpenCode 标准 SSE）
2. 逐帧解析 `data: {json}\n\n`
3. 按 `type` 字段翻译为 crush 双层信封
4. 以 `text/event-stream` 返回给前端

### 4.2 事件映射

| OpenCode 事件 | combo 信封 |
|--------------|------------|
| `session.next.text.delta` `{delta, messageID, sessionID}` | `{type:"message", payload:{type:"updated", payload:{id:messageID, role:"assistant", session_id:sessionID, parts:[{type:"text",data:{text:delta}}], ...}}}` |
| `session.next.reasoning.delta` | 类似，parts 用 `{type:"reasoning",...}` |
| `session.next.tool.called` `{tool, input, callID}` | `{type:"message", payload:{type:"updated", payload:{parts:[{type:"tool_call",data:{id:callID,name:tool,input:JSON(input)}}]}}}` |
| `session.next.tool.success` `{callID, content}` | parts 用 `{type:"tool_result",data:{...}}` |
| `session.next.tool.failed` | parts 用 `{type:"tool_result",data:{...,is_error:true}}` |
| `session.status` `{status:{type:"idle"}}` | `{type:"run_complete", payload:{type:"updated", payload:{session_id, run_id}}}` |
| `session.created` | `{type:"session", payload:{type:"created", payload:{...}}}` |
| `session.updated` | `{type:"session", payload:{type:"updated", payload:{...}}}` |
| `permission.asked` | `{type:"permission_request", payload:{type:"created", payload:{...}}}` |
| `question.asked` | `{type:"question_batch_request", payload:{type:"created", payload:{...}}}` |

### 4.3 流式文本累积

`session.next.text.delta` 只含增量文本。翻译器需要：
1. 维护 `{messageID → accumulated_text}` 状态
2. 每收到 delta，累加文本后发送完整的 `message` updated 事件（前端 upsert 会覆盖）
3. `session.next.text.ended` 时做最终 flush

## 5. OpenCode 进程管理

`OpenCodeManager`（类似 `RuneManager`）：
- 二进制：`COMBO_OPENCODE_BIN` 环境变量，默认 `"opencode"` from PATH
- 启动：`opencode serve --port {port} --hostname 127.0.0.1`
- 端口：随机端口（`127.0.0.1:0`）
- 健康检查：`GET /global/health`（返回 `{healthy: true, version: ...}`）
- 关闭：kill 子进程
- 日志：`$TMPDIR/combo-opencode.log`

## 6. 前端改动

- `createWorkspace(path)` → `createWorkspace(path, backend)`：增加 `backend` 参数
- workspace 创建 UI：增加后端选择下拉（默认 crush）
- `agentStore` persist 扩展：存 `activeBackendType`（或随 workspace 一起）
- SSE 解析不变（翻译在 proxy 层完成）

## 7. 目录结构变更

```
crates/combo-proxy/src/
  backend/
    mod.rs          # +BackendType::OpenCode
    crush.rs        # 不变
    opencode.rs     # 新增：OpenCodeBackend + REST 翻译 + SSE 翻译
  manager/
    mod.rs          # 新增：统一后端管理（替代 main.rs/lib.rs 中的硬编码）
    opencode.rs     # 新增：OpenCodeManager
  meta.rs           # 扩展：workspace CRUD handler
  registry.rs       # 新增：BackendRegistry
  handler.rs        # 改为从 registry 获取 backend
  router.rs         # 增加 workspace CRUD 路由
```
