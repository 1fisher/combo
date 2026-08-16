import { useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';

/**
 * 首屏背景粒子层(ChatEmptyState 装饰):粒子从容器各处飘入,弹簧缓动
 * 聚合成 "Combo" 字形;品牌色流光周期性沿字的倾斜走向扫过,扫到的粒子
 * 被点亮、放大并泛起光晕,随后缓缓回落 —— 静时是低透明星尘,扫过时星河流动。
 *
 * 对齐原理:离屏 canvas 以与 .combo-hero-bg svg 完全一致的姿态
 * (原点 = 容器宽 1/2 × 高 54%、绕 (50%,60%) 即原点下方 19/190 字高处旋转 −11°、
 * 字宽锁定 400/460 容器宽,等价于 svg 的 textLength=400)绘制填充字,
 * 按网格采样非透明像素得到目标点集。粒子只做「飞向目标点 + 正弦微漂浮」
 * 的弹簧运动,不需要与 SVG 的浮动动画逐帧同步 —— 粒子自带漂浮,
 * 观感上天然跟上线框字的浮动节奏。
 *
 * 性能与可访问性:
 * - 粒子数随容器面积自适应(约 220~520),单层圆点 + globalAlpha 绘制;
 * - resize 防抖 150ms 后重建(粒子重新飞聚一次,本身就是聚合动效的彩蛋);
 * - dt 钳制 50ms,页面隐藏时 rAF 自动暂停,回来不跳变;
 * - prefers-reduced-motion:静态绘制一帧(粒子全数落在字形上,无流光无漂浮);
 * - canvas 以 mix-blend-mode: plus-lighter 叠加,流光「加」在线框字与背景上;
 *   不支持的引擎退化为普通透明合成,观感依然成立。
 */

/** 字形几何常量,与 ChatEmptyState 里的 svg(viewBox 460×190)一一对应 */
const WORD = 'Combo';
const VB_W = 460;
/** svg text y=140,viewBox 中心 y=95 → 基线相对中心偏移 45 */
const BASELINE = 45;
/** transform-origin 50% 60% → 旋转原点在中心下方 (114−95)=19 viewBox 单位 */
const ORIGIN_DY = 19;
const TILT_RAD = (-11 * Math.PI) / 180;
/** svg textLength=400:整词锁定宽度(viewBox 单位) */
const WORD_LEN = 400;

/** 一轮流光周期(s):前 62% 时间扫过,其余时间在屏外休整 */
const SWEEP_PERIOD = 4600;
const SWEEP_SPAN = 0.62;
/** 流光半峰宽(px,css 像素):粒子点亮范围的 characteristic 宽度 */
const SWEEP_BAND = 64;

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  tx: number;
  ty: number;
  /** 弹簧刚度 / 阻尼,每粒子微差 → 聚合有先有后,不齐步走 */
  spring: number;
  friction: number;
  /** 微漂浮力幅度 */
  drift: number;
  /** 呼吸闪烁相位与角速度 */
  twPhase: number;
  twSpeed: number;
  /** 基础半径与基础透明度 */
  r: number;
  baseA: number;
}

interface Scene {
  w: number;
  h: number;
  /** 旋转原点(字坐标系原点,css 像素) */
  ox: number;
  oy: number;
  scale: number;
  particles: Particle[];
}

/** 解析任意 CSS 颜色(oklch/hsl/...)为 [r,g,b]:画进 1×1 离屏画布读回像素,
 *  引擎不认识该颜色时 fillStyle 赋值被忽略,返回 null 由调用方兜底。 */
function parseColor(css: string): [number, number, number] | null {
  try {
    const c = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
    if (!c) return null;
    c.fillStyle = '#000';
    c.fillStyle = css;
    if (c.fillStyle === '#000000') return null;
    c.fillRect(0, 0, 1, 1);
    const d = c.getImageData(0, 0, 1, 1).data;
    return [d[0], d[1], d[2]];
  } catch {
    return null;
  }
}

