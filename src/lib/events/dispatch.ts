import type { Api } from '../api/types';
import type { useAgentStore } from '../../stores/agentStore';
import type { EventEnvelope } from './payloadTypes';

type Store = ReturnType<typeof useAgentStore.getState>;

// rune 的 SSE 信封是两层:外层 type 是 PayloadType,内层是
// { type: created|updated|deleted, payload: <真实数据> }。
function unwrap<T>(env: EventEnvelope): T {
  return (env.payload as { type: string; payload: T }).payload;
}

export function applyEvent(s: Store, env: EventEnvelope): void {
  switch (env.type) {
    case 'message': {
      const p = unwrap<Api.Message>(env);
      // rune 会回传用户文本消息,与乐观插入的 local- 消息重复,先清除
      if (p.role === 'user' && p.parts.some((part) => part.type === 'text')) {
        s.removeOptimisticMessages(p.session_id);
      }
      s.upsertMessage(p.session_id, p);
      // assistant 消息带 finish part → 视为本次 run 完成
      // (不依赖 run_complete 事件,crush 后端可能不发送该事件)
      if (p.role === 'assistant' && p.parts.some((part) => part.type === 'finish')) {
        s.markRun(p.session_id, p.id, 'done');
      }
      break;
    }
    case 'run_complete': {
      const p = unwrap<{ session_id: string; run_id?: string; error?: string }>(env);
      s.markRun(p.session_id, p.run_id || p.session_id, 'done');
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
    default:
      break; // M1 忽略其余事件
  }
}
