import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventCoalescer } from './coalesce';
import type { EventEnvelope } from './payloadTypes';

function msgEnv(id: string, text: string, inner: 'created' | 'updated' = 'updated'): EventEnvelope {
  return {
    type: 'message',
    payload: {
      type: inner,
      payload: { id, session_id: 's1', role: 'assistant', parts: [{ type: 'text', data: { text } }] },
    },
  } as unknown as EventEnvelope;
}

function otherEnv(type: string): EventEnvelope {
  return { type, payload: { type: 'created', payload: {} } } as unknown as EventEnvelope;
}

describe('EventCoalescer', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('同一消息的流式帧只应用最新快照', () => {
    const applied: EventEnvelope[] = [];
    const c = new EventCoalescer((e) => applied.push(e), 80);
    for (let i = 0; i < 100; i++) c.push(msgEnv('m1', `delta-${i}`));
    expect(applied).toHaveLength(0); // 窗口内不应用
    vi.advanceTimersByTime(80);
    expect(applied).toHaveLength(1); // 只保留最新帧
    const p = applied[0].payload.payload as { parts: Array<{ data: { text: string } }> };
    expect(p.parts[0].data.text).toBe('delta-99');
  });

  it('多条消息按首次出现顺序冲刷,各自保留最新帧', () => {
    const applied: EventEnvelope[] = [];
    const c = new EventCoalescer((e) => applied.push(e), 80);
    c.push(msgEnv('a', 'a1'));
    c.push(msgEnv('b', 'b1'));
    c.push(msgEnv('a', 'a2'));
    vi.advanceTimersByTime(80);
    expect(applied.map((e) => (e.payload.payload as { id: string }).id)).toEqual(['a', 'b']);
    const texts = applied.map(
      (e) => (e.payload.payload as { parts: Array<{ data: { text: string } }> }).parts[0].data.text
    );
    expect(texts).toEqual(['a2', 'b1']);
  });

  it('非 message 帧先冲刷挂起帧再应用,保持顺序', () => {
    const applied: EventEnvelope[] = [];
    const c = new EventCoalescer((e) => applied.push(e), 80);
    c.push(msgEnv('m1', 'streaming'));
    c.push(otherEnv('run_complete')); // 触发立即冲刷
    expect(applied.map((e) => e.type)).toEqual(['message', 'run_complete']);
    vi.advanceTimersByTime(80); // 已无挂起帧,不再重复应用
    expect(applied).toHaveLength(2);
  });

  it('finish 帧(带 finish part 的最新快照)不会被合流丢弃', () => {
    const applied: EventEnvelope[] = [];
    const c = new EventCoalescer((e) => applied.push(e), 80);
    c.push(msgEnv('m1', 'part1'));
    c.push({
      type: 'message',
      payload: {
        type: 'updated',
        payload: {
          id: 'm1',
          session_id: 's1',
          role: 'assistant',
          parts: [
            { type: 'text', data: { text: 'part1' } },
            { type: 'finish', data: { reason: 'end_turn' } },
          ],
        },
      },
    } as unknown as EventEnvelope);
    vi.advanceTimersByTime(80);
    expect(applied).toHaveLength(1);
    const parts = (applied[0].payload.payload as { parts: Array<{ type: string }> }).parts;
    expect(parts.some((p) => p.type === 'finish')).toBe(true);
  });

  it('message deleted 不合流,立即应用', () => {
    const applied: EventEnvelope[] = [];
    const c = new EventCoalescer((e) => applied.push(e), 80);
    c.push(msgEnv('m1', 'x'));
    const del = {
      type: 'message',
      payload: { type: 'deleted', payload: { id: 'm1', session_id: 's1' } },
    } as unknown as EventEnvelope;
    c.push(del);
    // deleted 到达时挂起的 updated 已先冲刷,随后立即应用 deleted
    expect(applied.map((e) => (e.payload as { type: string }).type)).toEqual(['updated', 'deleted']);
  });

  it('stop 场景:flush() 主动冲刷全部挂起帧', () => {
    const applied: EventEnvelope[] = [];
    const c = new EventCoalescer((e) => applied.push(e), 80);
    c.push(msgEnv('m1', 'last'));
    c.flush();
    expect(applied).toHaveLength(1);
    // 冲刷后定时器已清除,不会再重复应用
    vi.advanceTimersByTime(200);
    expect(applied).toHaveLength(1);
  });
});
