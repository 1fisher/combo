import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createSession,
  deleteSession,
  getSessionHistory,
  listSessions,
  renameSession,
  setCurrentSession,
} from '../lib/api';
import { useAgentStore } from '../stores/agentStore';

/**
 * 模块级集合:记录最近创建的会话 ID。
 * useSessions 被多个组件同时调用(AgentPanel / ConversationList / WorkspaceSidebar),
 * 每个实例有自己的 lastCreated ref,无法互相感知。
 * 用共享集合确保任一实例创建的会话都不会被其他实例的 stale-guard 清除。
 */
const recentlyCreated = new Set<string>();
/** 标记后 5 秒内不被 stale-guard 清除(足够 sessions 列表 refetch 完成) */
function markCreated(id: string) {
  recentlyCreated.add(id);
  setTimeout(() => recentlyCreated.delete(id), 5000);
}

export function useSessions(workspaceId: string | null) {
  const qc = useQueryClient();
  const setActiveSessionId = useAgentStore((s) => s.setActiveSessionId);
  const activeSessionId = useAgentStore((s) => s.activeSessionId);
  const q = useQuery({
    queryKey: ['sessions', workspaceId],
    queryFn: () => listSessions(workspaceId!),
    enabled: !!workspaceId,
  });
  const create = useMutation({
    mutationFn: (title: string) => createSession(workspaceId!, title),
    onSuccess: (s) => {
      markCreated(s.id);
      qc.invalidateQueries({ queryKey: ['sessions', workspaceId] });
    },
  });
  async function activate(sessionId: string) {
    setActiveSessionId(sessionId);
    if (workspaceId) {
      qc.invalidateQueries({ queryKey: ['history', workspaceId, sessionId] });
      try {
        await setCurrentSession(workspaceId, sessionId);
      } catch {
        /* 后端离线时不阻塞前端切换 */
      }
    }
  }
  const remove = useMutation({
    mutationFn: (sessionId: string) => deleteSession(workspaceId!, sessionId),
    onSuccess: (_data, deletedId) => {
      qc.invalidateQueries({ queryKey: ['sessions', workspaceId] });
      if (activeSessionId === deletedId) {
        setActiveSessionId(null);
      }
    },
  });
  const rename = useMutation({
    mutationFn: (vars: { id: string; title: string }) =>
      renameSession(workspaceId!, vars.id, vars.title),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sessions', workspaceId] }),
  });
  // 持久化恢复的会话不属于当前项目(或已被删除)时清除,不主动选第一个。
  // 跳过最近创建的会话(列表 refetch 可能尚未完成)。
  useEffect(() => {
    if (!workspaceId || !q.data || activeSessionId == null) return;
    if (recentlyCreated.has(activeSessionId)) return;
    if (!q.data.some((s) => s.id === activeSessionId)) {
      setActiveSessionId(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, q.data, activeSessionId]);
  return { sessions: q.data, isLoading: q.isLoading, create: create.mutateAsync, activate, remove: remove.mutateAsync, rename: rename.mutateAsync };
}

export function useSessionHistory(workspaceId: string | null, sessionId: string | null) {
  return useQuery({
    queryKey: ['history', workspaceId, sessionId],
    queryFn: () => getSessionHistory(workspaceId!, sessionId!),
    enabled: !!workspaceId && !!sessionId,
  });
}
