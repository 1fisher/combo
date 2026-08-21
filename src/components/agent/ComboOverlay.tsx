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

/** 距上次 combo 更新超过该时长(与连击中断阈值一致)无更新 → 缩回原大小 */
const IDLE_SHRINK_MS = 2000;

type Phase = 'hidden' | 'shown' | 'shrink';

/**
 * 会话区中央的连击浮动特效(拳皇连招风):
 * 数字增长时放大并保持,超时无更新平滑缩回原大小(不消失),combo 归零才渐隐移除。
 * - 颜色随 combo 数值从绿(1)渐变到红(100),100+ 保持红色;
 * - 数字增长:整体经 transition 平滑放大到 scale(1.3) 并**保持**——连续增长
 *   期间一直停在大尺寸,无呼吸脉冲、无来回缩放闪烁;
 * - 气泡音效跟随数字增长:每涨 1 吐一颗泡泡(1→2 一颗,2→10 八颗),
 *   连续高频更新时像鱼吐泡泡的一串;
 * - 超过阈值时间(2s)无更新(流式结束):整体平滑**缩回原大小 scale(1)**,
 *   保持展示;下次数字增长再次放大;
 * - combo 归零(连击中断/切会话):播放缩小渐隐动画后移除。
 */
export function ComboOverlay({ combo }: { combo: number }) {
  const [display, setDisplay] = useState(combo);
  const [phase, setPhase] = useState<Phase>('hidden');
  /** 放大态:数字增长置 true(放大并保持),超时无更新置 false(缩回原大小) */
  const [big, setBig] = useState(false);
  /** 首次出现播放弹出动画;结束后移除 --enter,缩放交给 transition 接管 */
  const [entering, setEntering] = useState(false);
  /** 上一次的 combo 值:增长量 = 本次 − 上次,决定吐几颗泡泡 */
  const prevComboRef = useRef(0);
  /** 当前是否可见:hidden 判定用 ref,避免把 phase/entering 加进 effect 依赖 */
  const visibleRef = useRef(false);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // 气泡声跟随数字增长:每涨 1 吐一颗(1→2 一颗,2→10 八颗),像鱼吐泡泡
    // 一样连续
    const prev = prevComboRef.current;
    prevComboRef.current = combo;
    if (combo > prev && useUIPreferences.getState().comboSoundEnabled) {
      playComboHit(combo, combo - prev);
    }
    if (combo <= 0) {
      // 连击中断:若正在展示则走缩小渐隐,否则保持隐藏
      visibleRef.current = false;
      setPhase((p) => (p === 'shown' ? 'shrink' : 'hidden'));
      return;
    }
    const fromHidden = !visibleRef.current;
    visibleRef.current = true;
    setDisplay(combo);
    setPhase('shown');
    // 数字增长 → 放大并保持;首次出现同时播放弹出动画(--enter)
    setBig(true);
    if (fromHidden) setEntering(true);
    // 超时缩回:超过阈值无更新(流式结束)平滑缩回原大小,保持展示不消失
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    idleTimerRef.current = setTimeout(() => {
      setBig(false);
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
        className={cn(
          'combo-pop select-none text-center',
          big && 'combo-pop--big',
          entering && 'combo-pop--enter',
          phase === 'shrink' && 'combo-pop--shrink'
        )}
        style={{ '--combo-hue': hue } as CSSProperties}
        onAnimationEnd={(e) => {
          if (e.target !== e.currentTarget) return;
          if (e.animationName === 'combo-pop-in') {
            // 弹出结束:移除 --enter(forwards 终态与 --big 声明值一致,无跳变)
            setEntering(false);
          } else if (e.animationName === 'combo-shrink') {
            setPhase('hidden');
            setBig(false);
            setEntering(false);
          }
        }}
      >
        <div className="combo-title">COMBO</div>
        <div className="combo-count">× {display}</div>
      </div>
    </div>
  );
}
