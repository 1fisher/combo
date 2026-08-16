import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
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

  it('连击出现时播放气泡音效,连续增长被节流不重复播放', () => {
    const { rerender } = render(<ComboOverlay combo={3} />);
    expect(playComboHit).toHaveBeenCalledTimes(1);
    expect(playComboHit).toHaveBeenCalledWith(3);
    // 600ms 内的连续增长只刷新数字,音效与视觉摆动共用节流
    rerender(<ComboOverlay combo={4} />);
    rerender(<ComboOverlay combo={5} />);
    expect(playComboHit).toHaveBeenCalledTimes(1);
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
