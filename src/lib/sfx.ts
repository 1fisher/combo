/**
 * 音效:Web Audio 程序化合成,不依赖任何音频资源文件。
 * - playComboHit:连击打击音(柔和风)——低频圆润闷咚 + 低通白噪声气声,
 *   饱满度随 combo 数值(1→100)递增,与特效的绿→红渐变呼应;
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

/** 连击打击音(柔和):combo 越高越饱满,低频气声铺垫,不刺耳 */
export function playComboHit(combo: number): void {
  const c = audioCtx();
  if (!c) return;
  try {
    const t = c.currentTime;
    const out = masterOut(c, t);
    const k = Math.max(0, Math.min(100, combo)) / 100;
    // 低频闷咚(soft thump):正弦缓降,起音放缓、音量收敛,圆润不炸
    const thump = c.createOscillator();
    const tg = c.createGain();
    thump.type = 'sine';
    thump.frequency.setValueAtTime(110 + k * 50, t);
    thump.frequency.exponentialRampToValueAtTime(55, t + 0.2);
    tg.gain.setValueAtTime(0.0001, t);
    tg.gain.exponentialRampToValueAtTime(0.45 + 0.2 * k, t + 0.02);
    tg.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
    thump.connect(tg);
    tg.connect(out);
    thump.start(t);
    thump.stop(t + 0.3);
    // 气声垫(soft puff):白噪声过低通只留空气感,去掉了原来的高频脆响
    const noise = noiseSource(c);
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 380 + k * 320;
    lp.Q.value = 0.5;
    const ng = c.createGain();
    ng.gain.setValueAtTime(0.0001, t);
    ng.gain.exponentialRampToValueAtTime(0.16 + 0.1 * k, t + 0.015);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
    noise.connect(lp);
    lp.connect(ng);
    ng.connect(out);
    noise.start(t);
    noise.stop(t + 0.18);
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
