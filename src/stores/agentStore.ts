import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Api } from '../lib/api/types';

/** crush 返回秒级时间戳,前端用毫秒;统一归一化为毫秒。 */
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
}

export interface SessionRuntime {
  messages: MessageVM[];
  run: { runId: string; status: 'running' | 'done' } | null;
  queued: boolean;
}

/** Agent 模式:与 crush 的 permission mode 对齐 */
export type AgentMode = 'yolo' | 'build' | 'edit' | 'plan';

/** yolo 模式自动放行全部权限;edit 模式自动放行写操作(build/edit 工具) */
export const WRITE_TOOL_NAMES = new Set([
  'write',
  'edit',
  'multiedit',
  'lsp_replace_symbol',
  'lsp_rename',
  'bash',
]);

interface AgentState {
  activeWorkspaceId: string | null;
  /** 上次选中项目的路径(crush 重启后 ID 会变,用路径做恢复) */
  lastWorkspacePath: string | null;
  setActiveWorkspace: (id: string | null) => void;
  setLastWorkspacePath: (path: string | null) => void;
  activeSessionId: string | null;
  setActiveSessionId: (id: string | null) => void;
  agentMode: AgentMode;
  setAgentMode: (mode: AgentMode) => void;

  bySession: Record<string, SessionRuntime>;
  permissionQueue: Api.PermissionRequest[];
  questionQueue: Api.QuestionRequest[];

  upsertMessage: (sessionId: string, m: Api.Message) => void;
  removeOptimisticMessages: (sessionId: string) => void;
  hydrateMessages: (sessionId: string, msgs: Api.Message[]) => void;
  deleteMessage: (sessionId: string, messageId: string) => void;
  markRun: (sessionId: string, runId: string, status: 'running' | 'done') => void;
  setQueued: (sessionId: string, queued: boolean) => void;
  enqueuePermission: (p: Api.PermissionRequest) => void;
  resolvePermission: (toolCallId: string) => void;
  enqueueQuestionBatch: (b: Api.QuestionRequest) => void;
  dismissQuestionBatch: (batchId: string) => void;
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
  activeSessionId: null,
  setActiveSessionId: (id) => set({ activeSessionId: id }),

  bySession: {},
  permissionQueue: [],
  questionQueue: [],

  upsertMessage: (sessionId, m) =>
    set((st) => {
      const rt = st.bySession[sessionId] ?? emptyRuntime();
      const idx = rt.messages.findIndex((x) => x.id === m.id);
      // 收到 finish part 的消息视为该条流式结束,
      // 不再依赖 run_complete 事件(可能延迟或丢失)
      // rune 返回的消息可能缺少 parts 字段(生成类型为 parts?: unknown[]),需兜底
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
      // 新消息抵达时,更早的消息都已结束流式(同一时刻只有一条在流)
      const messages =
        idx >= 0
          ? rt.messages.map((x, i) =>
              i === idx ? vm : { ...x, streaming: false }
            )
          : [...rt.messages.map((x) => ({ ...x, streaming: false })), vm];
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
      // 消息 id 列表未变化时跳过更新,避免不必要的渲染
      if (
        rt &&
        rt.messages.length === messages.length &&
        rt.messages.every((m, i) => m.id === messages[i].id)
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

  markRun: (sessionId, runId, status) =>
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
      return {
        bySession: {
          ...st.bySession,
          [sessionId]: { ...rt, run: { runId, status }, messages },
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
      }),
    }
  )
);
