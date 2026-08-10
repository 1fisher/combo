import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { applyEvent } from '../lib/events/dispatch';
import { WorkspaceEventSource } from '../lib/events/sse';
import { persistMessage } from '../lib/api';
import type { Api } from '../lib/api/types';
import { useAgentStore } from '../stores/agentStore';

export function useWorkspaceEvents(workspaceId: string | null) {
  const qc = useQueryClient();
  const setActiveWorkspace = useAgentStore((s) => s.setActiveWorkspace);
  useEffect(() => {
    if (!workspaceId) return;
    const source = new WorkspaceEventSource(
      workspaceId,
      (env) => {
        const st = useAgentStore.getState();
        if (env.type === 'session') {
          void qc.invalidateQueries({ queryKey: ['sessions', workspaceId] });
          // 某些场景不发 finish part / run_complete 事件,
          // 而是通过 session.is_busy=false 表示运行结束。
          // 检测该信号并标记 run 完成。
          const inner = env.payload as { type: string; payload: { id?: string; is_busy?: boolean } };
          const sess = inner?.payload;
          if (sess?.id && sess.is_busy === false) {
            const rt = st.bySession[sess.id];
            if (rt?.run?.status === 'running') {
              const ts = new Date().toISOString().slice(11, 23);
              console.debug(
                `[${ts}][events] session.is_busy=false → markRun done session="${sess.id}"`
              );
              st.markRun(sess.id, rt.run.runId, 'done');
            }
          }
          return;
        }
        applyEvent(st, env);
        // 收到 message 事件时 fire-and-forget 持久化到后端 sqlite
        if (env.type === 'message') {
          const inner = env.payload as { type: string; payload: Api.Message };
          const msg = inner?.payload;
          if (msg?.id && !msg.id.startsWith('local-')) {
            void persistMessage(workspaceId, msg).catch(() => {});
          }
        }
      },
      {
        onGone: () => setActiveWorkspace(null),
      }
    );
    source.start();
    return () => source.stop();
  }, [workspaceId, qc, setActiveWorkspace]);
}
