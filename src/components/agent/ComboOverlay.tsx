import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { cn } from '../../lib/utils';

/**
 * 连击结算:本轮「发送 → 收到首个 token」耗时低于阈值(默认 2s)则 combo +1,
 * 超过阈值视为连击中断,归零(下一轮快速回复重新从 ×1 开始)。
 */
export function settleCombo(prev: number, dtMs: number, thresholdMs = 2000): number {
  return dtMs < thresholdMs ? prev + 1 : 0;
}

/**
 * 流式计数结算:每条流式内容更新 +1;与上次更新间隔 ≥ 阈值(默认 2s)
 * 视为连击中断,先归零再 +1(从 ×1 重新开始)。dtMs 为 null 表示首次更新,
 * 不做间隔判定(首 token 的快慢由 settleCombo 负责)。
 */
export function nextCombo(prev: number, dtMs: number | null, thresholdMs = 2000): number {
  return (dtMs !== null && dtMs >= thresholdMs ? 0 : prev) + 1;
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

/** 数字膨胀动画的节流间隔:低于它只刷新数字,不重播 bump,避免连续增长时抖动 */
const BUMP_THROTTLE_MS = 600;
/** 距上次 combo 更新超过该时长(与连击中断阈值一致)无更新 → 缩小渐隐 */
const IDLE_SHRINK_MS = 2000;

type Phase = 'hidden' | 'shown' | 'shrink';

/**
 * 会话区中央的连击浮动特效(拳皇连招风):
 * 弹出大字「COMBO × N」,放大后**保持放大态**上浮渐隐。
 * - 颜色随 combo 数值从绿(1)渐变到红(100),100+ 保持红色;
 * - 连续数字增长:整体停在放大态 scale(1.25) 不回缩,数字每次更新做一次
 *   膨胀脉冲(600ms 节流),避免高频刷新时「放大→缩小」来回闪烁;
 * - 超过阈值时间(2s)无更新(流式结束/连击中断):播放缩小动画渐隐,
 *   下轮连击重新从放大弹出开始。
 */
export function ComboOverlay({ combo }: { combo: number }) {
  const [display, setDisplay] = useState(combo);
  const [phase, setPhase] = useState<Phase>('hidden');
  const lastBumpRef = useRef(0);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const countRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (combo <= 0) {
      // 连击中断:若正在展示则走缩小渐隐,否则保持隐藏
      setPhase((p) => (p === 'shown' ? 'shrink' : 'hidden'));
      return;
    }
    setDisplay(combo);
    // 出现/重新出现 → 放大弹出;已展示 → 保持放大态
    setPhase((p) => (p === 'hidden' || p === 'shrink' ? 'shown' : 'shown'));
    // 连续增长:数字膨胀脉冲(节流),整体不回缩
    const now = Date.now();
    if (now - lastBumpRef.current >= BUMP_THROTTLE_MS) {
      lastBumpRef.current = now;
      const el = countRef.current;
      if (el) {
        el.classList.remove('combo-bump');
        // 强制 reflow,确保连续更新时动画可重播
        void el.offsetWidth;
        el.classList.add('combo-bump');
      }
    }
    // 超时缩小:超过阈值无更新(流式结束)先缩小再隐藏
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    idleTimerRef.current = setTimeout(() => {
      setPhase((p) => (p === 'shown' ? 'shrink' : p));
    }, IDLE_SHRINK_MS);
  }, [combo]);

  useEffect(
    () => () => {
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    },
    []
  );

  if (phase === 'hidden') return null;
  const hue = comboHue(combo);
  return (
    <div className="pointer-events-none absolute inset-0 z-40 flex items-center justify-center overflow-visible px-[12%] py-[8%] [container-type:inline-size]">
      <div
        className={cn('combo-pop select-none text-center', phase === 'shrink' && 'combo-pop--shrink')}
        style={{ '--combo-hue': hue } as CSSProperties}
        onAnimationEnd={(e) => {
          if (e.animationName === 'combo-shrink' && e.target === e.currentTarget) {
            setPhase('hidden');
          }
        }}
      >
        <div className="combo-title">COMBO</div>
        <div ref={countRef} className="combo-count">
          × {display}
        </div>
      </div>
    </div>
  );
}
