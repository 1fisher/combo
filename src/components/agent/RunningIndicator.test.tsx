import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { formatElapsed, RunningIndicator } from './RunningIndicator';

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
  it('渲染「正在执行」与累计耗时', () => {
    render(<RunningIndicator startedAt={Date.now() - 90_000} />);
    expect(screen.getByText('正在执行')).toBeTruthy();
    expect(screen.getByText('01:30')).toBeTruthy();
  });

  it('缺少 startedAt 时不渲染', () => {
    const { container } = render(<RunningIndicator />);
    expect(container.firstChild).toBeNull();
  });
});