/** 读取品牌色(--brand,oklch),失败回退到贴近 dark 主题品牌的蓝 */
function readBrandColor(): [number, number, number] {
  const css = getComputedStyle(document.documentElement).getPropertyValue('--brand').trim();
  return (css && parseColor(css)) || [104, 176, 255];
}

/** 以与 svg 线框字完全一致的姿态绘制填充字,网格采样字形内的目标点 */
function sampleTargets(w: number, h: number, dpr: number): { x: number; y: number }[] {
  const off = document.createElement('canvas');
  off.width = Math.max(1, Math.ceil(w * dpr));
  off.height = Math.max(1, Math.ceil(h * dpr));
  const c = off.getContext('2d', { willReadFrequently: true });
  if (!c) return [];
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  const s = w / VB_W;

  // 与 .combo-hero-bg svg 相同的定位与倾斜:中心 (w/2, h·54%),绕 50%/60% 旋转
  c.translate(w / 2, h * 0.54);
  c.translate(0, ORIGIN_DY * s);
  c.rotate(TILT_RAD);
  c.translate(0, -ORIGIN_DY * s);

  const fs = 112 * s;
  const font = `italic 900 ${fs}px 'Geist Variable', sans-serif`;
  c.font = font;
  c.textAlign = 'center';
  c.textBaseline = 'alphabetic';
  // textLength=400 等效:量自然宽后横向均匀缩放到 400s
  const natural = c.measureText(WORD).width || 1;
  c.scale((WORD_LEN * s) / natural, 1);
  c.fillStyle = '#fff';
  c.fillText(WORD, 0, BASELINE * s);

  const img = c.getImageData(0, 0, off.width, off.height).data;
  const step = Math.max(3, Math.round(3.5 * dpr));
  const jitter = step * 0.45;
  const pts: { x: number; y: number }[] = [];
  for (let py = 0; py < off.height; py += step) {
    for (let px = 0; px < off.width; px += step) {
      if (img[(py * off.width + px) * 4 + 3] > 128) {
        pts.push({
          x: px / dpr + (Math.random() - 0.5) * jitter,
          y: py / dpr + (Math.random() - 0.5) * jitter,
        });
      }
    }
  }
  return pts;
}

/** 目标点洗牌后抽样出粒子群;初速为 0、起始位置在目标四周一大圈,首帧即「飞聚」 */
function buildParticles(w: number, h: number, dpr: number): Scene {
  const targets = sampleTargets(w, h, dpr);
  // Fisher–Yates 洗牌,随机抽样保证字形覆盖无偏
  for (let i = targets.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [targets[i], targets[j]] = [targets[j], targets[i]];
  }
  const count = Math.min(targets.length, Math.round(Math.min(520, Math.max(220, (w * h) / 2600))));
  const s = w / VB_W;
  const particles: Particle[] = [];
  for (let i = 0; i < count; i++) {
    const t = targets[i];
    const ang = Math.random() * Math.PI * 2;
    const dist = 90 + Math.random() * 260;
    const big = Math.random() < 0.12; // 少量大颗粒,层次感
    particles.push({
      x: Math.min(w - 1, Math.max(1, t.x + Math.cos(ang) * dist)),
      y: Math.min(h - 1, Math.max(1, t.y + Math.sin(ang) * dist)),
      vx: (Math.random() - 0.5) * 0.6,
      vy: (Math.random() - 0.5) * 0.6,
      tx: t.x,
      ty: t.y,
      spring: 0.012 + Math.random() * 0.01,
      friction: 0.88 + Math.random() * 0.05,
      drift: 0.004 + Math.random() * 0.005,
      twPhase: Math.random() * Math.PI * 2,
      twSpeed: 0.0008 + Math.random() * 0.0014,
      r: big ? 1.3 + Math.random() * 0.7 : 0.6 + Math.random() * 0.6,
      baseA: big ? 0.4 + Math.random() * 0.25 : 0.18 + Math.random() * 0.3,
    });
  }
  return { w, h, ox: w / 2, oy: h * 0.54 + ORIGIN_DY * s, scale: s, particles };
}

