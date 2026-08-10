import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { applyEvent } from '../lib/events/dispatch';
import { WorkspaceEventSource } from '../lib/events/sse';
import { persistMessage } from '../lib/api';
import type { Api } from '../lib/api/types';
import { useAgentStore } from '../stores/agentStore';

/**
 * 消息持久化串行队列:SSE 事件按顺序到达,但 fire-and-forget 的 POST 若并发
 * 发出可能乱序到达后端,导致同一秒内的消息(assistant 与 user 常同秒)在
 * sqlite 中的插入顺序错位,进而让历史回放顺序颠倒(工具调用场景会触发
 * provider 400)。串行执行保证插入顺序 = 事件顺序。
 */
let persistChain: Promise<unknown> = Promise.resolve();
function enqueuePersist(workspaceId: string, msg: Api.Message) {
  persistChain = persistChain
    .catch(() => {})
    .then(() => persistMessage(workspaceId, msg).catch(() => {}));
}

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
        // 收到 message 事件时按事件顺序串行持久化到后端 sqlite
        if (env.type === 'message') {
          const inner = env.payload as { type: string; payload: Api.Message };
          const msg = inner?.payload;
          if (msg?.id && !msg.id.startsWith('local-')) {
            enqueuePersist(workspaceId, msg);
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
