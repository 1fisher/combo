import type { Api } from '../api/types';
import type { useAgentStore } from '../../stores/agentStore';
import type { EventEnvelope } from './payloadTypes';

type Store = ReturnType<typeof useAgentStore.getState>;

export function applyEvent(s: Store, env: EventEnvelope): void {
  switch (env.type) {
    case 'message': {
      const p = env.payload as Api.Message;
      s.upsertMessage(p.session_id, p);
      break;
    }
    case 'run_complete': {
      const p = env.payload as { session_id: string; run_id?: string; error?: string };
      s.markRun(p.session_id, p.run_id || p.session_id, 'done');
      break;
    }
    case 'permission_request':
      s.enqueuePermission(env.payload as Api.PermissionRequest);
      break;
    case 'permission_notification': {
      const p = env.payload as { tool_call_id: string };
      s.resolvePermission(p.tool_call_id);
      break;
    }
    case 'question_batch_request':
      s.enqueueQuestionBatch(env.payload as Api.QuestionRequest);
      break;
    case 'question_batch_notification': {
      const p = env.payload as { batch_id: string };
      s.dismissQuestionBatch(p.batch_id);
      break;
    }
    default:
      break; // M1 忽略其余事件
  }
}
