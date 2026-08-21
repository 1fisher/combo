import { beforeEach, describe, expect, it } from 'vitest';
import { useAgentStore } from './agentStore';
import { useNavStore } from './navStore';

/**
 * 路由历史栈测试:视图/项目/会话切换入栈,后退/前进按条目恢复。
 * reset 顺序很重要:先重置 agentStore(其订阅会把变化记入 navStore),
 * 再清空 navStore 历史与视图。
 */
function reset(initial?: { workspaceId?: string | null; sessionId?: string | null }) {
  localStorage.clear();
  // 注意不能用 `??`:显式传 null(启动期场景)会被回退成默认值
  const workspaceId =
    initial && initial.workspaceId !== undefined ? initial.workspaceId : 'w1';
  const sessionId = initial && initial.sessionId !== undefined ? initial.sessionId : 's1';
  useAgentStore.setState({ activeWorkspaceId: workspaceId, activeSessionId: sessionId });
  useNavStore.setState({ view: 'agent', entries: [], index: 0 });
}

function nav() {
  return useNavStore.getState();
}

function agent() {
  return useAgentStore.getState();
}

describe('navStore 路由历史', () => {
  beforeEach(() => reset());

  it('首次切换会话先落起始状态,后退可回到上一会话', () => {
    agent().setActiveSessionId('s2');
    // 历史:[{agent,w1,s1}, {agent,w1,s2}],游标在末尾
    expect(nav().entries).toHaveLength(2);
    expect(nav().index).toBe(1);

    nav().back();
    expect(agent().activeWorkspaceId).toBe('w1');
    expect(agent().activeSessionId).toBe('s1');

    nav().forward();
    expect(agent().activeSessionId).toBe('s2');
  });

  it('切换视图记录历史,后退/前进恢复视图', () => {
    nav().setView('terminal');
    nav().setView('graph');
    expect(nav().view).toBe('graph');

    nav().back();
    expect(nav().view).toBe('terminal');
    // 视图恢复不应丢失项目/会话
    expect(agent().activeSessionId).toBe('s1');

    nav().back();
    expect(nav().view).toBe('agent');
    nav().forward();
    expect(nav().view).toBe('terminal');
  });

  it('相同视图重复 setView 不产生历史', () => {
    nav().setView('terminal');
    nav().setView('terminal');
    expect(nav().entries).toHaveLength(2); // 起始 + terminal
    expect(nav().index).toBe(1);
  });

  it('切换项目后自动选中会话合并为一步,后退直接回到原项目原会话', () => {
    agent().setActiveWorkspace('w2');
    // 切项目清空会话:历史 [{agent,w1,s1}, {agent,w2,null}]
    expect(nav().entries).toHaveLength(2);
    // 列表加载后自动选中首个会话:原位升级,不新增条目
    agent().setActiveSessionId('sx');
    expect(nav().entries).toHaveLength(2);
    expect(nav().entries[1]).toEqual({ view: 'agent', workspaceId: 'w2', sessionId: 'sx' });

    // 后退一次直接回到 w1/s1(不经过「无会话」中间态)
    nav().back();
    expect(agent().activeWorkspaceId).toBe('w1');
    expect(agent().activeSessionId).toBe('s1');
  });

  it('后退后的新导航截断前进栈(浏览器语义)', () => {
    agent().setActiveSessionId('s2'); // [s1, s2]
    nav().back(); // 回到 s1,可前进
    agent().setActiveSessionId('s3'); // 新导航 → 截断 s2
    expect(nav().entries).toHaveLength(2);
    expect(nav().index).toBe(1);
    expect(agent().activeSessionId).toBe('s3');

    // 前进已不可用(no-op)
    nav().forward();
    expect(agent().activeSessionId).toBe('s3');
    expect(nav().index).toBe(1);
  });

  it('后退/前进的恢复动作本身不再记为新历史', () => {
    agent().setActiveSessionId('s2'); // [s1, s2]
    nav().back();
    expect(nav().entries).toHaveLength(2);
    expect(nav().index).toBe(0);
    nav().forward();
    expect(nav().entries).toHaveLength(2);
    expect(nav().index).toBe(1);
  });

  it('无历史时后退/前进为 no-op', () => {
    nav().back();
    nav().forward();
    expect(nav().entries).toHaveLength(0);
    expect(nav().view).toBe('agent');
    expect(agent().activeSessionId).toBe('s1');
  });

  it('启动期(尚无项目)的首次选中不产生可后退历史', () => {
    reset({ workspaceId: null, sessionId: null });
    // 启动恢复/自动选中第一个项目与首个会话
    agent().setActiveWorkspace('w1');
    agent().setActiveSessionId('s1');
    expect(nav().entries).toHaveLength(1);
    expect(nav().index).toBe(0);
    // 后退不可用
    nav().back();
    expect(agent().activeWorkspaceId).toBe('w1');
    expect(nav().index).toBe(0);
  });

  it('跨项目前进恢复项目与会话', () => {
    agent().setActiveWorkspace('w2');
    agent().setActiveSessionId('sx');
    nav().back(); // → w1/s1
    nav().forward(); // → w2/sx
    expect(agent().activeWorkspaceId).toBe('w2');
    expect(agent().activeSessionId).toBe('sx');
  });

  it('历史超过上限时截断最旧条目', () => {
    for (let i = 0; i < 120; i++) {
      agent().setActiveSessionId(`s${i}`);
    }
    expect(nav().entries.length).toBeLessThanOrEqual(100);
    expect(nav().index).toBe(nav().entries.length - 1);
    // 最新一条仍是最后导航
    expect(nav().entries[nav().index].sessionId).toBe('s119');
  });
});
