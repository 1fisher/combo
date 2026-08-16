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

describe('agentStore insertTodoCard 任务归档', () => {
  beforeEach(() => {
    localStorage.clear();
    useAgentStore.setState({
      activeWorkspaceId: null,
      lastWorkspacePath: null,
      activeSessionId: null,
      bySession: {},
      permissionQueue: [],
      questionQueue: [],
      todos: {},
    });
  });

  it('把完成的 todo 清单作为卡片消息插入消息流末尾', () => {
    const todos: Api.TodoItem[] = [
      { content: '任务一', status: 'completed' },
      { content: '任务二', status: 'completed' },
    ];
    useAgentStore.getState().insertTodoCard('s1', 'run-1', todos);
    const rt = useAgentStore.getState().bySession['s1'];
    expect(rt.messages).toHaveLength(1);
    expect(rt.messages[0].id).toBe('todo-run-1');
    expect(rt.messages[0].role).toBe('system');
    expect(rt.messages[0].todoItems).toEqual(todos);
    expect(rt.messages[0].streaming).toBe(false);
  });

  it('多次归档按顺序追加,且不影响已有消息', () => {
    useAgentStore.getState().upsertMessage('s1', mkMsg('m1', 'user', 'hi'));
    const t1: Api.TodoItem[] = [{ content: '第一批', status: 'completed' }];
    const t2: Api.TodoItem[] = [{ content: '第二批', status: 'completed' }];
    useAgentStore.getState().insertTodoCard('s1', 'run-1', t1);
    useAgentStore.getState().insertTodoCard('s1', 'run-2', t2);
    const rt = useAgentStore.getState().bySession['s1'];
    expect(rt.messages.map((m) => m.id)).toEqual(['m1', 'todo-run-1', 'todo-run-2']);
    expect(rt.messages[0].todoItems).toBeUndefined();
  });

  it('归档后通过 clearTodos 从活跃列表移除,输入坞上方不再显示', () => {
    const todos: Api.TodoItem[] = [{ content: '任务一', status: 'completed' }];
    useAgentStore.getState().setTodos('s1', todos);
    useAgentStore.getState().insertTodoCard('s1', 'run-1', todos);
    useAgentStore.getState().clearTodos('s1');
    expect(useAgentStore.getState().todos['s1']).toBeUndefined();
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

describe('agentStore 会话运行态回收(内存防泄漏)', () => {
  beforeEach(() => {
    localStorage.clear();
    useAgentStore.setState({
      activeWorkspaceId: 'w1',
      lastWorkspacePath: null,
      activeSessionId: 's1',
      bySession: {},
      permissionQueue: [],
      questionQueue: [],
      modelSelections: {},
      contextOverrides: {},
      todos: {},
    });
  });

  it('切走的会话若已结束则回收运行态,running/排队中的保留', () => {
    const st = useAgentStore.getState();
    st.upsertMessage('s1', mkMsg('m1', 'user', 'hi'));
    st.markRun('s1', 'r1', 'done');
    st.upsertMessage('s2', mkMsg('m2', 'user', 'running...'));
    st.markRun('s2', 'r2', 'running');
    // 切到 s2:s1 已结束 → 回收;s2 是目标会话保留
    st.setActiveSessionId('s2');
    const after = useAgentStore.getState();
    expect(after.bySession['s1']).toBeUndefined();
    expect(after.bySession['s2']).toBeDefined();
    expect(after.bySession['s2'].run?.status).toBe('running');

    // running 中的会话切走不回收(继续接收 SSE 更新)
    st.setActiveSessionId(null);
    expect(useAgentStore.getState().bySession['s2']).toBeDefined();
  });

  it('切换项目清空全部会话运行态与任务清单', () => {
    const st = useAgentStore.getState();
    st.upsertMessage('s1', mkMsg('m1', 'user', 'hi'));
    st.setTodos('s1', [{ content: '任务一', status: 'pending' }]);
    st.setActiveWorkspace('w2');
    const after = useAgentStore.getState();
    expect(after.activeWorkspaceId).toBe('w2');
    expect(after.activeSessionId).toBeNull();
    expect(after.bySession).toEqual({});
    expect(after.todos).toEqual({});
  });

  it('无本地运行态的 done 收尾不再新建条目', () => {
    useAgentStore.getState().markRun('ghost', 'r9', 'done', 'err');
    expect(useAgentStore.getState().bySession['ghost']).toBeUndefined();
    // running 收尾(busy 快照恢复)仍会建立条目
    useAgentStore.getState().markRun('s1', 'r10', 'running');
    expect(useAgentStore.getState().bySession['s1'].run?.status).toBe('running');
  });
});

describe('agentStore 最近使用模型', () => {
  beforeEach(() => {
    localStorage.clear();
    useAgentStore.setState({ recentModels: [] });
  });

  it('pushRecentModel 去重、最新置顶并限制条数', () => {
    const push = useAgentStore.getState().pushRecentModel;
    push({ model: 'a', provider: 'p1' });
    push({ model: 'b', provider: 'p1' });
    // 同 provider+model 视为同一条:置顶且不重复;不同 provider 的同名模型保留
    push({ model: 'a', provider: 'p1' });
    push({ model: 'a', provider: 'p2' });
    expect(useAgentStore.getState().recentModels).toEqual([
      { model: 'a', provider: 'p2' },
      { model: 'a', provider: 'p1' },
      { model: 'b', provider: 'p1' },
    ]);

    // 超出上限丢弃最旧的
    for (let i = 0; i < 10; i++) push({ model: `m${i}`, provider: 'p3' });
    const list = useAgentStore.getState().recentModels;
    expect(list).toHaveLength(6);
    expect(list[0]).toEqual({ model: 'm9', provider: 'p3' });
  });

  it('最近使用模型持久化到 localStorage', () => {
    useAgentStore.getState().pushRecentModel({ model: 'glm-5', provider: 'zhipu' });
    const saved = JSON.parse(localStorage.getItem('combo.agent')!) as {
      state: { recentModels: { model: string; provider: string }[] };
    };
    expect(saved.state.recentModels).toEqual([{ model: 'glm-5', provider: 'zhipu' }]);
  });

  it('removeRecentModel 只删除匹配 provider+model 的单条', () => {
    useAgentStore.setState({
      recentModels: [
        { model: 'a', provider: 'p2' },
        { model: 'a', provider: 'p1' },
        { model: 'b', provider: 'p1' },
      ],
    });
    useAgentStore.getState().removeRecentModel({ model: 'a', provider: 'p1' });
    expect(useAgentStore.getState().recentModels).toEqual([
      { model: 'a', provider: 'p2' },
      { model: 'b', provider: 'p1' },
    ]);
    // 删除不存在的条目无副作用
    useAgentStore.getState().removeRecentModel({ model: 'zzz', provider: 'p9' });
    expect(useAgentStore.getState().recentModels).toHaveLength(2);
  });
});
