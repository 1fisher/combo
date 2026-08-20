import { beforeEach, describe, expect, it, vi } from 'vitest';
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

describe('agentStore 会话未读标记与 busy 观察', () => {
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
      todos: {},
      unreadSessions: {},
      busySessions: {},
      workspaceSwitchSeq: 0,
    });
  });

  it('非当前会话的 run 结束标记未读,当前会话不标', () => {
    const st = useAgentStore.getState();
    // s1 是当前会话:run 结束时用户正看着 → 已读
    st.markRun('s1', 'r1', 'running');
    st.markRun('s1', 'r1', 'done');
    expect(useAgentStore.getState().unreadSessions['s1']).toBeUndefined();
    expect(useAgentStore.getState().busySessions['s1']).toBeUndefined();

    // s2 非当前:running → done 状态变了但没读过 → 未读
    st.markRun('s2', 'r2', 'running');
    expect(useAgentStore.getState().busySessions['s2']).toBe(true);
    st.markRun('s2', 'r2', 'done');
    expect(useAgentStore.getState().unreadSessions['s2']).toBe(true);
    expect(useAgentStore.getState().busySessions['s2']).toBeUndefined();
  });

  it('打开(选中)未读会话即清除未读标记', () => {
    const st = useAgentStore.getState();
    st.markRun('s2', 'r2', 'running');
    st.markRun('s2', 'r2', 'done');
    expect(useAgentStore.getState().unreadSessions['s2']).toBe(true);
    st.setActiveSessionId('s2');
    expect(useAgentStore.getState().unreadSessions['s2']).toBeUndefined();
    // 切走再切回:已读状态保持
    st.setActiveSessionId(null);
    expect(useAgentStore.getState().unreadSessions['s2']).toBeUndefined();
  });

  it('切换项目保留未读标记,切回后经 busy 观察补记', () => {
    const st = useAgentStore.getState();
    // 在 w1/s1 发起 run 后切到 w2:运行态被回收,busy 跟踪保留
    st.markRun('s1', 'r1', 'running');
    st.setActiveWorkspace('w2');
    expect(useAgentStore.getState().bySession).toEqual({});
    expect(useAgentStore.getState().busySessions['s1']).toBe(true);
    // 模拟切回 w1 后会话列表/SSE 观察到空闲:状态变了且未被查看 → 未读
    st.observeSessionBusy('s1', false);
    expect(useAgentStore.getState().unreadSessions['s1']).toBe(true);
    expect(useAgentStore.getState().busySessions['s1']).toBeUndefined();
  });

  it('observeSessionBusy:当前会话 busy→空闲 不标未读', () => {
    const st = useAgentStore.getState();
    st.observeSessionBusy('s1', true);
    st.observeSessionBusy('s1', false);
    expect(useAgentStore.getState().unreadSessions['s1']).toBeUndefined();
    expect(useAgentStore.getState().busySessions['s1']).toBeUndefined();
  });

  it('observeSessionBusy:从未 busy 的会话空闲不标未读,undefined 忽略', () => {
    const st = useAgentStore.getState();
    st.observeSessionBusy('s9', false);
    expect(useAgentStore.getState().unreadSessions['s9']).toBeUndefined();
    st.observeSessionBusy('s9', undefined);
    st.observeSessionBusy('s9', null);
    expect(useAgentStore.getState().busySessions['s9']).toBeUndefined();
  });

  it('clearSessionRuntime(/clear、删除会话)一并清理未读与 busy 条目', () => {
    const st = useAgentStore.getState();
    st.markRun('s2', 'r2', 'running');
    st.markRun('s2', 'r2', 'done');
    st.observeSessionBusy('s3', true);
    st.clearSessionRuntime('s2');
    st.clearSessionRuntime('s3');
    const after = useAgentStore.getState();
    expect(after.unreadSessions['s2']).toBeUndefined();
    expect(after.busySessions['s3']).toBeUndefined();
    // 显式清除未读的 action 也可单独使用
    st.observeSessionBusy('s4', true);
    st.observeSessionBusy('s4', false);
    st.clearSessionUnread('s4');
    expect(useAgentStore.getState().unreadSessions['s4']).toBeUndefined();
  });

  it('workspaceSwitchSeq 随项目切换递增,同项目重复设置不变', () => {
    const st = useAgentStore.getState();
    const seq0 = st.workspaceSwitchSeq;
    st.setActiveWorkspace('w2');
    expect(useAgentStore.getState().workspaceSwitchSeq).toBe(seq0 + 1);
    st.setActiveWorkspace('w2');
    expect(useAgentStore.getState().workspaceSwitchSeq).toBe(seq0 + 1);
    st.setActiveWorkspace('w1');
    expect(useAgentStore.getState().workspaceSwitchSeq).toBe(seq0 + 2);
  });

  it('未读标记不入 localStorage(内存态)', () => {
    const st = useAgentStore.getState();
    st.markRun('s2', 'r2', 'running');
    st.markRun('s2', 'r2', 'done');
    const saved = JSON.parse(localStorage.getItem('combo.agent')!) as {
      state: Record<string, unknown>;
    };
    expect(saved.state.unreadSessions).toBeUndefined();
    expect(saved.state.busySessions).toBeUndefined();
    expect(saved.state.workspaceSwitchSeq).toBeUndefined();
  });
});

