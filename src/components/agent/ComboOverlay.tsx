import { useEffect, useState } from 'react';

/**
 * 连击结算:本轮「发送 → 收到首个 token」耗时低于阈值(默认 2s)则 combo +1,
 * 超过阈值视为连击中断,归零(下一轮快速回复重新从 ×1 开始)。
 */
export function settleCombo(prev: number, dtMs: number, thresholdMs = 2000): number {
  return dtMs < thresholdMs ? prev + 1 : 0;
}

/**
 * 会话区中央的连击浮动特效(拳皇连招风):
 * 弹出金色描边大字「COMBO × N」,放大/抖动后上飘渐隐。
 * combo 变化时(key)重建组件重播动画,动画结束后自动隐藏。
 */
export function ComboOverlay({ combo }: { combo: number }) {
  const [gone, setGone] = useState(false);
  // combo 增长时重新播放动画
  useEffect(() => setGone(false), [combo]);
  if (combo <= 0 || gone) return null;
  return (
    <div
      key={combo}
      className="pointer-events-none absolute inset-0 z-40 flex items-center justify-center"
      onAnimationEnd={() => setGone(true)}
    >
      <div className="combo-pop select-none text-center">
        <div className="combo-title">COMBO</div>
        <div className="combo-count">× {combo}</div>
      </div>
    </div>
  );
}
