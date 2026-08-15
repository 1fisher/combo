import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Api } from '../lib/api/types';

/** 统一归一化秒/毫秒时间戳为毫秒。 */
function toMs(ts: number): number {
  return ts > 1e12 ? ts : ts * 1000;
}

export interface MessageVM {
  id: string;
  role: 'user' | 'assistant' | 'tool' | 'system';
  parts: Api.ContentPart[];
  createdAt: number;
  updatedAt: number;
  streaming: boolean;
  /** 已全部完成的任务清单(上一轮 todo_write 的结果),归档为消息流中的一张任务卡片 */
  todoItems?: Api.TodoItem[];
}

export interface SessionRuntime {
  messages: MessageVM[];
  /** startedAt:run 进入 running 的时刻(执行耗时展示);done 后保留原值 */
  run: {
    runId: string;
    status: 'running' | 'done';
    error?: string;
    startedAt?: number;
  } | null;
  queued: boolean;
}

/** Agent 模式:与后端的 permission mode 对齐 */
export type AgentMode = 'yolo' | 'build' | 'edit' | 'plan';

/** yolo 模式自动放行全部权限;edit 模式自动放行写操作(build/edit 工具) */
export const WRITE_TOOL_NAMES = new Set([
  'write',
  'edit',
  'multiedit',
  'replace',
  'lsp_replace_symbol',
  'lsp_rename',
  'bash',
]);

/** 用户选中的模型(workspaceId → { model, provider }),持久化到 localStorage */
export interface ModelSelection {
  model: string;
  provider: string;
  /** 推理强度: nothink / high / max */
  reasoningEffort?: string;
}

interface AgentState {
  activeWorkspaceId: string | null;
  /** 上次选中项目的路径(后端重启后 ID 可能变化,用路径做恢复) */
  lastWorkspacePath: string | null;
  setActiveWorkspace: (id: string | null) => void;
  setLastWorkspacePath: (path: string | null) => void;
  activeSessionId: string | null;
  setActiveSessionId: (id: string | null) => void;
  agentMode: AgentMode;
  setAgentMode: (mode: AgentMode) => void;
  /** 每个 workspace 用户手动选中的模型,跨重启保留 */
  modelSelections: Record<string, ModelSelection>;
  setModelSelection: (workspaceId: string, sel: ModelSelection) => void;
  clearModelSelection: (workspaceId: string) => void;
  /** 手动设置的模型上下文窗口上限(key = 模型 id,单位 token),跨重启保留。
   *  按模型 id 而非 provider/model 存:同一模型(如 deepseek-v4-flash-free)可能
   *  同时挂在 opencode / opencode-zen 等多个 provider 下,按 provider 区分会导致
   *  设置值与当前会话模型对不上而"错乱"。 */
  contextOverrides: Record<string, number>;
  setContextOverride: (modelId: string, tokens: number) => void;
  clearContextOverride: (modelId: string) => void;

  bySession: Record<string, SessionRuntime>;
  permissionQueue: Api.PermissionRequest[];
  questionQueue: Api.QuestionRequest[];
  /** 每个 session 的任务列表(todo_write 工具推送,实时更新) */
  todos: Record<string, Api.TodoItem[]>;

  upsertMessage: (sessionId: string, m: Api.Message) => void;
  removeOptimisticMessages: (sessionId: string) => void;
  hydrateMessages: (sessionId: string, msgs: Api.Message[]) => void;
  deleteMessage: (sessionId: string, messageId: string) => void;
  markRun: (
    sessionId: string,
    runId: string,
    status: 'running' | 'done',
    error?: string
  ) => void;
  setQueued: (sessionId: string, queued: boolean) => void;
  enqueuePermission: (p: Api.PermissionRequest) => void;
  resolvePermission: (toolCallId: string) => void;
  enqueueQuestionBatch: (b: Api.QuestionRequest) => void;
  dismissQuestionBatch: (batchId: string) => void;
  setTodos: (sessionId: string, todos: Api.TodoItem[]) => void;
  clearTodos: (sessionId: string) => void;
  /** 把已全部完成的任务清单作为一张卡片消息插入消息流末尾(归档,不再占用输入坞上方) */
  insertTodoCard: (sessionId: string, runId: string, todos: Api.TodoItem[]) => void;
  clearSessionRuntime: (sessionId: string) => void;
}

