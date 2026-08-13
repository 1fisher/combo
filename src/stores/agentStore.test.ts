import { beforeEach, describe, expect, it } from 'vitest';
import { useAgentStore } from './agentStore';
import type { Api } from '../lib/api/types';

function mkMsg(id: string, role: 'user' | 'assistant', text: string, ts = 1): Api.Message {
  return {
    id,
    session_id: 's1',
    role,
    parts: [{ type: 'text', data: { text } }],
    model: '',
    provider: '',
    created_at: ts,
    updated_at: ts,
  } as never;
}

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
      modelSelections: {},
      contextOverrides: {},
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

  it('手动上下文窗口覆盖按模型 id 持久化并可清除', () => {
    useAgentStore.getState().setContextOverride('deepseek-v4', 131_072);
    useAgentStore.getState().setContextOverride('glm-5', 262_144);
    expect(useAgentStore.getState().contextOverrides).toEqual({
      'deepseek-v4': 131_072,
      'glm-5': 262_144,
    });
    // 写入 localStorage
    const saved = JSON.parse(localStorage.getItem('combo.agent')!) as {
      state: { contextOverrides: Record<string, number> };
    };
    expect(saved.state.contextOverrides['deepseek-v4']).toBe(131_072);
    // 清除单个模型
    useAgentStore.getState().clearContextOverride('deepseek-v4');
    expect(useAgentStore.getState().contextOverrides['deepseek-v4']).toBeUndefined();
    expect(useAgentStore.getState().contextOverrides['glm-5']).toBe(262_144);
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

describe('agentStore hydrateMessages 历史加载', () => {
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

  it('store 为空时灌入完整历史', () => {
    const msgs = [mkMsg('h1', 'user', 'hello'), mkMsg('h2', 'assistant', 'hi')];
    useAgentStore.getState().hydrateMessages('s1', msgs);
    const rt = useAgentStore.getState().bySession['s1'];
    expect(rt).toBeDefined();
    expect(rt.messages).toHaveLength(2);
    expect(rt.messages[0].id).toBe('h1');
    expect(rt.messages[1].id).toBe('h2');
    expect(rt.messages.every((m) => !m.streaming)).toBe(true);
  });

  it('保留 SSE 实时消息,合并完整历史', () => {
    // SSE 已灌入一条实时消息(不在历史 API 返回中)
    useAgentStore.getState().upsertMessage('s1', {
      id: 'live-1',
      session_id: 's1',
      role: 'assistant',
      parts: [{ type: 'text', data: { text: 'streaming...' } }],
      model: '',
      provider: '',
      created_at: 200,
      updated_at: 200,
    } as never);
    // 历史返回 2 条消息
    const history = [mkMsg('h1', 'user', 'hello', 100), mkMsg('h2', 'assistant', 'hi', 101)];
    useAgentStore.getState().hydrateMessages('s1', history);
    const rt = useAgentStore.getState().bySession['s1'];
    // 3 条: 2 条历史 + 1 条 SSE 实时
    expect(rt.messages).toHaveLength(3);
    expect(rt.messages.map((m) => m.id)).toEqual(['h1', 'h2', 'live-1']);
  });

  it('历史与 SSE 消息有重叠 id 时不重复', () => {
    // SSE 先灌入 h1(部分内容)
    useAgentStore.getState().upsertMessage('s1', mkMsg('h1', 'user', 'hello', 100));
    // 历史返回 h1(完整) + h2
    const history = [mkMsg('h1', 'user', 'hello', 100), mkMsg('h2', 'assistant', 'hi', 101)];
    useAgentStore.getState().hydrateMessages('s1', history);
    const rt = useAgentStore.getState().bySession['s1'];
    expect(rt.messages).toHaveLength(2);
    expect(rt.messages.map((m) => m.id)).toEqual(['h1', 'h2']);
  });

  it('消息 id 列表未变化时跳过更新', () => {
    const history = [mkMsg('h1', 'user', 'hello'), mkMsg('h2', 'assistant', 'hi')];
    useAgentStore.getState().hydrateMessages('s1', history);
    const before = useAgentStore.getState().bySession['s1'];
    // 再次 hydrate 同样的数据
    useAgentStore.getState().hydrateMessages('s1', history);
    const after = useAgentStore.getState().bySession['s1'];
    // 引用不变(没有触发 set)
    expect(after).toBe(before);
  });

  it('切换会话后重新加载历史不丢失正在流式的消息', () => {
    // 模拟 SSE 推送了一条正在流式的 assistant 消息
    useAgentStore.getState().upsertMessage('s1', {
      id: 'live-stream',
      session_id: 's1',
      role: 'assistant',
      parts: [{ type: 'text', data: { text: 'partial...' } }],
      model: '',
      provider: '',
      created_at: 300,
      updated_at: 300,
    } as never);
    // 切换到该会话,历史 API 返回之前的消息(不含 live-stream)
    const history = [mkMsg('h1', 'user', 'old question', 100)];
    useAgentStore.getState().hydrateMessages('s1', history);
    const rt = useAgentStore.getState().bySession['s1'];
    // 历史消息 + SSE 实时消息都保留
    expect(rt.messages).toHaveLength(2);
    expect(rt.messages.map((m) => m.id)).toEqual(['h1', 'live-stream']);
  });
});
