import { describe, expect, it, beforeEach, vi } from 'vitest';
import { applyEvent } from './dispatch';
import { useAgentStore } from '../../stores/agentStore';
import { notifyRunComplete } from '../notify';

// 只把 notifyRunComplete 换成 spy:断言收尾事件把 reason 透传给通知
// (取消时不能再误报「任务已完成」并播完成音);其余导出保持真实实现。
vi.mock('../notify', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../notify')>();
  return { ...actual, notifyRunComplete: vi.fn() };
});

describe('applyEvent', () => {
  beforeEach(() => {
    vi.mocked(notifyRunComplete).mockClear();
    useAgentStore.setState({
      // 测试场景均为正在查看 s1 的用户:非当前会话的 run 收尾会回收运行态
      activeSessionId: 's1',
      bySession: {},
      permissionQueue: [],
      questionQueue: [],
      todos: {},
    });
  });

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

  it('sets and clears todos via todo_update events', () => {
    const s = useAgentStore.getState();
    applyEvent(s, {
      type: 'todo_update',
      payload: {
        type: 'updated',
        payload: {
          session_id: 's1',
          todos: [
            { content: '任务一', status: 'completed' },
            { content: '任务二', status: 'in_progress', active_form: '正在处理任务二' },
            { content: '任务三', status: 'pending' },
          ],
        },
      },
    });
    const after = useAgentStore.getState();
    expect(after.todos['s1']).toHaveLength(3);
    expect(after.todos['s1'][0].status).toBe('completed');
    expect(after.todos['s1'][1].active_form).toBe('正在处理任务二');

    applyEvent(s, {
      type: 'todo_update',
      payload: { type: 'deleted', payload: { session_id: 's1' } },
    });
    expect(useAgentStore.getState().todos['s1']).toBeUndefined();
  });

  it('normalizes legacy "inprogress" status from old backends', () => {
    // 旧后端 serde lowercase 产出 "inprogress"(无下划线);不归一化的话
    // TodoList 按 'in_progress' 匹配失败,当前项会错位到第一条 pending。
    const s = useAgentStore.getState();
    applyEvent(s, {
      type: 'todo_update',
      payload: {
        type: 'updated',
        payload: {
          session_id: 's2',
          todos: [
            { content: '任务一', status: 'inprogress' as never },
            { content: '任务二', status: 'pending' },
          ],
        },
      },
    });
    const todos = useAgentStore.getState().todos['s2'];
    expect(todos?.[0].status).toBe('in_progress');
    expect(todos?.[1].status).toBe('pending');
  });

  it('sets and clears subagent tasks via subagent_update events', () => {
    const s = useAgentStore.getState();
    applyEvent(s, {
      type: 'subagent_update',
      payload: {
        type: 'updated',
        payload: {
          session_id: 's1',
          tasks: [
            {
              task_id: 't1',
              agent: 'researcher',
              task: '调研依赖树',
              status: 'running',
              preview: '[grep] use crate::',
              tool_calls: 3,
              turns: 5,
            },
            {
              task_id: 't2',
              agent: 'coder',
              task: '实现模块',
              status: 'done',
            },
          ],
        },
      },
    });
    const after = useAgentStore.getState();
    expect(after.subagents['s1']).toHaveLength(2);
    expect(after.subagents['s1'][0].agent).toBe('researcher');
    expect(after.subagents['s1'][0].tool_calls).toBe(3);
    expect(after.subagents['s1'][1].status).toBe('done');

    applyEvent(s, {
      type: 'subagent_update',
      payload: { type: 'deleted', payload: { session_id: 's1' } },
    });
    expect(useAgentStore.getState().subagents['s1']).toBeUndefined();
  });

  it('clears subagent tasks on run_complete', () => {
    const s = useAgentStore.getState();
    s.setSubAgents('s3', [
      { task_id: 't1', agent: 'coder', task: '做某事', status: 'running' },
    ]);
    expect(useAgentStore.getState().subagents['s3']).toHaveLength(1);
    applyEvent(s, {
      type: 'run_complete',
      payload: { type: 'updated', payload: { session_id: 's3', run_id: 'r1' } },
    });
    expect(useAgentStore.getState().subagents['s3']).toBeUndefined();
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
    // 后端回传真实用户消息(不同 id)
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
    // run_complete 应同时清除消息的 streaming 标志
    expect(useAgentStore.getState().bySession['s1'].messages[0].streaming).toBe(false);
  });

  it('ignores stale run_complete from an older run', () => {
    // 新 run 正在运行(runId r2),旧 run r1 的收尾事件迟到
    useAgentStore.getState().markRun('s1', 'r2', 'running');
    applyEvent(useAgentStore.getState(), {
      type: 'run_complete',
      payload: {
        type: 'updated',
        payload: { session_id: 's1', run_id: 'r1', message_id: 'm-old', text: '' },
      },
    });
    expect(useAgentStore.getState().bySession['s1'].run).toEqual({
      runId: 'r2',
      status: 'running',
      startedAt: expect.any(Number),
    });

    // 匹配的 run_complete 正常收尾
    applyEvent(useAgentStore.getState(), {
      type: 'run_complete',
      payload: {
        type: 'updated',
        payload: { session_id: 's1', run_id: 'r2', message_id: 'm-new', text: 'ok' },
      },
    });
    expect(useAgentStore.getState().bySession['s1'].run).toEqual({
      runId: 'r2',
      status: 'done',
      startedAt: expect.any(Number),
    });
  });

  it('usage 事件实时更新会话累计 API 调用次数(单调取大)', () => {
    const s = useAgentStore.getState();
    applyEvent(s, {
      type: 'usage',
      payload: {
        type: 'updated',
        payload: { session_id: 's1', api_calls: 46 },
      },
    });
    expect(useAgentStore.getState().apiCallsBySession['s1']).toBe(46);
    // 乱序到达的旧值(如 run 中列表 refetch 带回的旧基数)不回退
    applyEvent(s, {
      type: 'usage',
      payload: {
        type: 'updated',
        payload: { session_id: 's1', api_calls: 12 },
      },
    });
    expect(useAgentStore.getState().apiCallsBySession['s1']).toBe(46);
  });

  it('非当前会话的 run 结束会回收其运行态(内存回收)', () => {
    // 用户已切到 s2,后台 s1 的 run 收尾:消息已持久化在服务端,
    // s1 的本地运行态应整体回收而非永久驻留
    useAgentStore.setState({ activeSessionId: 's2' });
    const s = useAgentStore.getState();
    s.markRun('s1', 'r1', 'running');
    s.setTodos('s1', [{ content: '任务一', status: 'completed' }]);
    applyEvent(s, {
      type: 'run_complete',
      payload: {
        type: 'updated',
        payload: { session_id: 's1', run_id: 'r1', message_id: 'm1', text: 'ok' },
      },
    });
    expect(useAgentStore.getState().bySession['s1']).toBeUndefined();
    expect(useAgentStore.getState().todos['s1']).toBeUndefined();
  });

  it('finish part reason=cancelled 时通知携带取消原因(不再误报完成)', () => {
    useAgentStore.getState().markRun('s1', 'r1', 'running');
    applyEvent(useAgentStore.getState(), {
      type: 'message',
      payload: {
        type: 'updated',
        payload: {
          id: 'm1',
          session_id: 's1',
          role: 'assistant',
          parts: [{ type: 'finish', data: { reason: 'cancelled', time: 1 } }],
          created_at: 1,
          updated_at: 2,
        },
      },
    });
    expect(notifyRunComplete).toHaveBeenCalledTimes(1);
    expect(notifyRunComplete).toHaveBeenCalledWith('s1', undefined, '', 'cancelled');
  });

  it('finish part reason=error 时通知携带错误与原因', () => {
    useAgentStore.getState().markRun('s1', 'r1', 'running');
    applyEvent(useAgentStore.getState(), {
      type: 'message',
      payload: {
        type: 'updated',
        payload: {
          id: 'm1',
          session_id: 's1',
          role: 'assistant',
          parts: [{ type: 'finish', data: { reason: 'error', time: 1 } }],
          created_at: 1,
          updated_at: 2,
        },
      },
    });
    expect(notifyRunComplete).toHaveBeenCalledWith('s1', '任务运行出错', '', 'error');
  });

  it('run_complete 携带 reason 时透传给通知(取消场景)', () => {
    useAgentStore.getState().markRun('s1', 'r1', 'running');
    applyEvent(useAgentStore.getState(), {
      type: 'run_complete',
      payload: {
        type: 'updated',
        payload: { session_id: 's1', run_id: 'r1', message_id: 'm1', text: '', reason: 'cancelled' },
      },
    });
    expect(notifyRunComplete).toHaveBeenCalledTimes(1);
    expect(notifyRunComplete).toHaveBeenCalledWith('s1', undefined, '', 'cancelled');
  });
});
