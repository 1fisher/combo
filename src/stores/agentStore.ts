import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Api } from '../lib/api/types';

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
  setActiveWorkspace: (id: string | null) => void;
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
  setActiveWorkspace: (id) =>
    set((st) => ({
      activeWorkspaceId: id,
      // 切换项目时清空会话,避免把上一个项目的会话带到新项目
      ...(id !== st.activeWorkspaceId ? { activeSessionId: null } : {}),
    })),
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
      const vm: MessageVM = {
        id: m.id,
        role: m.role,
        parts: m.parts,
        createdAt: m.created_at,
        updatedAt: m.updated_at,
        streaming: true,
      };
      const messages =
        idx >= 0
          ? rt.messages.map((x, i) => (i === idx ? vm : x))
          : [...rt.messages, vm];
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
      // 已有消息(来自 SSE 实时流)时不覆盖
      if (rt && rt.messages.length > 0) return st;
      const messages: MessageVM[] = msgs.map((m) => ({
        id: m.id,
        role: m.role,
        parts: m.parts,
        createdAt: m.created_at,
        updatedAt: m.updated_at,
        streaming: false,
      }));
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
        activeSessionId: s.activeSessionId,
        agentMode: s.agentMode,
      }),
    }
  )
);
