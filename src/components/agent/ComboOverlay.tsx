import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { cn } from '../../lib/utils';
import { playComboHit } from '../../lib/sfx';
import { useUIPreferences } from '../../stores/uiPreferencesStore';

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

/** 整体摆动/数字膨胀动画的节流间隔:低于它只刷新数字,不重播,避免连续增长时抖动 */
const BUMP_THROTTLE_MS = 600;
/** 距上次 combo 更新超过该时长(与连击中断阈值一致)无更新 → 缩小渐隐 */
const IDLE_SHRINK_MS = 2000;

type Phase = 'hidden' | 'shown' | 'shrink';

/**
 * 会话区中央的连击浮动特效(拳皇连招风):
 * 弹出大字「COMBO × N」,放大后**保持放大态**上浮渐隐。
 * - 颜色随 combo 数值从绿(1)渐变到红(100),100+ 保持红色;
 * - 连续数字增长:整体停在放大态 scale(1.3) 不回缩,每次更新整体做一次
 *   倾斜摆动 + 单程放大(combo-tilt,scale 1.25→1.3、rotate −5°→0°,600ms
 *   节流,**无心跳脉冲**),同时标题与数字自身同步膨胀(combo-count-bump,
 *   ×1→×1.25→×1),避免高频刷新时「放大→缩小」来回闪烁;
 * - 气泡音效**跟随数字增长**,与视觉摆动节流解耦:每涨 1 吐一颗泡泡
 *   (1→2 一颗,2→10 八颗),连续高频更新时像鱼吐泡泡的一串;
 * - 超过阈值时间(2s)无更新(流式结束/连击中断):播放缩小动画渐隐,
 *   下轮连击重新从放大弹出开始。
 */
export function ComboOverlay({ combo }: { combo: number }) {
  const [display, setDisplay] = useState(combo);
  const [phase, setPhase] = useState<Phase>('hidden');
  const lastBumpRef = useRef(0);
  /** 上一次的 combo 值:增长量 = 本次 − 上次,决定吐几颗泡泡 */
  const prevComboRef = useRef(0);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const popRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // 气泡声跟随数字增长:每涨 1 吐一颗(1→2 一颗,2→10 八颗),像鱼吐泡泡
    // 一样连续;与视觉摆动的节流解耦,数字涨多少就响多少,不因 600ms 节流
    // 吞掉中间的增长声
    const prev = prevComboRef.current;
    prevComboRef.current = combo;
    if (combo > prev && useUIPreferences.getState().comboSoundEnabled) {
      playComboHit(combo, combo - prev);
    }
    if (combo <= 0) {
      // 连击中断:若正在展示则走缩小渐隐,否则保持隐藏
      setPhase((p) => (p === 'shown' ? 'shrink' : 'hidden'));
      return;
    }
    setDisplay(combo);
    // 出现/重新出现 → 放大弹出;已展示 → 保持放大态
    setPhase((p) => (p === 'hidden' || p === 'shrink' ? 'shown' : 'shown'));
    // 连续增长:整体倾斜摆动 + 数字自身膨胀(节流),不回缩;
    // 视觉摆动保持 600ms 节流,避免高频更新时来回抖动
    const now = Date.now();
    if (now - lastBumpRef.current >= BUMP_THROTTLE_MS) {
      lastBumpRef.current = now;
      const el = popRef.current;
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
        ref={popRef}
        className={cn('combo-pop select-none text-center', phase === 'shrink' && 'combo-pop--shrink')}
        style={{ '--combo-hue': hue } as CSSProperties}
        onAnimationEnd={(e) => {
          if (e.animationName === 'combo-shrink' && e.target === e.currentTarget) {
            setPhase('hidden');
          }
        }}
      >
        <div className="combo-title">COMBO</div>
        <div className="combo-count">× {display}</div>
      </div>
    </div>
  );
}
