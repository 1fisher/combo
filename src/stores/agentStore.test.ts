import { beforeEach, describe, expect, it } from 'vitest';
import { useAgentStore } from './agentStore';

describe('agentStore 选中持久化', () => {
  beforeEach(() => {
    localStorage.clear();
    useAgentStore.setState({
      activeWorkspaceId: null,
      lastWorkspacePath: null,
      activeSessionId: null,
      bySession: {},
      permissionQueue: [],
      questionQueue: [],
    });
  });

  it('选中项目/会话会写入 localStorage', () => {
    useAgentStore.getState().setActiveWorkspace('w1');
    useAgentStore.getState().setActiveSessionId('s1');
    const raw = localStorage.getItem('combo.agent');
    expect(raw).toBeTruthy();
    const saved = JSON.parse(raw!) as { state: { activeWorkspaceId: string; activeSessionId: string } };
    expect(saved.state.activeWorkspaceId).toBe('w1');
    expect(saved.state.activeSessionId).toBe('s1');
  });

  it('切换项目会清空旧项目的会话', () => {
    useAgentStore.getState().setActiveWorkspace('w1');
    useAgentStore.getState().setActiveSessionId('s1');
    useAgentStore.getState().setActiveWorkspace('w2');
    expect(useAgentStore.getState().activeWorkspaceId).toBe('w2');
    expect(useAgentStore.getState().activeSessionId).toBeNull();
  });

  it('SSE 实时状态(消息/队列)不入库', () => {
    useAgentStore.getState().upsertMessage('s1', {
      id: 'm1',
      session_id: 's1',
      role: 'user',
      parts: [{ type: 'text', data: { text: 'hi' } }],
      model: '',
      provider: '',
      created_at: 1,
      updated_at: 1,
    } as never);
    useAgentStore.getState().enqueuePermission({
      id: 'p1',
      session_id: 's1',
      tool_call_id: 'tc1',
      tool_name: 'bash',
      description: 'x',
      action: '',
      params: {},
      path: '',
    });
    const raw = localStorage.getItem('combo.agent');
    const saved = JSON.parse(raw!) as { state: Record<string, unknown> };
    expect(saved.state.bySession).toBeUndefined();
    expect(saved.state.permissionQueue).toBeUndefined();
  });
});
