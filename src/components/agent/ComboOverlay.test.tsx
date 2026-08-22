import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { ComboOverlay, comboHue, nextCombo, settleCombo } from './ComboOverlay';
import { playComboHit } from '../../lib/sfx';
import { useUIPreferences } from '../../stores/uiPreferencesStore';

vi.mock('../../lib/sfx', () => ({ playComboHit: vi.fn() }));

describe('settleCombo', () => {
  it('increments when the reply arrives within 2s', () => {
    expect(settleCombo(0, 1999)).toBe(1);
    expect(settleCombo(2, 100)).toBe(3);
  });

  it('resets to 0 when the reply takes 2s or more', () => {
    expect(settleCombo(5, 2000)).toBe(0);
    expect(settleCombo(5, 3000)).toBe(0);
  });

  it('supports a custom threshold', () => {
    expect(settleCombo(3, 500, 1000)).toBe(4);
    expect(settleCombo(3, 1000, 1000)).toBe(0);
  });
});

describe('nextCombo', () => {
  it('increments on every update; first update has no gap check', () => {
    expect(nextCombo(5, null)).toBe(6);
    expect(nextCombo(5, 100)).toBe(6);
    expect(nextCombo(5, 1999)).toBe(6);
  });

  it('resets to 1 when the gap between updates is ≥2s', () => {
    expect(nextCombo(12, 2000)).toBe(1);
    expect(nextCombo(12, 5000)).toBe(1);
  });

  it('supports a custom threshold', () => {
    expect(nextCombo(3, 500, 1000)).toBe(4);
    expect(nextCombo(3, 1000, 1000)).toBe(1);
  });
});

describe('comboHue', () => {
  it('maps combo to hue: 1 → green(≈120°), 50 → yellow(60°), 100 → red(0°)', () => {
    expect(comboHue(1)).toBe(119);
    expect(comboHue(50)).toBe(60);
    expect(comboHue(100)).toBe(0);
  });

  it('clamps ≥100 to red and ≤0 to green', () => {
    expect(comboHue(200)).toBe(0);
    expect(comboHue(500)).toBe(0);
    expect(comboHue(0)).toBe(120);
    expect(comboHue(-5)).toBe(120);
  });
});

describe('ComboOverlay 音效', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useUIPreferences.setState({ comboSoundEnabled: true });
  });

  it('连击出现时播放气泡音效,数字每涨 1 吐一颗(1→2→3 共 3 颗)', () => {
    const { rerender } = render(<ComboOverlay combo={0} />); // 挂载时无连击
    expect(playComboHit).not.toHaveBeenCalled();
    rerender(<ComboOverlay combo={1} />); // 0→1 首次出现,吐 1 颗
    expect(playComboHit).toHaveBeenCalledTimes(1);
    expect(playComboHit).toHaveBeenCalledWith(1, 1);
    // 视觉摆动仍被 600ms 节流,气泡声不节流:跟随每次数字增长播放
    rerender(<ComboOverlay combo={2} />);
    rerender(<ComboOverlay combo={3} />);
    expect(playComboHit).toHaveBeenCalledTimes(3);
    expect(playComboHit).toHaveBeenCalledWith(2, 1);
    expect(playComboHit).toHaveBeenCalledWith(3, 1);
  });

  it('数字跳涨(2→10)按增量吐 8 颗,像鱼吐泡泡', () => {
    const { rerender } = render(<ComboOverlay combo={0} />);
    rerender(<ComboOverlay combo={2} />); // 0→2 吐 2 颗
    expect(playComboHit).toHaveBeenCalledTimes(1);
    expect(playComboHit).toHaveBeenCalledWith(2, 2);
    rerender(<ComboOverlay combo={10} />); // 2→10 吐 8 颗
    expect(playComboHit).toHaveBeenCalledTimes(2);
    expect(playComboHit).toHaveBeenCalledWith(10, 8);
  });

  it('关闭 Combo 特效音效后不播放', () => {
    useUIPreferences.setState({ comboSoundEnabled: false });
    render(<ComboOverlay combo={7} />);
    expect(playComboHit).not.toHaveBeenCalled();
  });

  it('combo 归零(连击中断)不播放', () => {
    const { rerender } = render(<ComboOverlay combo={2} />);
    expect(playComboHit).toHaveBeenCalledTimes(1);
    rerender(<ComboOverlay combo={0} />);
    expect(playComboHit).toHaveBeenCalledTimes(1);
  });
});

describe('ComboOverlay 超时关闭', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useUIPreferences.setState({ comboSoundEnabled: false });
  });

  it('2s 无更新播放缩小渐隐动画并关闭,下次增长重新弹出', () => {
    vi.useFakeTimers();
    try {
      const { rerender, container } = render(<ComboOverlay combo={0} />);
      rerender(<ComboOverlay combo={3} />);
      expect(container.querySelector('.combo-pop')).not.toBeNull();

      // 未超时仍展示
      act(() => {
        vi.advanceTimersByTime(1999);
      });
      expect(container.querySelector('.combo-pop--shrink')).toBeNull();

      // 超时 → 进入缩小渐隐
      act(() => {
        vi.advanceTimersByTime(1);
      });
      const shrinking = container.querySelector('.combo-pop--shrink');
      expect(shrinking).not.toBeNull();

      // 缩小动画结束(onAnimationEnd)后彻底移除
      act(() => {
        shrinking!.dispatchEvent(
          new AnimationEvent('animationend', { bubbles: true, animationName: 'combo-shrink' })
        );
      });
      expect(container.querySelector('.combo-pop')).toBeNull();

      // 下次数字增长重新从弹出动画开始
      rerender(<ComboOverlay combo={4} />);
      expect(container.querySelector('.combo-pop--enter')).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('超时前 combo 归零则不再触发超时关闭(避免对隐藏态重播动画)', () => {
    vi.useFakeTimers();
    try {
      const { rerender, container } = render(<ComboOverlay combo={2} />);
      rerender(<ComboOverlay combo={0} />);
      const shrinking = container.querySelector('.combo-pop--shrink');
      expect(shrinking).not.toBeNull();
      act(() => {
        vi.advanceTimersByTime(5000);
      });
      // 归零路径已把 visibleRef 置 false,超时回调不应改变收缩状态
      expect(container.querySelector('.combo-pop--shrink')).toBe(shrinking);
    } finally {
      vi.useRealTimers();
    }
  });
});
