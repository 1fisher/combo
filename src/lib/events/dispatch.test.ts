import { describe, expect, it, vi, beforeEach } from 'vitest';
import { applyEvent } from './dispatch';
import { useAgentStore } from '../../stores/agentStore';

describe('applyEvent', () => {
  beforeEach(() =>
    useAgentStore.setState({
      bySession: {},
      permissionQueue: [],
      questionQueue: [],
    })
  );

  it('upserts message into its session slice', () => {
    const s = useAgentStore.getState();
    applyEvent(s, {
      type: 'message',
      payload: {
        id: 'm1',
        session_id: 's1',
        role: 'assistant',
        parts: [],
        created_at: 1,
        updated_at: 1,
      },
    });
    const after = useAgentStore.getState();
    expect(after.bySession['s1'].messages.map((m) => m.id)).toEqual(['m1']);
  });

  it('replaces message with same id (streaming update)', () => {
    const s = useAgentStore.getState();
    applyEvent(s, {
      type: 'message',
      payload: {
        id: 'm1',
        session_id: 's1',
        role: 'assistant',
        parts: [],
        created_at: 1,
        updated_at: 1,
      },
    });
    applyEvent(s, {
      type: 'message',
      payload: {
        id: 'm1',
        session_id: 's1',
        role: 'assistant',
        parts: [{ type: 'text', data: { text: 'hi' } }],
        created_at: 1,
        updated_at: 2,
      },
    });
    const after = useAgentStore.getState();
    expect(after.bySession['s1'].messages).toHaveLength(1);
    expect(after.bySession['s1'].messages[0].parts).toEqual([
      { type: 'text', data: { text: 'hi' } },
    ]);
  });

  it('queues and resolves permission requests', () => {
    const s = useAgentStore.getState();
    applyEvent(s, {
      type: 'permission_request',
      payload: {
        id: 'p1',
        tool_call_id: 'tc1',
        tool_name: 'bash',
        description: 'run ls',
        action: '',
        path: '',
      },
    });
    applyEvent(s, {
      type: 'permission_notification',
      payload: { tool_call_id: 'tc1', granted: true },
    });
    expect(useAgentStore.getState().permissionQueue).toEqual([]);
  });

  it('queues and dismisses question batches', () => {
    const s = useAgentStore.getState();
    applyEvent(s, {
      type: 'question_batch_request',
      payload: { id: 'q1', session_id: 's1', tool_call_id: 'tc1', questions: [] },
    });
    expect(useAgentStore.getState().questionQueue).toHaveLength(1);
    applyEvent(s, {
      type: 'question_batch_notification',
      payload: { batch_id: 'q1' },
    });
    expect(useAgentStore.getState().questionQueue).toEqual([]);
  });

  it('marks run done on run_complete', () => {
    const s = useAgentStore.getState();
    applyEvent(s, {
      type: 'message',
      payload: {
        id: 'm1',
        session_id: 's1',
        role: 'assistant',
        parts: [],
        created_at: 1,
        updated_at: 1,
      },
    });
    applyEvent(s, {
      type: 'run_complete',
      payload: { session_id: 's1', run_id: 'r1', message_id: 'm1', text: 'ok' },
    });
    expect(useAgentStore.getState().bySession['s1'].run).toEqual({
      runId: 'r1',
      status: 'done',
    });
  });
});
