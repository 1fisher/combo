import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { formatElapsed, RunningIndicator, streamTailPreview } from './RunningIndicator';
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

describe('streamTailPreview', () => {
  it('无流式内容返回空串', () => {
    expect(streamTailPreview(undefined)).toBe('');
    expect(streamTailPreview({ messages: [] })).toBe('');
    expect(
      streamTailPreview({
        messages: [{ streaming: false, parts: [{ type: 'text', data: { text: '已结束' } }] }],
      })
    ).toBe('');
  });

  it('折叠换行与空白为单行,首尾空白去除', () => {
    expect(
      streamTailPreview({
        messages: [
          { streaming: true, parts: [{ type: 'text', data: { text: '第一行\n  第二行\t\t尾' } }] },
        ],
      })
    ).toBe('第一行 第二行 尾');
  });

  it('超长保留尾部并加省略号前缀(按码点,不切断 emoji)', () => {
    const text = 'a'.repeat(50) + '🎯🎯' + 'b'.repeat(10);
    const out = streamTailPreview({ messages: [{ streaming: true, parts: [{ type: 'text', data: { text } }] }] }, 12);
    expect(out.startsWith('…')).toBe(true);
    expect(out).toBe('…' + '🎯🎯' + 'b'.repeat(10));
  });

  it('未超长原样返回', () => {
    expect(
      streamTailPreview({ messages: [{ streaming: true, parts: [{ type: 'text', data: { text: '短内容' } }] }] }, 96)
    ).toBe('短内容');
  });

  it('思考(reasoning)与正文(text)按顺序拼接展示', () => {
    const parts = [
      { type: 'reasoning', data: { thinking: '思考中…' } },
      { type: 'text', data: { text: '正文回答' } },
    ];
    expect(streamTailPreview({ messages: [{ streaming: true, parts }] })).toBe('思考中… 正文回答');
    // 只有思考时同样展示
    expect(
      streamTailPreview({
        messages: [{ streaming: true, parts: [{ type: 'reasoning', data: { thinking: '纯思考' } }] }],
      })
    ).toBe('纯思考');
  });

  it('多条流式消息按顺序拼接全部内容', () => {
    expect(
      streamTailPreview({
        messages: [
          { streaming: true, parts: [{ type: 'text', data: { text: '旧消息内容' } }] },
          { streaming: true, parts: [{ type: 'text', data: { text: '最新消息内容' } }] },
        ],
      })
    ).toBe('旧消息内容 最新消息内容');
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

  it('有流式内容时在耗时后显示单行尾部预览,无内容时不显示', () => {
    vi.useFakeTimers();
    seedStreaming('正在流式输出的回答内容');
    render(<RunningIndicator startedAt={Date.now()} />);
    // 首次 tick(挂载即采样)即可见
    act(() => {
      vi.advanceTimersByTime(0);
    });
    expect(screen.getByText('正在流式输出的回答内容')).toBeTruthy();
    // 预览随内容推进:新内容出现后一个采样周期内替换
    seedStreaming('新的流式内容');
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(screen.getByText('新的流式内容')).toBeTruthy();
    // 超长内容保留尾部(截断逻辑由 streamTailPreview 单测覆盖)
    // 会话无流式消息(工具执行中)→ 预览区消失
    useAgentStore.setState({ activeSessionId: 's3', bySession: {} });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(screen.queryByText('新的流式内容')).toBeNull();
  });
});
