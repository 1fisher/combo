/**
 * 音效:Web Audio 程序化合成,不依赖任何音频资源文件。
 * - playComboHit:连击打击音(拳皇风)——低频闷响 + 白噪声脆响,
 *   音高/亮度/力度随 combo 数值(1→100)递增,与特效的绿→红渐变呼应;
 * - playNotifyDone:任务完成提示音(双音上行,轻快);
 * - playNotifyAttention:需要交互的提醒音(双短音,略急促)。
 *
 * AudioContext 惰性创建并在调用时 resume(浏览器自动播放策略:
 * 用户发送消息等手势之后 ctx 已解锁);环境不支持(jsdom/旧内核)时静默跳过。
 * 播放与否由调用方按 uiPreferencesStore 的开关判定,本模块不读 store,便于测试。
 */

let ctx: AudioContext | null = null;
/** 缓存的白噪声 buffer(打击音的脆响成分复用) */
let noiseBuf: AudioBuffer | null = null;

function audioCtx(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const AC: typeof AudioContext | undefined =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC) return null;
  try {
    if (!ctx) ctx = new AC();
    if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
    return ctx;
  } catch {
    return null;
  }
}

/** 所有音效共用的总音量,避免突兀 */
const MASTER_GAIN = 0.5;

function masterOut(c: AudioContext, t: number): GainNode {
  const g = c.createGain();
  g.gain.setValueAtTime(MASTER_GAIN, t);
  g.connect(c.destination);
  return g;
}

/** 短噪声源:0.12s 白噪声,循环取用不需要整段 */
function noiseSource(c: AudioContext): AudioBufferSourceNode {
  if (!noiseBuf) {
    noiseBuf = c.createBuffer(1, Math.floor(c.sampleRate * 0.12), c.sampleRate);
    const data = noiseBuf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  }
  const src = c.createBufferSource();
  src.buffer = noiseBuf;
  return src;
}

/** 单音:快起音 + 指数衰减,合成「叮」类提示音的基本素材 */
function tone(
  c: AudioContext,
  out: AudioNode,
  freq: number,
  at: number,
  dur: number,
  vol: number,
  type: OscillatorType = 'sine',
): void {
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, at);
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(vol, at + 0.015);
  g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  o.connect(g);
  g.connect(out);
  o.start(at);
  o.stop(at + dur + 0.02);
}

/** 连击打击音:combo 越高越响越亮(强度 1→100 映射 0→1) */
export function playComboHit(combo: number): void {
  const c = audioCtx();
  if (!c) return;
  try {
    const t = c.currentTime;
    const out = masterOut(c, t);
    const k = Math.max(0, Math.min(100, combo)) / 100;
    // 低频闷响(punch):正弦下滑,起跳频率与力度随 combo 提升
    const thump = c.createOscillator();
    const tg = c.createGain();
    thump.type = 'sine';
    thump.frequency.setValueAtTime(150 + k * 90, t);
    thump.frequency.exponentialRampToValueAtTime(60, t + 0.12);
    tg.gain.setValueAtTime(0.0001, t);
    tg.gain.exponentialRampToValueAtTime(0.7 + 0.3 * k, t + 0.008);
    tg.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
    thump.connect(tg);
    tg.connect(out);
    thump.start(t);
    thump.stop(t + 0.16);
    // 高频脆响(snap):白噪声过带通,中心频率随 combo 上移(越高越「燃」)
    const noise = noiseSource(c);
    const bp = c.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 900 + k * 1400;
    bp.Q.value = 0.8;
    const ng = c.createGain();
    ng.gain.setValueAtTime(0.0001, t);
    ng.gain.exponentialRampToValueAtTime(0.35 + 0.25 * k, t + 0.005);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
    noise.connect(bp);
    bp.connect(ng);
    ng.connect(out);
    noise.start(t);
    noise.stop(t + 0.1);
  } catch {
    /* 音频失败不影响主流程 */
  }
}

/** 任务完成:双音上行(A5 → E6,纯五度),轻快不刺耳 */
export function playNotifyDone(): void {
  const c = audioCtx();
  if (!c) return;
  try {
    const t = c.currentTime;
    const out = masterOut(c, t);
    tone(c, out, 880, t, 0.18, 0.4);
    tone(c, out, 1318.51, t + 0.12, 0.28, 0.4);
  } catch {
    /* 音频失败不影响主流程 */
  }
}

/** 需要交互(确认/提问):双短音上行(F#5 → B5),比完成音略急促 */
export function playNotifyAttention(): void {
  const c = audioCtx();
  if (!c) return;
  try {
    const t = c.currentTime;
    const out = masterOut(c, t);
    tone(c, out, 739.99, t, 0.12, 0.35, 'triangle');
    tone(c, out, 987.77, t + 0.15, 0.16, 0.35, 'triangle');
  } catch {
    /* 音频失败不影响主流程 */
  }
}
