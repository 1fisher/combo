/**
 * 音效:Web Audio 程序化合成,不依赖任何音频资源文件。
 * - playComboHit:连击气泡音——轻量的气泡「啵」爆破音(单振荡器正弦快上滑,
 *   Minnaert 气泡共振配方的轻量版)+ 极短带通噪声的破裂瞬态;气泡随
 *   combo 数值(1→100)略变大,整体保持轻短不沉,与特效的绿→红渐变呼应;
 * - playNotifyDone:任务完成提示音(双音上行,轻快);
 * - playNotifyAttention:需要交互的提醒音(双短音,略急促)。
 *
 * AudioContext 惰性创建并在调用时 resume(浏览器自动播放策略:见下方
 * armGestureUnlock,手势监听**常驻**、任意手势内都能重新解锁);上下文
 * closed/interrupted 时自愈重建,并 close 被弃实例释放配额(WebKit 对同页
 * 打开的 AudioContext 有数量上限,泄漏耗尽后 new 直接抛错、永久无声)。
 * 播放函数只在上下文 running 时调度 —— 挂起时 currentTime 冻结,排队的
 * 声音会在解锁后迟到爆出,不如直接跳过。环境不支持(jsdom/旧内核)时
 * 静默跳过。播放与否由调用方按 uiPreferencesStore 的开关判定,本模块不读
 * store,便于测试。
 */

let ctx: AudioContext | null = null;
/** 缓存的白噪声 buffer(气泡破裂瞬态复用) */
let noiseBuf: AudioBuffer | null = null;

/**
 * 共享 AudioContext:音效、听写提示音与 TTS 语音播报/朗读复用同一个
 * (惰性创建、调用时 resume)。**全应用只保留这一个播放上下文**——
 * WebKit 对同页同时运行的 AudioContext 有数量上限,各处自建会互相挤占,
 * 超限的上下文会被静默拒绝启动(表现为「特效/提示音全部无声」)。
 * 环境不支持(jsdom/旧内核)时返回 null,调用方各自静默跳过。
 */
export function getSharedAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const AC: typeof AudioContext | undefined =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC) return null;
  try {
    // 自愈重建:close 只会来自异常路径;WebKit 在音频输出中断(切换蓝牙
    // 设备/系统睡眠唤醒/窗口隐藏到托盘)后可能把上下文永久卡在
    // interrupted —— 两者都无法再出声,丢弃重建,并 close 被弃实例释放
    // WebKit 的上下文数量配额(泄漏耗尽后 new 直接抛错,永久无声)。
    if (!ctx || ctx.state === 'closed' || (ctx.state as string) === 'interrupted') {
      const dead = ctx;
      ctx = new AC();
      if (dead && dead.state !== 'closed') void dead.close().catch(() => {});
    }
    if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
    return ctx;
  } catch {
    // 构造失败(并发上限等):丢弃缓存,下次调用再试
    ctx = null;
    return null;
  }
}

/** 手势解锁是否已挂监听(幂等守卫) */
let gestureUnlockArmed = false;

/**
 * 用户手势内解锁共享 AudioContext。WebKit(WKWebView/Safari)的自动
 * 播放策略要求 AudioContext 在用户手势内启动/恢复:combo/任务完成等音效
 * 由 SSE 事件触发(不在手势内),挂起的上下文在手势外 resume 会被无声
 * 拒绝。监听**常驻整个应用生命周期、不摘除**:上下文在运行中也可能被
 * 系统再次挂起(窗口隐藏到托盘、系统休眠唤醒、切换蓝牙音频设备),首次
 * 解锁成功就摘除监听的话,再挂起后没有任何手势能救回,表现为「用一段
 * 时间后所有音效永久无声」。运行中回调只是一次 state 读取,空转无感。
 */
function armGestureUnlock(): void {
  if (typeof window === 'undefined' || gestureUnlockArmed) return;
  gestureUnlockArmed = true;
  const events = ['pointerdown', 'keydown'] as const;
  const onGesture = () => {
    // 取用即自愈:interrupted 重建、suspended 在手势内同步发起 resume
    getSharedAudioContext();
  };
  events.forEach((ev) => window.addEventListener(ev, onGesture, true));
}

// 模块加载即挂手势监听(常驻):任意用户交互都能(重新)解锁共享上下文
armGestureUnlock();

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

/** 连击气泡音:轻量的气泡「啵」爆破音,combo 越高气泡略大(起始略低) */
export function playComboHit(combo: number): void {
  const c = getSharedAudioContext();
  if (!c || c.state !== 'running') return;
  try {
    const t = c.currentTime;
    const out = masterOut(c, t);
    const k = Math.max(0, Math.min(100, combo)) / 100;
    // 轻量小气泡:起始与终点都偏高、时长极短,听感是「啵」而不是「咚」
    const f0 = 950 - k * 260; // combo=1 → ~947Hz 小气泡;100 → 690Hz 略大
    const f1 = 1500 + k * 340; // 上滑终点 ~1503Hz → 1840Hz
    const dur = 0.055 + k * 0.03; // 55ms → 85ms,轻短

    // 主音(blub):正弦指数快上滑 —— 气泡上浮时体积胀大、共振频率升高
    const blip = c.createOscillator();
    const bg = c.createGain();
    blip.type = 'sine';
    blip.frequency.setValueAtTime(f0, t);
    blip.frequency.exponentialRampToValueAtTime(f1, t + dur * 0.6);
    bg.gain.setValueAtTime(0.0001, t);
    bg.gain.exponentialRampToValueAtTime(0.3 + 0.1 * k, t + 0.003);
    bg.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    blip.connect(bg);
    bg.connect(out);
    blip.start(t);
    blip.stop(t + dur + 0.01);

    // 破裂瞬态(pop):极短带通噪声,给「爆破」感,轻到不抢戏
    const noise = noiseSource(c);
    const bp = c.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = f1 * 1.4;
    bp.Q.value = 1.5;
    const ng = c.createGain();
    ng.gain.setValueAtTime(0.0001, t);
    ng.gain.exponentialRampToValueAtTime(0.07 + 0.05 * k, t + 0.002);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.03);
    noise.connect(bp);
    bp.connect(ng);
    ng.connect(out);
    noise.start(t);
    noise.stop(t + 0.035);
  } catch {
    /* 音频失败不影响主流程 */
  }
}

/** 任务完成:双音上行(A5 → E6,纯五度),轻快不刺耳 */
export function playNotifyDone(): void {
  const c = getSharedAudioContext();
  if (!c || c.state !== 'running') return;
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
  const c = getSharedAudioContext();
  if (!c || c.state !== 'running') return;
  try {
    const t = c.currentTime;
    const out = masterOut(c, t);
    tone(c, out, 739.99, t, 0.12, 0.35, 'triangle');
    tone(c, out, 987.77, t + 0.15, 0.16, 0.35, 'triangle');
  } catch {
    /* 音频失败不影响主流程 */
  }
}
