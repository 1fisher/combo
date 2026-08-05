import { describe, expect, it, beforeEach } from 'vitest';
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
        type: 'created',
        payload: {
          id: 'm1',
          session_id: 's1',
          role: 'assistant',
          parts: [],
          created_at: 1,
          updated_at: 1,
        },
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
        type: 'created',
        payload: {
          id: 'm1',
          session_id: 's1',
          role: 'assistant',
          parts: [],
          created_at: 1,
          updated_at: 1,
        },
      },
    });
    applyEvent(s, {
      type: 'message',
      payload: {
        type: 'updated',
        payload: {
          id: 'm1',
          session_id: 's1',
          role: 'assistant',
          parts: [{ type: 'text', data: { text: 'hi' } }],
          created_at: 1,
          updated_at: 2,
        },
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
        type: 'created',
        payload: {
          id: 'p1',
          tool_call_id: 'tc1',
          tool_name: 'bash',
          description: 'run ls',
          action: '',
          path: '',
        },
      },
    });
    applyEvent(s, {
      type: 'permission_notification',
      payload: {
        type: 'updated',
        payload: { tool_call_id: 'tc1', granted: true },
      },
    });
    expect(useAgentStore.getState().permissionQueue).toEqual([]);
  });

  it('queues and dismisses question batches', () => {
    const s = useAgentStore.getState();
    applyEvent(s, {
      type: 'question_batch_request',
      payload: {
        type: 'created',
        payload: { id: 'q1', session_id: 's1', tool_call_id: 'tc1', questions: [] },
      },
    });
    expect(useAgentStore.getState().questionQueue).toHaveLength(1);
    applyEvent(s, {
      type: 'question_batch_notification',
      payload: { type: 'updated', payload: { batch_id: 'q1' } },
    });
    expect(useAgentStore.getState().questionQueue).toEqual([]);
  });

  it('removes optimistic local- messages when real user text message arrives', () => {
    const s = useAgentStore.getState();
    // 模拟 doSend 乐观插入
    s.upsertMessage('s1', {
      id: 'local-run1',
      session_id: 's1',
      role: 'user',
      parts: [{ type: 'text', data: { text: 'hello' } }],
      model: '',
      provider: '',
      created_at: 1,
      updated_at: 1,
    });
    // rune 回传真实用户消息(不同 id)
    applyEvent(s, {
      type: 'message',
      payload: {
        type: 'created',
        payload: {
          id: 'real-msg-1',
          session_id: 's1',
          role: 'user',
          parts: [{ type: 'text', data: { text: 'hello' } }],
          model: '',
          provider: '',
          created_at: 2,
          updated_at: 2,
        },
      },
    });
    const msgs = useAgentStore.getState().bySession['s1'].messages;
    expect(msgs.map((m) => m.id)).toEqual(['real-msg-1']);
    expect(msgs).toHaveLength(1);
  });

  it('does not remove optimistic messages for tool_result user messages', () => {
    const s = useAgentStore.getState();
    s.upsertMessage('s1', {
      id: 'local-run2',
      session_id: 's1',
      role: 'user',
      parts: [{ type: 'text', data: { text: 'hello' } }],
      model: '',
      provider: '',
      created_at: 1,
      updated_at: 1,
    });
    // tool_result 也是 role=user,但不应触发清除乐观消息
    applyEvent(s, {
      type: 'message',
      payload: {
        type: 'created',
        payload: {
          id: 'tool-result-1',
          session_id: 's1',
          role: 'user',
          parts: [{ type: 'tool_result', data: { tool_call_id: 'tc1', name: 'bash', content: 'ok' } }],
          model: '',
          provider: '',
          created_at: 2,
          updated_at: 2,
        },
      },
    });
    const msgs = useAgentStore.getState().bySession['s1'].messages;
    expect(msgs.map((m) => m.id)).toEqual(['local-run2', 'tool-result-1']);
  });

  it('marks run done on run_complete', () => {
    const s = useAgentStore.getState();
    applyEvent(s, {
      type: 'message',
      payload: {
        type: 'created',
        payload: {
          id: 'm1',
          session_id: 's1',
          role: 'assistant',
          parts: [],
          created_at: 1,
          updated_at: 1,
        },
      },
    });
    applyEvent(s, {
      type: 'run_complete',
      payload: {
        type: 'updated',
        payload: { session_id: 's1', run_id: 'r1', message_id: 'm1', text: 'ok' },
      },
    });
    expect(useAgentStore.getState().bySession['s1'].run).toEqual({
      runId: 'r1',
      status: 'done',
    });
  });
});
