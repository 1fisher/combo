import type { Api } from '../api/types';
import type { useAgentStore } from '../../stores/agentStore';
import type { EventEnvelope } from './payloadTypes';
import { notifyPermissionRequest, notifyQuestionRequest, notifyRunComplete, runCompleteSummary } from '../notify';

type Store = ReturnType<typeof useAgentStore.getState>;

// 后端的 SSE 信封是两层:外层 type 是 PayloadType,内层是
// { type: created|updated|deleted, payload: <真实数据> }。
function unwrap<T>(env: EventEnvelope): T {
  return (env.payload as { type: string; payload: T }).payload;
}

function ts() {
  return new Date().toISOString().slice(11, 23);
}

export function applyEvent(s: Store, env: EventEnvelope, workspaceId?: string): void {
  switch (env.type) {
    case 'message': {
      const inner = env.payload as { type: string; payload: unknown };
      // 消息删除(上下文压缩时批量清除旧消息)
      if (inner.type === 'deleted') {
        const p = inner.payload as { id: string; session_id: string };
        console.debug(
          `[${ts()}][dispatch] message deleted id="${p.id}" session="${p.session_id}"`
        );
        s.deleteMessage(p.session_id, p.id);
        break;
      }
      const p = inner.payload as Api.Message;
      const partTypes = (p.parts ?? []).map((pt) => pt.type).join(',');
      const hasFinish = (p.parts ?? []).some((pt) => pt.type === 'finish');
      console.debug(
        `[${ts()}][dispatch] message id="${p.id}" role="${p.role}" inner="${(env.payload as { type: string }).type}" parts=[${partTypes}] hasFinish=${hasFinish} session="${p.session_id}"`
      );
      // 后端会回传用户文本消息,与乐观插入的 local- 消息重复,先清除
      if (p.role === 'user' && (p.parts ?? []).some((part) => part.type === 'text')) {
        s.removeOptimisticMessages(p.session_id);
      }
      s.upsertMessage(p.session_id, p);
      // assistant 消息带 finish part → 视为本次 run 完成
      if (p.role === 'assistant' && hasFinish) {
        const finishData = (p.parts ?? []).find((pt) => pt.type === 'finish')?.data as { reason?: string };
        console.debug(
          `[${ts()}][dispatch] ✓ finish detected reason="${finishData?.reason ?? ''}" → markRun done`
        );
        const wasRunning = s.bySession[p.session_id]?.run?.status === 'running';
        // markRun 可能就地回收非当前会话的运行态,摘要需先于其提取
        const summary = wasRunning ? runCompleteSummary(p.session_id) : '';
        s.markRun(p.session_id, p.id, 'done');
        if (wasRunning) {
          notifyRunComplete(p.session_id, finishData?.reason === 'error' ? '任务运行出错' : undefined, summary, finishData?.reason);
        }
      }
      break;
    }
    case 'run_complete': {
      const p = unwrap<{ session_id: string; run_id?: string; error?: string; reason?: string }>(env);
      console.debug(
        `[${ts()}][dispatch] ✓ run_complete session="${p.session_id}" run="${p.run_id}" error="${p.error ?? ''}"`
      );
      const cur = s.bySession[p.session_id]?.run;
      // 过期收尾防护:取消后立刻重发时,旧 run 的收尾事件可能晚于新 run 到达;
      // run_id 对不上且当前有新 run 在跑时忽略,避免把新 run 误标为完成。
      if (cur?.status === 'running' && p.run_id && cur.runId !== p.run_id) {
        console.debug(
          `[${ts()}][dispatch] 忽略过期 run_complete(cur="${cur.runId}" recv="${p.run_id}")`
        );
        break;
      }
      const wasRunning = cur?.status === 'running';
      const summary = wasRunning ? runCompleteSummary(p.session_id) : '';
      s.markRun(p.session_id, p.run_id || p.session_id, 'done', p.error);
      // 子 agent 进度面板随 run 收尾清空(最终结果已落 tool_result 消息)
      s.clearSubAgents(p.session_id);
      if (wasRunning) notifyRunComplete(p.session_id, p.error, summary, p.reason);
      break;
    }
    case 'usage': {
      // API 调用次数(rig turns 计数):每次 completion 调用完成实时推送,
      // payload 携带该会话的累计值,Composer 底部「调用次数」取用。
      const p = unwrap<{ session_id: string; api_calls: number }>(env);
      console.debug(
        `[${ts()}][dispatch] usage session="${p.session_id}" api_calls=${p.api_calls}`
      );
      s.setApiCalls(p.session_id, p.api_calls);
      break;
    }
    case 'permission_request': {
      const p = unwrap<Api.PermissionRequest>(env);
      // 去重:多 workspace 聚合订阅下,切换项目瞬间新旧两条连接可能并存,
      // 同一请求会经两条连接各送达一次,弹窗与通知都只应出现一次。
      if (s.permissionQueue.some((q) => q.tool_call_id === p.tool_call_id)) break;
      s.enqueuePermission(p);
      notifyPermissionRequest(p);
      break;
    }
    case 'permission_notification': {
      const p = unwrap<{ tool_call_id: string }>(env);
      s.resolvePermission(p.tool_call_id);
      break;
    }
    case 'question_batch_request': {
      const p = unwrap<Api.QuestionRequest>(env);
      // 去重:同上(聚合订阅切换瞬间的双连接竞态)
      if (s.questionQueue.some((b) => b.id === p.id)) break;
      // 记录来源 workspace:问题卡片可能跨项目展示,回答时按此路由
      s.enqueueQuestionBatch(p, workspaceId);
      notifyQuestionRequest(p);
      break;
    }
    case 'question_batch_notification': {
      const p = unwrap<{ batch_id: string }>(env);
      s.dismissQuestionBatch(p.batch_id);
      break;
    }
    case 'todo_update': {
      const inner = env.payload as { type: string; payload: unknown };
      if (inner.type === 'updated') {
        const p = inner.payload as { session_id: string; todos: Api.TodoItem[] };
        // 归一化旧后端的 "inprogress"(serde lowercase 产物)为 "in_progress",
        // 否则前端按 'in_progress' 匹配不到,当前项会错位到第一条 pending。
        const todos = p.todos.map((t) => ({
          ...t,
          status: t.status === ('inprogress' as Api.TodoStatus) ? 'in_progress' : t.status,
        }));
        s.setTodos(p.session_id, todos);
      } else if (inner.type === 'deleted') {
        const p = inner.payload as { session_id: string };
        s.clearTodos(p.session_id);
      }
      break;
    }
    case 'subagent_update': {
      // 多 agent 子任务进度(agent 工具派发,全量快照替换)
      const inner = env.payload as { type: string; payload: unknown };
      if (inner.type === 'updated') {
        const p = inner.payload as { session_id: string; tasks: Api.SubAgentTask[] };
        console.debug(
          `[${ts()}][dispatch] subagent_update session="${p.session_id}" tasks=${p.tasks
            .map((t) => `${t.agent}:${t.status}`)
            .join(',')}`
        );
        s.setSubAgents(p.session_id, p.tasks);
      } else if (inner.type === 'deleted') {
        const p = inner.payload as { session_id: string };
        s.clearSubAgents(p.session_id);
      }
      break;
    }
    case 'retry_notice': {
      // provider 流被截断自动重试提示:输入区上方展示一条临时提示条
      const p = unwrap<{ session_id: string; text: string }>(env);
      console.debug(
        `[${ts()}][dispatch] retry_notice session="${p.session_id}" text="${p.text}"`
      );
      s.setRetryNotice(p.session_id, p.text);
      break;
    }
    default:
      console.debug(
        `[${ts()}][dispatch] 未处理事件 type="${env.type}"`
      );
      break;
  }
}
