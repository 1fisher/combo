import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createSession,
  getSessionHistory,
  listSessions,
  setCurrentSession,
} from '../lib/api';
import { useAgentStore } from '../stores/agentStore';

export function useSessions(workspaceId: string | null) {
  const qc = useQueryClient();
  const setActiveSessionId = useAgentStore((s) => s.setActiveSessionId);
  const q = useQuery({
    queryKey: ['sessions', workspaceId],
    queryFn: () => listSessions(workspaceId!),
    enabled: !!workspaceId,
  });
  const create = useMutation({
    mutationFn: (title: string) => createSession(workspaceId!, title),
    onSuccess: (s) => {
      qc.invalidateQueries({ queryKey: ['sessions', workspaceId] });
      void activate(s.id);
    },
  });
  async function activate(sessionId: string) {
    setActiveSessionId(sessionId);
    if (workspaceId) {
      await setCurrentSession(workspaceId, sessionId);
      qc.invalidateQueries({ queryKey: ['history', workspaceId, sessionId] });
    }
  }
  return { sessions: q.data, isLoading: q.isLoading, create: create.mutateAsync, activate };
}

export function useSessionHistory(workspaceId: string | null, sessionId: string | null) {
  return useQuery({
    queryKey: ['history', workspaceId, sessionId],
    queryFn: () => getSessionHistory(workspaceId!, sessionId!),
    enabled: !!workspaceId && !!sessionId,
  });
}
