import { useEffect, useRef, useState, type CSSProperties } from 'react';

/**
 * 连击结算:本轮「发送 → 收到首个 token」耗时低于阈值(默认 2s)则 combo +1,
 * 超过阈值视为连击中断,归零(下一轮快速回复重新从 ×1 开始)。
 */
export function settleCombo(prev: number, dtMs: number, thresholdMs = 2000): number {
  return dtMs < thresholdMs ? prev + 1 : 0;
}

/**
 * combo 数值 → 色相:1 → 绿(≈120°),50 → 黄(60°),100 → 红(0°)。
 * ≥100 保持红色,负数/0 保持绿色。与 utils.usageColor 的绿→红刻度一致,
 * 这里只返回 hue 数值,供 CSS 渐变/发光使用。
 */
export function comboHue(combo: number): number {
  const clamped = Math.max(0, Math.min(100, combo));
  return Math.round(120 * (1 - clamped / 100));
}

/**
 * 会话区中央的连击浮动特效(拳皇连招风):
 * 弹出大字「COMBO × N」,放大/抖动后上飘渐隐。
 * - 颜色随 combo 数值从绿(1)渐变到红(100),100+ 保持红色;
 * - 弹出动画按 600ms 节流重播:流式期间 combo 高频更新时,数字实时刷新
 *   (key 不变不重挂子树),只有超过节流窗口才重播一次弹出动画,避免闪烁;
 *   流式结束后最后一次动画播完即渐隐。
 */
export function ComboOverlay({ combo }: { combo: number }) {
  const [display, setDisplay] = useState(combo);
  const [popKey, setPopKey] = useState(0);
  const [gone, setGone] = useState(true);
  const lastPopRef = useRef(0);

  useEffect(() => {
    if (combo <= 0) {
      setGone(true);
      return;
    }
    setDisplay(combo);
    const now = Date.now();
    if (now - lastPopRef.current >= 600) {
      lastPopRef.current = now;
      setGone(false);
      setPopKey((k) => k + 1);
    }
  }, [combo]);

  if (combo <= 0 || gone) return null;
  const hue = comboHue(combo);
  return (
    <div
      key={popKey}
      className="pointer-events-none absolute inset-0 z-40 flex items-center justify-center"
      onAnimationEnd={() => setGone(true)}
    >
      <div
        className="combo-pop select-none text-center"
        style={{ '--combo-hue': hue } as CSSProperties}
      >
        <div className="combo-title">COMBO</div>
        <div className="combo-count">× {display}</div>
      </div>
    </div>
  );
}