describe('agentStore run 起点记忆(一次 run 计时不重置)', () => {
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
      todos: {},
      unreadSessions: {},
      busySessions: {},
      runStarts: {},
      workspaceSwitchSeq: 0,
    });
  });

  it('同一 runId 的 running 重放(切换项目后 busy 快照恢复)复用最初起点', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const st = useAgentStore.getState();
    st.markRun('s1', 'r1', 'running');
    const t0 = useAgentStore.getState().bySession['s1'].run!.startedAt;
    expect(t0).toBe(1_000_000);
    // 模拟切换项目(bySession 被整体回收)再切回:SSE 忙碌快照重放 running
    vi.setSystemTime(1_000_000 + 90_000);
    useAgentStore.setState({ bySession: {}, activeSessionId: null });
    st.markRun('s1', 'r1', 'running');
    const restored = useAgentStore.getState().bySession['s1'].run!;
    expect(restored.status).toBe('running');
    // 计时不重置:仍从最初起点累计(90s 前),而非快照恢复时刻
    expect(restored.startedAt).toBe(t0);
    vi.useRealTimers();
  });

  it('同一 runId 在同项目内切走会话再恢复也不重置起点', () => {
    vi.useFakeTimers();
    const st = useAgentStore.getState();
    st.markRun('s1', 'r1', 'running');
    const t0 = useAgentStore.getState().bySession['s1'].run!.startedAt!;
    // 切到 s2 再切回 s1(运行态虽保留,但即便被回收重建也应续上原起点)
    vi.setSystemTime(Date.now() + 30_000);
    st.setActiveSessionId('s2');
    st.markRun('s1', 'r1', 'running');
    expect(useAgentStore.getState().bySession['s1'].run!.startedAt).toBe(t0);
    vi.useRealTimers();
  });

  it('不同 runId(新一轮 run)记录新起点,不误用旧起点', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const st = useAgentStore.getState();
    st.markRun('s1', 'r1', 'running');
    const t0 = useAgentStore.getState().runStarts['s1'].startedAt;
    // 上一轮结束、下一轮发起:新起点
    vi.setSystemTime(1_000_000 + 60_000);
    st.markRun('s1', 'r1', 'done');
    st.markRun('s1', 'r2', 'running');
    const after = useAgentStore.getState();
    expect(after.runStarts['s1']).toEqual({ runId: 'r2', startedAt: t0 + 60_000 });
    expect(after.bySession['s1'].run!.startedAt).toBe(t0 + 60_000);
    vi.useRealTimers();
  });

  it('run 结束(当前会话/非当前会话/迟到收尾)移除起点记忆', () => {
    const st = useAgentStore.getState();
    // 当前会话收尾
    st.markRun('s1', 'r1', 'running');
    expect(useAgentStore.getState().runStarts['s1']).toBeDefined();
    st.markRun('s1', 'r1', 'done');
    expect(useAgentStore.getState().runStarts['s1']).toBeUndefined();
    // 非当前会话收尾(运行态整体回收)
    st.markRun('s2', 'r2', 'running');
    st.markRun('s2', 'r2', 'done');
    expect(useAgentStore.getState().runStarts['s2']).toBeUndefined();
    // 无本地运行态的迟到收尾(切换项目后 run 在后台结束)
    st.markRun('s3', 'r3', 'running');
    useAgentStore.setState({ bySession: {} });
    st.markRun('s3', 'r3', 'done');
    expect(useAgentStore.getState().runStarts['s3']).toBeUndefined();
  });

  it('切换项目保留起点记忆(切回后续时);clearSessionRuntime 一并清理', () => {
    const st = useAgentStore.getState();
    st.markRun('s1', 'r1', 'running');
    st.setActiveWorkspace('w2');
    // bySession 已被回收,但起点记忆跨项目保留
    expect(useAgentStore.getState().bySession).toEqual({});
    expect(useAgentStore.getState().runStarts['s1']).toEqual({
      runId: 'r1',
      startedAt: expect.any(Number),
    });
    // /clear、删除会话:起点记忆随运行态一并清理
    st.clearSessionRuntime('s1');
    expect(useAgentStore.getState().runStarts['s1']).toBeUndefined();
  });

  it('起点记忆持久化到 localStorage(刷新页面后恢复计时不重置)', () => {
    const st = useAgentStore.getState();
    st.markRun('s1', 'r1', 'running');
    const saved = JSON.parse(localStorage.getItem('combo.agent')!) as {
      state: { runStarts: Record<string, { runId: string; startedAt: number }> };
    };
    expect(saved.state.runStarts['s1']).toEqual({
      runId: 'r1',
      startedAt: expect.any(Number),
    });
  });
});
