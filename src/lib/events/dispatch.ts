import type { Api } from '../api/types';
import type { useAgentStore } from '../../stores/agentStore';
import type { EventEnvelope } from './payloadTypes';

type Store = ReturnType<typeof useAgentStore.getState>;

// 后端的 SSE 信封是两层:外层 type 是 PayloadType,内层是
// { type: created|updated|deleted, payload: <真实数据> }。
function unwrap<T>(env: EventEnvelope): T {
  return (env.payload as { type: string; payload: T }).payload;
}

function ts() {
  return new Date().toISOString().slice(11, 23);
}

export function applyEvent(s: Store, env: EventEnvelope): void {
  switch (env.type) {
    case 'message': {
      const p = unwrap<Api.Message>(env);
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
        s.markRun(p.session_id, p.id, 'done');
      }
      break;
    }
    case 'run_complete': {
      const p = unwrap<{ session_id: string; run_id?: string; error?: string }>(env);
      console.debug(
        `[${ts()}][dispatch] ✓ run_complete session="${p.session_id}" run="${p.run_id}" error="${p.error ?? ''}"`
      );
      s.markRun(p.session_id, p.run_id || p.session_id, 'done', p.error);
      break;
    }
    case 'permission_request':
      s.enqueuePermission(unwrap<Api.PermissionRequest>(env));
      break;
    case 'permission_notification': {
      const p = unwrap<{ tool_call_id: string }>(env);
      s.resolvePermission(p.tool_call_id);
      break;
    }
    case 'question_batch_request':
      s.enqueueQuestionBatch(unwrap<Api.QuestionRequest>(env));
      break;
    case 'question_batch_notification': {
      const p = unwrap<{ batch_id: string }>(env);
      s.dismissQuestionBatch(p.batch_id);
      break;
    }
    case 'todo_update': {
      const inner = env.payload as { type: string; payload: unknown };
      if (inner.type === 'updated') {
        const p = inner.payload as { session_id: string; todos: Api.TodoItem[] };
        s.setTodos(p.session_id, p.todos);
      } else if (inner.type === 'deleted') {
        const p = inner.payload as { session_id: string };
        s.clearTodos(p.session_id);
      }
      break;
    }
    default:
      console.debug(
        `[${ts()}][dispatch] 未处理事件 type="${env.type}"`
      );
      break;
  }
}