export function HeroParticles({ className }: { className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const brand = readBrandColor();
    const [br, bg, bb] = brand;

    let raf = 0;
    let disposed = false;
    let scene: Scene | null = null;
    let last = 0;
    // 离屏 band:光带先画在这,用字形 mask 裁剪(destination-in)后再加回主画布;
    // band 与主画布同像素尺寸,叠加时 1:1 对应,文字外保持透明
    let dpr = 1;
    let band: HTMLCanvasElement | null = null;
    let bandCtx: CanvasRenderingContext2D | null = null;
    /** 字形 natural 宽度(与 sampleTargets 同字体),textLength=400 等效缩放用 */
    let wordNatural = 1;

    const drawParticles = (t: number) => {
      if (!scene) return;
      const { w, h, ox, oy, particles } = scene;
      ctx.clearRect(0, 0, w, h);

      // 流光相位:字坐标系内的光带中心 x;屏外(Number.MAX_VALUE)即不点亮
      let sweepX = Number.MAX_VALUE;
      if (!reduced) {
        const local = (t % SWEEP_PERIOD) / SWEEP_PERIOD;
        if (local < SWEEP_SPAN) {
          const p = local / SWEEP_SPAN;
          const e = p * p * (3 - 2 * p); // smoothstep:起扫/收扫柔和
          sweepX = (-0.18 + e * 1.36) * w - ox;
        }
      }

      // 逆旋转变换系数:把粒子世界坐标投到字的坐标系,算与光带的精确距离
      const cos = Math.cos(TILT_RAD);
      const sin = Math.sin(TILT_RAD);
      const bandW = Math.max(70, Math.min(150, w * 0.11));

      // 光带本体:先在离屏 band 上以字姿态画斜向渐变光带,再用字形作 mask
      // (destination-in)裁掉文字外的光,最后 lighter 加回主画布 —— 流光只沿文字显示
      if (sweepX !== Number.MAX_VALUE && band && bandCtx) {
        const b = bandCtx;
        const s = scene.scale;
        const fs = 112 * s;
        b.setTransform(dpr, 0, 0, dpr, 0, 0);
        b.clearRect(0, 0, w, h);
        b.translate(w / 2, h * 0.54);
        b.translate(0, ORIGIN_DY * s);
        b.rotate(TILT_RAD);
        b.translate(0, -ORIGIN_DY * s);
        const g = b.createLinearGradient(sweepX - bandW / 2, 0, sweepX + bandW / 2, 0);
        g.addColorStop(0, `rgba(${br},${bg},${bb},0)`);
        g.addColorStop(0.5, `rgba(${br},${bg},${bb},0.16)`);
        g.addColorStop(1, `rgba(${br},${bg},${bb},0)`);
        b.fillStyle = g;
        b.fillRect(sweepX - bandW / 2, -h, bandW, h * 2);
        // 字形 mask:与采样完全一致的姿态绘制填充字,destination-in 只保留笔画内的光
        b.globalCompositeOperation = 'destination-in';
        b.font = `italic 900 ${fs}px 'Geist Variable', sans-serif`;
        b.textAlign = 'center';
        b.textBaseline = 'alphabetic';
        b.scale((WORD_LEN * s) / wordNatural, 1);
        b.fillStyle = '#fff';
        b.fillText(WORD, 0, BASELINE * s);
        b.globalCompositeOperation = 'source-over';
        // 加法叠加回主画布:文字外区域全透明,不会产生文字外的光
        ctx.globalCompositeOperation = 'lighter';
        ctx.drawImage(band, 0, 0, w, h);
        ctx.globalCompositeOperation = 'source-over';
      }

      // 粒子:白色星尘底 + 流光处的品牌色点亮(颜色随 glow 连续插值)
      for (const p of particles) {
        const dx = p.x - ox;
        const dy = p.y - oy;
        const qx = cos * dx + sin * dy;
        const nd = (qx - sweepX) / SWEEP_BAND;
        const glow = sweepX === Number.MAX_VALUE ? 0 : Math.exp(-nd * nd);

        const tw = 0.55 + 0.45 * Math.sin(t * p.twSpeed + p.twPhase);
        const a = p.baseA * tw * (1 - glow * 0.25) + glow * 0.55;
        const r = p.r * (1 + glow * 1.1);
        // 白 → 品牌色随 glow 插值
        const cr = Math.round(255 + (br - 255) * glow);
        const cg = Math.round(255 + (bg - 255) * glow);
        const cb = Math.round(255 + (bb - 255) * glow);

        // 点亮粒子多画一圈大而淡的品牌色光晕
        if (glow > 0.08) {
          ctx.globalAlpha = a * 0.3;
          ctx.fillStyle = `rgb(${br},${bg},${bb})`;
          ctx.beginPath();
          ctx.arc(p.x, p.y, r * 3.4, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.globalAlpha = a;
        ctx.fillStyle = `rgb(${cr},${cg},${cb})`;
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    };

    const step = (now: number) => {
      if (disposed || !scene) return;
      const dt = Math.min(50, now - last); // 钳制:后台回来不跳变
      last = now;
      const f = dt / 16.67; // 归一到 60fps 步长
      for (const p of scene.particles) {
        // 弹簧飞向目标点 + 阻尼,叠加正弦微漂浮(星尘的「呼吸悬停」)
        p.vx = (p.vx + (p.tx - p.x) * p.spring * f) * Math.pow(p.friction, f);
        p.vy = (p.vy + (p.ty - p.y) * p.spring * f) * Math.pow(p.friction, f);
        p.vx += Math.sin(now * 0.0011 + p.twPhase) * p.drift * f;
        p.vy += Math.cos(now * 0.0009 + p.twPhase * 1.7) * p.drift * f;
        p.x += p.vx * f;
        p.y += p.vy * f;
      }
      drawParticles(now);
      raf = requestAnimationFrame(step);
    };

    const setup = (initial: boolean) => {
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (w < 40 || h < 40) return;
      dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.ceil(w * dpr);
      canvas.height = Math.ceil(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      scene = buildParticles(w, h, dpr);
      // 重建离屏 band(与主画布同像素尺寸)
      band = document.createElement('canvas');
      band.width = canvas.width;
      band.height = canvas.height;
      bandCtx = band.getContext('2d');
      // 预计算字形 natural 宽度(与 sampleTargets 相同字体),供 mask 的 textLength 等效缩放
      const fs = 112 * (w / VB_W);
      ctx.font = `italic 900 ${fs}px 'Geist Variable', sans-serif`;
      wordNatural = ctx.measureText(WORD).width || 1;
      if (reduced) {
        // 静态帧:粒子直接落位,只画一次呼吸相位各异的星尘
        for (const p of scene.particles) {
          p.x = p.tx;
          p.y = p.ty;
        }
        drawParticles(0);
      } else if (initial) {
        last = performance.now();
        raf = requestAnimationFrame(step);
      }
    };

    // 等品牌字体(Geist Variable 斜体 900)就绪再采样,字形才与线框字一致
    let alive = true;
    document.fonts
      .load(`italic 900 112px 'Geist Variable'`)
      .catch(() => {})
      .then(() => {
        if (alive && !disposed) setup(true);
      });

    // resize 防抖重建:粒子重新飞聚一次
    let timer = 0;
    const ro = new ResizeObserver(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        if (!disposed) setup(false);
      }, 150);
    });
    ro.observe(canvas);

    return () => {
      disposed = true;
      alive = false;
      cancelAnimationFrame(raf);
      window.clearTimeout(timer);
      ro.disconnect();
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className={cn('absolute inset-0 size-full pointer-events-none [mix-blend-mode:plus-lighter]', className)}
    />
  );
}
