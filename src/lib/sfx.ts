/**
 * 音效:Web Audio 程序化合成,不依赖任何音频资源文件。
 * - playComboHit:连击气泡音——模拟水泡上浮的「啵」(正弦频率指数上滑,
 *   Minnaert 气泡共振的经典配方)+ 二次谐波的水润感 + 极短带通噪声的
 *   破裂瞬态;气泡随 combo 数值(1→100)变大变饱满,与特效的绿→红渐变呼应;
 * - playNotifyDone:任务完成提示音(双音上行,轻快);
 * - playNotifyAttention:需要交互的提醒音(双短音,略急促)。
 *
 * AudioContext 惰性创建并在调用时 resume(浏览器自动播放策略:
 * 用户发送消息等手势之后 ctx 已解锁);环境不支持(jsdom/旧内核)时静默跳过。
 * 播放与否由调用方按 uiPreferencesStore 的开关判定,本模块不读 store,便于测试。
 */

let ctx: AudioContext | null = null;
/** 缓存的白噪声 buffer(气泡破裂瞬态复用) */
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

/** 连击气泡音:combo 越高气泡越大(起始更低)、越饱满,不刺耳 */
export function playComboHit(combo: number): void {
  const c = audioCtx();
  if (!c) return;
  try {
    const t = c.currentTime;
    const out = masterOut(c, t);
    const k = Math.max(0, Math.min(100, combo)) / 100;
    // 气泡越大(combo 越高)起始频率越低、上滑终点越高、余韵略长
    const f0 = 420 - k * 180; // combo=1 → ~418Hz 小气泡;100 → 240Hz 大气泡
    const f1 = 780 + k * 260; // 上滑终点 ~783Hz → 1040Hz
    const dur = 0.16 + k * 0.08;

    // 主音(blub):正弦指数上滑——气泡上浮时体积胀大、共振频率升高,即「啵」
    const blip = c.createOscillator();
    const bg = c.createGain();
    blip.type = 'sine';
    blip.frequency.setValueAtTime(f0, t);
    blip.frequency.exponentialRampToValueAtTime(f1, t + dur * 0.55);
    bg.gain.setValueAtTime(0.0001, t);
    bg.gain.exponentialRampToValueAtTime(0.42 + 0.18 * k, t + 0.008);
    bg.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    blip.connect(bg);
    bg.connect(out);
    blip.start(t);
    blip.stop(t + dur + 0.02);

    // 二次谐波:同步上滑但衰减更快,给气泡加「水润」质感
    const harm = c.createOscillator();
    const hg = c.createGain();
    harm.type = 'sine';
    harm.frequency.setValueAtTime(f0 * 2, t);
    harm.frequency.exponentialRampToValueAtTime(f1 * 2, t + dur * 0.55);
    hg.gain.setValueAtTime(0.0001, t);
    hg.gain.exponentialRampToValueAtTime(0.14 + 0.07 * k, t + 0.006);
    hg.gain.exponentialRampToValueAtTime(0.0001, t + dur * 0.6);
    harm.connect(hg);
    hg.connect(out);
    harm.start(t);
    harm.stop(t + dur * 0.6 + 0.02);

    // 破裂瞬态(pop):极短带通噪声,模拟气泡冒出水面的一瞬
    const noise = noiseSource(c);
    const bp = c.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = f1 * 1.5;
    bp.Q.value = 2;
    const ng = c.createGain();
    ng.gain.setValueAtTime(0.0001, t);
    ng.gain.exponentialRampToValueAtTime(0.1 + 0.08 * k, t + 0.004);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
    noise.connect(bp);
    bp.connect(ng);
    ng.connect(out);
    noise.start(t);
    noise.stop(t + 0.06);
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
