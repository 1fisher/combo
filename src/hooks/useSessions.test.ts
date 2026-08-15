import { describe, expect, it, beforeEach, vi } from 'vitest';
import { reconcileRunsFromSessions, markRunStarted } from './useSessions';

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
