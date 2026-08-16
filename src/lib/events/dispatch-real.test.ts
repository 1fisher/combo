import { describe, expect, it } from 'vitest';
import { applyEvent } from './dispatch';
import { useAgentStore } from '../../stores/agentStore';

// 真实 SSE 信封(从 e2e-debug.mjs 捕获):payload 内层是
// { type: created|updated|deleted, payload: <真实数据> }
const payloads = [
  { type: 'message', payload: { type: 'created', payload: { parts: [{ type: 'text', data: { text: '执行 pwd 并返回当前目录' } }, { type: 'finish', data: { reason: 'stop', time: 0 } }], id: 'b7bc3c68', session_id: 'cd1a775a', role: 'user', model: '', provider: '', created_at: 1785581792, updated_at: 1785581792 } } },
  { type: 'message', payload: { type: 'created', payload: { parts: [], id: 'e44dfe5f', session_id: 'cd1a775a', role: 'assistant', model: 'deepseek-v4-flash-free', provider: 'opencode-zen', created_at: 1785581792, updated_at: 1785581792 } } },
  { type: 'message', payload: { type: 'updated', payload: { parts: [{ type: 'tool_call', data: { id: 'call_00_ET', name: 'bash', input: '' } }], id: 'e44dfe5f', session_id: 'cd1a775a', role: 'assistant', model: 'deepseek-v4-flash-free', provider: 'opencode-zen', created_at: 1785581792, updated_at: 1785581792 } } },
  { type: 'message', payload: { type: 'updated', payload: { parts: [{ type: 'tool_call', data: { id: 'call_00_ET', name: 'bash', input: '{"command": "pwd", "description": "显示当前工作目录"}', finished: true } }], id: 'e44dfe5f', session_id: 'cd1a775a', role: 'assistant', model: 'deepseek-v4-flash-free', provider: 'opencode-zen', created_at: 1785581792, updated_at: 1785581792 } } },
  { type: 'message', payload: { type: 'created', payload: { parts: [{ type: 'tool_result', data: { tool_call_id: 'call_00_ET', name: 'bash', content: '/tmp/e2e-debug', metadata: '{"start_time":1,"end_time":2,"output":"/tmp/e2e-debug\\n","status":"success"}' } }], id: 'cd1a775a-x', session_id: 'cd1a775a', role: 'user', model: '', provider: '', created_at: 1785581800, updated_at: 1785581800 } } },
  { type: 'message', payload: { type: 'updated', payload: { parts: [{ type: 'text', data: { text: '当前目录：`/tmp/e2e-debug`' } }, { type: 'finish', data: { reason: 'end_turn', time: 1785581802 } }], id: '17b313cb', session_id: 'cd1a775a', role: 'assistant', model: 'deepseek-v4-flash-free', provider: 'opencode-zen', created_at: 1785581800, updated_at: 1785581802 } } },
  { type: 'run_complete', payload: { type: 'updated', payload: { session_id: 'cd1a775a', run_id: '331f183e', message_id: '17b313cb', text: '当前目录：`/tmp/e2e-debug`' } } },
];

describe('applyEvent with real payloads', () => {
  it('applies all captured events without throwing', () => {
    // 回放的是用户正在查看的会话:非当前会话的 run 收尾会回收运行态
    useAgentStore.setState({ activeSessionId: 'cd1a775a', bySession: {} });
    for (const env of payloads) {
      applyEvent(useAgentStore.getState(), env as never);
    }
    const rt = useAgentStore.getState().bySession['cd1a775a'];
    expect(rt).toBeDefined();
    expect(rt.messages.length).toBeGreaterThanOrEqual(3);
    expect(rt.run?.status).toBe('done');
  });

  it('renders the tool_call part shape used by MessageItem', () => {
    const rt = useAgentStore.getState().bySession['cd1a775a'];
    const ass = rt.messages.find((m) => m.id === 'e44dfe5f');
    const tc = ass?.parts.find((p) => p.type === 'tool_call');
    expect(tc?.type).toBe('tool_call');
  });
});