const emptyRuntime = (): SessionRuntime => ({ messages: [], run: null, queued: false });

export const useAgentStore = create<AgentState>()(
  persist(
    (set) => ({
  activeWorkspaceId: null,
  lastWorkspacePath: null,
  setActiveWorkspace: (id) =>
    set((st) => ({
      activeWorkspaceId: id,
      // 切换项目时清空会话,避免把上一个项目的会话带到新项目
      ...(id !== st.activeWorkspaceId ? { activeSessionId: null } : {}),
    })),
  setLastWorkspacePath: (path) => set({ lastWorkspacePath: path }),
  agentMode: 'yolo' as AgentMode,
  setAgentMode: (mode) => set({ agentMode: mode }),
  modelSelections: {},
  setModelSelection: (workspaceId, sel) =>
    set((st) => ({
      modelSelections: { ...st.modelSelections, [workspaceId]: sel },
    })),
  clearModelSelection: (workspaceId) =>
    set((st) => {
      const { [workspaceId]: _drop, ...rest } = st.modelSelections;
      return { modelSelections: rest };
    }),
  contextOverrides: {},
  setContextOverride: (modelId, tokens) =>
    set((st) => ({
      contextOverrides: { ...st.contextOverrides, [modelId]: tokens },
    })),
  clearContextOverride: (modelId) =>
    set((st) => {
      const { [modelId]: _drop, ...rest } = st.contextOverrides;
      return { contextOverrides: rest };
    }),
  activeSessionId: null,
  setActiveSessionId: (id) => set({ activeSessionId: id }),

  bySession: {},
  permissionQueue: [],
  questionQueue: [],
  todos: {},

  upsertMessage: (sessionId, m) =>
    set((st) => {
      const rt = st.bySession[sessionId] ?? emptyRuntime();
      const idx = rt.messages.findIndex((x) => x.id === m.id);
      // 收到 finish part 的消息视为该条流式结束,
      // 不再依赖 run_complete 事件(可能延迟或丢失)
      // 后端返回的消息可能缺少 parts 字段(生成类型为 parts?: unknown[]),需兜底
      const parts = m.parts ?? [];
      const hasFinish = parts.some((p) => p.type === 'finish');
      const vm: MessageVM = {
        id: m.id,
        role: m.role,
        parts,
        createdAt: toMs(m.created_at),
        updatedAt: toMs(m.updated_at),
        streaming: hasFinish ? false : true,
      };
      // 新消息抵达时,更早的消息都已结束流式(同一时刻只有一条在流)。
      // 仅对流式中的消息做解构更新(保留其余消息的对象引用),
      // 让 React.memo(MessageItem) 在流式期间跳过未变化消息的重渲染。
      const messages =
        idx >= 0
          ? rt.messages.map((x, i) =>
              i === idx ? vm : x.streaming ? { ...x, streaming: false } : x
            )
          : [...rt.messages.map((x) => (x.streaming ? { ...x, streaming: false } : x)), vm];
      return { bySession: { ...st.bySession, [sessionId]: { ...rt, messages } } };
    }),

  removeOptimisticMessages: (sessionId) =>
    set((st) => {
      const rt = st.bySession[sessionId];
      if (!rt) return st;
      return {
        bySession: {
          ...st.bySession,
          [sessionId]: {
            ...rt,
            messages: rt.messages.filter((x) => !x.id.startsWith('local-')),
          },
        },
      };
    }),

  hydrateMessages: (sessionId, msgs) =>
    set((st) => {
      const rt = st.bySession[sessionId];
      const historyIds = new Set(msgs.map((m) => m.id));
      // 保留 store 中不在历史里的消息(SSE 实时推送的新消息),
      // 避免因 SSE 部分灌入导致完整历史被跳过
      const liveMessages = rt?.messages.filter((m) => !historyIds.has(m.id)) ?? [];
      const messages: MessageVM[] = [
        ...msgs.map((m) => ({
          id: m.id,
          role: m.role,
          parts: m.parts ?? [],
          createdAt: toMs(m.created_at),
          updatedAt: toMs(m.updated_at),
          streaming: false,
        })),
        ...liveMessages,
      ];
      // 消息 id 与 updatedAt 均未变化时跳过更新,避免不必要的渲染。
      // 必须比较 updatedAt:run 在未订阅期间结束时(run 于服务端收尾),
      // 同 id 消息的内容已更新(流式快照 → 最终版),仅比 id 会漏刷新。
      if (
        rt &&
        rt.messages.length === messages.length &&
        rt.messages.every((m, i) => m.id === messages[i].id && m.updatedAt === messages[i].updatedAt)
      ) {
        return st;
      }
      return {
        bySession: {
          ...st.bySession,
          [sessionId]: { ...(rt ?? emptyRuntime()), messages },
        },
      };
    }),

  deleteMessage: (sessionId, messageId) =>
    set((st) => {
      const rt = st.bySession[sessionId];
      if (!rt) return st;
      return {
        bySession: {
          ...st.bySession,
          [sessionId]: {
            ...rt,
            messages: rt.messages.filter((x) => x.id !== messageId),
          },
        },
      };
    }),

  markRun: (sessionId, runId, status, error) =>
    set((st) => {
      const rt = st.bySession[sessionId] ?? emptyRuntime();
      const ts = new Date().toISOString().slice(11, 23);
      console.debug(
        `[${ts}][store] markRun status="${status}" prev="${rt.run?.status ?? 'none'}" session="${sessionId}" msgCount=${rt.messages.length}`
      );
      const messages =
        status === 'done'
          ? rt.messages.map((m) => ({ ...m, streaming: false }))
          : rt.messages;
      // 进入 running 记录起点(输入坞上方「正在执行」耗时展示);
      // 收尾为 done 时保留原起点,便于需要时回看本轮耗时
      const startedAt =
        status === 'running' ? Date.now() : rt.run?.startedAt;
      return {
        bySession: {
          ...st.bySession,
          [sessionId]: {
            ...rt,
            run: {
              runId,
              status,
              ...(startedAt != null ? { startedAt } : {}),
              ...(error ? { error } : {}),
            },
            messages,
          },
        },
      };
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
  setTodos: (sessionId, todos) =>
    set((st) => ({ todos: { ...st.todos, [sessionId]: todos } })),
  clearTodos: (sessionId) =>
    set((st) => {
      const { [sessionId]: _drop, ...rest } = st.todos;
      return { todos: rest };
    }),
  insertTodoCard: (sessionId, runId, todos) =>
    set((st) => {
      const rt = st.bySession[sessionId] ?? emptyRuntime();
      const card: MessageVM = {
        id: `todo-${runId}`,
        role: 'system',
        parts: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
        streaming: false,
        todoItems: todos,
      };
      return {
        bySession: {
          ...st.bySession,
          [sessionId]: { ...rt, messages: [...rt.messages, card] },
        },
      };
    }),
  clearSessionRuntime: (sessionId) =>
    set((st) => {
      const { [sessionId]: _drop, ...rest } = st.bySession;
      return { bySession: rest };
    }),
    }),
    {
      name: 'combo.agent',
      // 只持久化选中态,SSE 实时状态(消息/队列)不入库
      partialize: (s) => ({
        activeWorkspaceId: s.activeWorkspaceId,
        lastWorkspacePath: s.lastWorkspacePath,
        activeSessionId: s.activeSessionId,
        agentMode: s.agentMode,
        modelSelections: s.modelSelections,
        contextOverrides: s.contextOverrides,
      }),
    }
  )
);
