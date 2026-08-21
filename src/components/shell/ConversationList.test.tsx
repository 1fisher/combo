import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ConversationList } from './ConversationList';
import { useAgentStore } from '../../stores/agentStore';
import { SESSION_PAGE_SIZE } from '../../hooks/useSessions';
import { listSessionsPage } from '../../lib/api';

const sessions: { id: string; title: string; created_at: number; is_busy?: boolean }[] = [
  { id: 's1', title: '会话一', created_at: 1_700_000_000 },
  { id: 's2', title: '会话二', created_at: 1_700_000_100 },
];

vi.mock('../../lib/api', () => ({
  // 分页版列表:按 offset 切片,total 为全部会话数
  listSessionsPage: vi.fn(
    async (_w: string, limit: number, offset: number) => ({
      sessions: sessions.slice(offset, offset + limit),
      total: sessions.length,
      limit,
      offset,
    }),
  ),
  createSession: vi.fn(async (_w: string, title: string) => {
    const s = {
      id: `s${sessions.length + 1}`,
      title,
      created_at: 1_700_000_200,
    };
    sessions.push(s);
    return s;
  }),
  renameSession: vi.fn(async (_w: string, sid: string, title: string) => {
    const s = sessions.find((x) => x.id === sid);
    if (s) s.title = title;
    return { ...s, id: sid, title };
  }),
  setCurrentSession: vi.fn(async () => {}),
  getSessionHistory: vi.fn(async () => []),
  listWorkspaces: vi.fn(async () => [
    { id: 'w1', path: '/tmp/w1', name: 'w1', backend: 'combo-cli' },
  ]),
}));

/** jsdom 没有 IntersectionObserver:注入假实现,捕获回调供测试手动触发「滚动到哨兵」。 */
class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = [];
  cb: IntersectionObserverCallback;
  el: Element | null = null;
  constructor(cb: IntersectionObserverCallback) {
    this.cb = cb;
    FakeIntersectionObserver.instances.push(this);
  }
  observe(el: Element) {
    this.el = el;
  }
  disconnect() {}
  unobserve() {}
}

/** 触发哨兵进入/离开视口 */
function intersect(observer: FakeIntersectionObserver, isIntersecting: boolean) {
  act(() => {
    observer.cb(
      [{ isIntersecting } as IntersectionObserverEntry],
      observer as unknown as IntersectionObserver,
    );
  });
}

function renderList() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ConversationList />
    </QueryClientProvider>,
  );
}

