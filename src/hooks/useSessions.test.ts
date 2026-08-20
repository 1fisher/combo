import { describe, expect, it, beforeEach, vi } from 'vitest';
import { pickAutoOpenSession, reconcileRunsFromSessions, markRunStarted } from './useSessions';

describe('reconcileRunsFromSessions', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  function storeWith(sessionId: string, status: 'running' | 'done') {
    return {
      bySession: {
        [sessionId]: {
          run: status === 'running' ? { runId: 'r-1', status: 'running' } : { runId: 'r-1', status: 'done' },
        },
      },
    };
  }

  it('marks stuck running sessions done when server says not busy', () => {
    const store = storeWith('s1', 'running');
    const calls: [string, string, 'done'][] = [];
    reconcileRunsFromSessions(
      store,
      (sid, runId, status) => calls.push([sid, runId, status]),
      [{ id: 's1', is_busy: false }]
    );
    expect(calls).toEqual([['s1', 'r-1', 'done']]);
  });

  it('keeps running state when server still busy', () => {
    const store = storeWith('s1', 'running');
    const calls: [string, string, 'done'][] = [];
    reconcileRunsFromSessions(store, (sid, runId, status) => calls.push([sid, runId, status]), [
      { id: 's1', is_busy: true },
    ]);
    expect(calls).toEqual([]);
  });

  it('skips sessions without local running state', () => {
    const store = { bySession: { s1: { run: null } } };
    const calls: [string, string, 'done'][] = [];
    reconcileRunsFromSessions(store, (sid, runId, status) => calls.push([sid, runId, status]), [
      { id: 's1', is_busy: false },
    ]);
    expect(calls).toEqual([]);
  });

  it('skips runs started very recently (optimistic mark still settling)', () => {
    markRunStarted('s-fresh');
    const store = storeWith('s-fresh', 'running');
    const calls: [string, string, 'done'][] = [];
    reconcileRunsFromSessions(store, (sid, runId, status) => calls.push([sid, runId, status]), [
      { id: 's-fresh', is_busy: false },
    ]);
    expect(calls).toEqual([]);
    // 超过窗口后正常对账
    vi.advanceTimersByTime(6000);
    reconcileRunsFromSessions(store, (sid, runId, status) => calls.push([sid, runId, status]), [
      { id: 's-fresh', is_busy: false },
    ]);
    expect(calls).toEqual([['s-fresh', 'r-1', 'done']]);
    vi.useRealTimers();
  });
});

describe('pickAutoOpenSession(切回项目自动打开处理中的会话)', () => {
  it('有处理中的会话 → 返回其 id(直接打开)', () => {
    expect(
      pickAutoOpenSession(
        [
          { id: 'a', is_busy: false },
          { id: 'b', is_busy: true },
        ],
        null,
      ),
    ).toBe('b');
  });

  it('没有处理中的会话 → null(不选中任何会话)', () => {
    expect(
      pickAutoOpenSession(
        [
          { id: 'a', is_busy: false },
          { id: 'b' },
        ],
        null,
      ),
    ).toBeNull();
  });

  it('已有选中的会话 → null(不打断用户当前操作)', () => {
    expect(pickAutoOpenSession([{ id: 'a', is_busy: true }], 'cur-1')).toBeNull();
  });

  it('多个处理中 → 打开最近有活动的(is_busy 优先,其次 created_at)', () => {
    expect(
      pickAutoOpenSession(
        [
          { id: 'old', is_busy: true, created_at: 100 },
          { id: 'new', is_busy: true, created_at: 200 },
        ],
        null,
      ),
    ).toBe('new');
    // 取 max(updated_at, created_at) 最大者(秒级时间戳自动归一为毫秒)
    expect(
      pickAutoOpenSession(
        [
          { id: 'x', is_busy: true, created_at: 300, updated_at: 900 },
          { id: 'y', is_busy: true, created_at: 1_000, updated_at: 400 },
        ],
        null,
      ),
    ).toBe('y');
  });

  it('空列表 → null', () => {
    expect(pickAutoOpenSession([], null)).toBeNull();
  });
});
