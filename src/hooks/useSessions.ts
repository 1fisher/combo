import { useEffect, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createSession,
  deleteSession,
  getSessionHistory,
  listSessions,
  setCurrentSession,
} from '../lib/api';
import { useAgentStore } from '../stores/agentStore';

export function useSessions(workspaceId: string | null) {
  const qc = useQueryClient();
  const setActiveSessionId = useAgentStore((s) => s.setActiveSessionId);
  const activeSessionId = useAgentStore((s) => s.activeSessionId);
  const q = useQuery({
    queryKey: ['sessions', workspaceId],
    queryFn: () => listSessions(workspaceId!),
    enabled: !!workspaceId,
  });
  // 记录刚创建的会话 id:列表失效后重新拉取前,q.data 还是旧数据,
  // 不能让"会话不在列表"的校验把它清掉
  const lastCreated = useRef<string | null>(null);
  const create = useMutation({
    mutationFn: (title: string) => createSession(workspaceId!, title),
    onSuccess: (s) => {
      lastCreated.current = s.id;
      qc.invalidateQueries({ queryKey: ['sessions', workspaceId] });
      void activate(s.id);
    },
  });
  async function activate(sessionId: string) {
    setActiveSessionId(sessionId);
    if (workspaceId) {
      qc.invalidateQueries({ queryKey: ['history', workspaceId, sessionId] });
      try {
        await setCurrentSession(workspaceId, sessionId);
      } catch {
        /* rune 离线时不阻塞前端切换 */
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
  // 持久化恢复的会话不属于当前项目(或已被删除)时清除,不主动选第一个
  useEffect(() => {
    if (!workspaceId || !q.data || activeSessionId == null) return;
    if (activeSessionId === lastCreated.current) return;
    if (!q.data.some((s) => s.id === activeSessionId)) {
      setActiveSessionId(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, q.data, activeSessionId]);
  return { sessions: q.data, isLoading: q.isLoading, create: create.mutateAsync, activate, remove: remove.mutateAsync };
}

export function useSessionHistory(workspaceId: string | null, sessionId: string | null) {
  return useQuery({
    queryKey: ['history', workspaceId, sessionId],
    queryFn: () => getSessionHistory(workspaceId!, sessionId!),
    enabled: !!workspaceId && !!sessionId,
  });
}
