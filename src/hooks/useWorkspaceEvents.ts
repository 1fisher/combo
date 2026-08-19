import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { applyEvent } from '../lib/events/dispatch';
import { WorkspaceEventSource } from '../lib/events/sse';
import { notifyRunComplete, runCompleteSummary } from '../lib/notify';
import { useAgentStore } from '../stores/agentStore';

/**
 * 会话事件负载:run 启动/结束时 serve 广播(含 SSE 订阅快照),
 * 前端据此恢复/收敛运行态。消息持久化已由 serve 服务端落库,
 * 前端不再经 SSE 回写(多会话并发时未订阅的 workspace 也能保留完整历史)。
 * `cleared` 为 `/clear` 命令清空会话后的通知(任意一端发起,所有端联动)。
 */
interface SessionEventPayload {
  id: string;
  is_busy?: boolean;
  run_id?: string;
  cleared?: boolean;
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
          const inner = env.payload as { type: string; payload: SessionEventPayload };
          const sess = inner?.payload;
          if (!sess?.id) return;
          if (sess.cleared) {
            // /clear 清空(本端或其他端发起):清内存消息与调用计数,
            // 并刷新历史缓存(该会话消息已全部删除)
            st.clearSessionRuntime(sess.id);
            st.resetApiCalls(sess.id);
            void qc.invalidateQueries({ queryKey: ['history', workspaceId, sess.id] });
            return;
          }
          const rt = st.bySession[sess.id];
          if (sess.is_busy === false) {
            // run 结束(含订阅快照对账):收敛仍标记为 running 的本地状态,
            // 修复「切走再切回时错过 run_complete 导致会话永远转圈」。
            if (rt?.run?.status === 'running') {
              const ts = new Date().toISOString().slice(11, 23);
              console.debug(
                `[${ts}][events] session.is_busy=false → markRun done session="${sess.id}"`
              );
              // markRun 可能就地回收非当前会话的运行态,摘要需先于其提取
              const summary = runCompleteSummary(sess.id);
              st.markRun(sess.id, rt.run.runId, 'done');
              notifyRunComplete(sess.id, undefined, summary);
            }
          } else if (sess.is_busy === true) {
            // run 启动/快照:本地无运行态时恢复(如刷新页面后重连、
            // 切回仍有任务在跑的项目),阻止向运行中的会话重复发送。
            if (rt?.run?.status !== 'running') {
              const runId = sess.run_id ?? `server-${sess.id}`;
              const ts = new Date().toISOString().slice(11, 23);
              console.debug(
                `[${ts}][events] session.is_busy=true → markRun running session="${sess.id}" run="${runId}"`
              );
              st.markRun(sess.id, runId, 'running');
            }
          }
          return;
        }
        applyEvent(st, env);
        // run 结束后刷新会话列表(token/cost/is_busy 已更新)
        if (env.type === 'run_complete') {
          void qc.invalidateQueries({ queryKey: ['sessions', workspaceId] });
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
