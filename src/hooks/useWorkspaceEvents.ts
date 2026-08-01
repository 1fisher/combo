import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { applyEvent } from '../lib/events/dispatch';
import { WorkspaceEventSource } from '../lib/events/sse';
import { useAgentStore } from '../stores/agentStore';

export function useWorkspaceEvents(workspaceId: string | null) {
  const qc = useQueryClient();
  useEffect(() => {
    if (!workspaceId) return;
    const source = new WorkspaceEventSource(workspaceId, (env) => {
      const st = useAgentStore.getState();
      if (env.type === 'session') {
        void qc.invalidateQueries({ queryKey: ['sessions', workspaceId] });
        return;
      }
      applyEvent(st, env);
    });
    source.start();
    return () => source.stop();
  }, [workspaceId, qc]);
}
