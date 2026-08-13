import { describe, expect, it } from 'vitest';
import { settleCombo } from './ComboOverlay';

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