describe('ConversationList', () => {
  beforeEach(() => {
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
    FakeIntersectionObserver.instances = [];
    // 清掉模块级 vi.fn 的跨测试调用计数(实现保留),避免累积导致
    // toHaveBeenCalledTimes 断言在 jsdom 30 下误报。
    vi.mocked(listSessionsPage).mockClear();
    // jsdom 30 中 getBoundingClientRect 默认全 0(视为在视口内),会触发
    // ConversationList 的「哨兵在预取区自动续拉」effect 连拉多页;真实
    // 浏览器里未滚动时哨兵在视口下方。mock 为视口外位置,让自动续拉只在
    // 测试手动 intersect 时发生,与旧 jsdom 行为一致。
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 10_000,
      top: 10_000,
      bottom: 10_020,
      left: 0,
      right: 100,
      width: 100,
      height: 20,
      toJSON: () => ({}),
    } as DOMRect);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('lists sessions', async () => {
    useAgentStore.setState({ activeWorkspaceId: 'w1', activeSessionId: null });
    renderList();
    expect(await screen.findByText('会话一')).toBeTruthy();
    expect(screen.getByText('会话二')).toBeTruthy();
  });

  it('renames a session via inline edit', async () => {
    useAgentStore.setState({ activeWorkspaceId: 'w1', activeSessionId: 's1' });
    renderList();
    await screen.findByText('会话一');
    // 找到包含「会话一」的行,再点击其中的重命名按钮(排序后顺序不确定)
    const sessionOneRow = screen.getByText('会话一').closest('div')!;
    const renameBtn = within(sessionOneRow).getByTitle('重命名会话');
    await userEvent.click(renameBtn);
    const input = screen.getByDisplayValue('会话一');
    await userEvent.clear(input);
    await userEvent.type(input, '新名称{Enter}');
    expect(sessions[0].title).toBe('新名称');
  });

  it('loads the next page when the sentinel scrolls into view', async () => {
    // 3 页数据(total > 已加载数),首页只出第一页
    const total = SESSION_PAGE_SIZE * 2 + 1;
    const many = Array.from({ length: total }, (_, i) => ({
      id: `p${i}`,
      title: `分页任务${i}`,
      created_at: 1_700_000_000 + i,
    }));
    sessions.length = 0;
    sessions.push(...many);
    useAgentStore.setState({ activeWorkspaceId: 'w1', activeSessionId: null });

    renderList();
    expect(await screen.findByText('分页任务0')).toBeTruthy();
    // 首页只加载第一页,未出现第二页首条
    expect(screen.queryByText(`分页任务${SESSION_PAGE_SIZE}`)).toBeNull();
    expect(listSessionsPage).toHaveBeenCalledTimes(1);
    expect(vi.mocked(listSessionsPage).mock.calls[0]).toEqual(
      expect.arrayContaining(['w1', SESSION_PAGE_SIZE, 0]),
    );

    // 哨兵进入视口 → 自动拉第二页(offset = 页大小)
    const observer = FakeIntersectionObserver.instances[0];
    expect(observer?.el).toBe(screen.getByTestId('session-list-sentinel'));
    intersect(observer, true);
    expect(await screen.findByText(`分页任务${SESSION_PAGE_SIZE}`)).toBeTruthy();
    expect(listSessionsPage).toHaveBeenCalledTimes(2);
    expect(vi.mocked(listSessionsPage).mock.calls[1]).toEqual(
      expect.arrayContaining(['w1', SESSION_PAGE_SIZE, SESSION_PAGE_SIZE]),
    );

    // 再滚一页 → 第三页(offset 2×页大小,含最后一条);随后 total 与已加载数相等,不再请求
    intersect(observer, true);
    expect(await screen.findByText(`分页任务${total - 1}`)).toBeTruthy();
    expect(listSessionsPage).toHaveBeenCalledTimes(3);
    intersect(observer, true);
    expect(listSessionsPage).toHaveBeenCalledTimes(3);

    sessions.length = 0;
    sessions.push(
      { id: 's1', title: '会话一', created_at: 1_700_000_000 },
      { id: 's2', title: '会话二', created_at: 1_700_000_100 },
    );
  });

  it('marks busy sessions with a running indicator (server is_busy & local run state)', async () => {
    sessions.length = 0;
    sessions.push(
      { id: 'b1', title: '服务端运行中', created_at: 1_700_000_000, is_busy: true },
      { id: 'b2', title: '本地运行中', created_at: 1_700_000_100 },
      { id: 'b3', title: '空闲会话', created_at: 1_700_000_200 },
    );
    useAgentStore.setState({
      activeWorkspaceId: 'w1',
      activeSessionId: null,
      bySession: {
        b2: { messages: [], queued: false, run: { runId: 'r1', status: 'running' } },
      },
      autoOpenDecidedKey: null,
    });
    renderList();
    await screen.findByText('空闲会话');
    // 服务端 is_busy 与本地 running 各自点亮所在行
    const busyRows = screen.getAllByTitle('任务正在处理中');
    expect(busyRows).toHaveLength(2);
    expect(busyRows.some((r) => r.textContent?.includes('服务端运行中'))).toBe(true);
    expect(busyRows.some((r) => r.textContent?.includes('本地运行中'))).toBe(true);
    // 空闲会话行不带标记
    const idleRow = screen.getByText('空闲会话').closest('div')!;
    expect(idleRow.getAttribute('title')).toBeNull();
  });

  it('未读会话带角标与高亮,点开该会话后清除', async () => {
    sessions.length = 0;
    sessions.push(
      { id: 'u1', title: '未读会话', created_at: 1_700_000_000 },
      { id: 'u2', title: '已读会话', created_at: 1_700_000_100 },
    );
    useAgentStore.setState({
      activeWorkspaceId: 'w1',
      activeSessionId: 'u2',
      bySession: {},
      unreadSessions: { u1: true },
      autoOpenDecidedKey: null,
    });
    renderList();
    await screen.findByText('已读会话');
    // 未读行:角标 + 行 title 提示;已读行没有
    expect(screen.getAllByLabelText('有未读的新结果')).toHaveLength(1);
    const unreadRow = screen.getByText('未读会话').closest('div')!;
    expect(unreadRow.getAttribute('title')).toBe('有未读的新结果');
    const readRow = screen.getByText('已读会话').closest('div')!;
    expect(readRow.getAttribute('title')).toBeNull();
    // 点击未读会话 → 选中且角标清除
    await userEvent.click(screen.getByText('未读会话'));
    const st = useAgentStore.getState();
    expect(st.activeSessionId).toBe('u1');
    expect(st.unreadSessions['u1']).toBeUndefined();
    expect(screen.queryByLabelText('有未读的新结果')).toBeNull();
  });
});
