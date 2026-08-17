import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { formatElapsed, RunningIndicator } from './RunningIndicator';
import { useAgentStore } from '../../stores/agentStore';

/** 往 store 里灌一条正在流式的 assistant 消息(激活会话 s1) */
function seedStreaming(text: string) {
  useAgentStore.setState({
    activeSessionId: 's1',
    bySession: {
      s1: {
        run: null,
        queued: false,
        messages: [
          {
            id: 'm1',
            role: 'assistant',
            parts: [{ type: 'text', data: { text } }],
            createdAt: 1,
            updatedAt: 1,
            streaming: true,
          },
        ],
      },
    },
  });
}

describe('formatElapsed', () => {
  it('不足 1 小时显示 mm:ss', () => {
    expect(formatElapsed(0)).toBe('00:00');
    expect(formatElapsed(59_000)).toBe('00:59');
    expect(formatElapsed(65_000)).toBe('01:05');
    expect(formatElapsed(600_000)).toBe('10:00');
  });

  it('超过 1 小时显示 h:mm:ss', () => {
    expect(formatElapsed(3_661_000)).toBe('1:01:01');
    expect(formatElapsed(7_322_000)).toBe('2:02:02');
  });

  it('负数按 0 处理', () => {
    expect(formatElapsed(-500)).toBe('00:00');
  });
});

describe('RunningIndicator', () => {
  afterEach(() => {
    vi.useRealTimers();
    useAgentStore.setState({ activeSessionId: null, bySession: {} });
  });

  it('渲染「正在执行」与累计耗时', () => {
    render(<RunningIndicator startedAt={Date.now() - 90_000} />);
    expect(screen.getByText('正在执行')).toBeTruthy();
    expect(screen.getByText('01:30')).toBeTruthy();
  });

  it('缺少 startedAt 时不渲染', () => {
    const { container } = render(<RunningIndicator />);
    expect(container.firstChild).toBeNull();
  });

  it('流式内容增长时显示输出速度,静止时不显示', () => {
    vi.useFakeTimers();
    seedStreaming('hello');
    render(<RunningIndicator startedAt={Date.now()} />);
    // 首个采样周期只建立基线,内容未增长 → 不显示速度
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(screen.queryByText(/字\/s/)).toBeNull();
    // 流式内容 +30 字符 → 速度 > 0,显示「N 字/s」
    seedStreaming('hello' + 'x'.repeat(30));
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(screen.getByText(/字\/s/)).toBeTruthy();
  });

  it('无流式消息时不显示速度', () => {
    vi.useFakeTimers();
    useAgentStore.setState({ activeSessionId: 's2', bySession: {} });
    render(<RunningIndicator startedAt={Date.now()} />);
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(screen.queryByText(/字\/s/)).toBeNull();
  });
});
