/**
 * 音效:Web Audio 程序化合成,不依赖任何音频资源文件。
 * - playComboHit:连击气泡音——轻量的气泡「啵」爆破音(单振荡器正弦快上滑,
 *   Minnaert 气泡共振配方的轻量版)+ 极短带通噪声的破裂瞬态;气泡随
 *   combo 数值(1→100)略变大,整体保持轻短不沉,与特效的绿→红渐变呼应;
 *   支持 count 一次连吐多颗:跟随 combo 数字增长,每涨 1 吐一颗、0.09s 错开,
 *   像鱼吐泡泡的一串;
 * - playNotifyDone:任务完成提示音(双音上行,轻快);
 * - playNotifyCancel:任务取消提示音(双音下行,与完成镜像,柔和收尾);
 * - playNotifyError:任务出错提示音(低音下行四度,更重更长,警示感);
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
/** 当前共享上下文的创建时刻:高龄兜底重建的计时起点 */
let ctxCreatedAt = 0;
/** 连续观察到 suspended 的取用次数:手势内反复 resume 也救不回 → 判定卡死换新 */
let suspendStreak = 0;
/** 最近一次排期声音的时刻(各播放路径经 markAudioScheduled 上报):
 * 宽限期内可能有 TTS 在播,不换上下文以免拦腰切断朗读 */
let lastScheduleAt = 0;
/** 待重建标记(高龄/窗口重新可见时置位):延迟到下一个用户手势内执行,
 * 因为新上下文必须靠手势内的 resume 才能出声,SSE 路径换出来也是哑的 */
let needsRebuild = false;

/**
 * 上下文高龄阈值。WebKit 有一种「假 running」状态:系统睡眠唤醒/切换音频
 * 输出设备/CoreAudio 重启后,state 仍是 running 但输出管线已死 —— 不触发
 * closed/interrupted 自愈,手势 resume 也无从谈起,表现为全部音效无声、
 * 只有重启应用才恢复。无法直接探测,按「高龄 + 静默时机」定期换新兜底:
 * 新上下文会重新绑定当前系统音频输出,等价于一次无需重启的自愈。
 */
const MAX_CTX_AGE_MS = 10 * 60_000;
/** 换新宽限:距上次排期不足该时长视为可能正在播放(TTS),推迟换新 */
const SCHEDULE_GRACE_MS = 10_000;

/**
 * 播放路径上报「本次确实排期了声音」:供换新宽限判定(近期有排期就可能
 * 正在出声,不要动上下文)。音效走 masterOut、听写提示音/TTS 朗读各自调用。
 */
export function markAudioScheduled(): void {
  lastScheduleAt = Date.now();
}

/**
 * 共享 AudioContext:音效、听写提示音与 TTS 语音播报/朗读复用同一个
 * (惰性创建、调用时 resume)。**全应用只保留这一个播放上下文**——
 * WebKit 对同页同时运行的 AudioContext 有数量上限,各处自建会互相挤占,
 * 超限的上下文会被静默拒绝启动(表现为「特效/提示音全部无声」)。
 * 环境不支持(jsdom/旧内核)时返回 null,调用方各自静默跳过。
 *
 * @param fromGesture 是否来自用户手势(armGestureUnlock 传 true)。涉及
 * 「换新上下文」的兜底(待重建标记/高龄/卡死)只在手势路径执行:新实例
 * 处于 suspended,必须靠手势内 resume 才能出声;SSE 触发的播放路径换新
 * 只会得到一个解锁不了的新哑巴,不如继续用旧实例(还能播就播)。
 */
export function getSharedAudioContext(fromGesture = false): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const AC: typeof AudioContext | undefined =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC) return null;
  try {
    const now = Date.now();
    const idle = now - lastScheduleAt > SCHEDULE_GRACE_MS;
    // 假 running 无法直接探测:非手势路径发现上下文高龄且当前静默时,
    // 只置「待重建」标记,推迟到下一个手势内真正换新(见 fromGesture 注释)
    if (!fromGesture && ctx && idle && now - ctxCreatedAt > MAX_CTX_AGE_MS) {
      needsRebuild = true;
    }
    // 自愈重建:close 只会来自异常路径;WebKit 在音频输出中断(切换蓝牙
    // 设备/系统睡眠唤醒/窗口隐藏到托盘)后可能把上下文永久卡在
    // interrupted —— 两者都无法再出声,丢弃重建,并 close 被弃实例释放
    // WebKit 的上下文数量配额(泄漏耗尽后 new 直接抛错,永久无声)。
    // 手势路径额外兜底:待重建标记(高龄/窗口重新可见)或连续多次
    // resume 仍挂起(输出管线卡死的可观测征兆)时同样换新。
    if (
      !ctx ||
      ctx.state === 'closed' ||
      (ctx.state as string) === 'interrupted' ||
      (fromGesture &&
        idle &&
        (needsRebuild || suspendStreak >= 3 || now - ctxCreatedAt > MAX_CTX_AGE_MS))
    ) {
      const dead = ctx;
      ctx = new AC();
      ctxCreatedAt = Date.now();
      suspendStreak = 0;
      needsRebuild = false;
      if (dead && dead.state !== 'closed' && typeof dead.close === 'function') {
        void dead.close().catch(() => {});
      }
    }
    if (ctx.state === 'suspended') {
      // 连续挂起计数:手势内反复 resume 无效时,下次手势换新上下文
      suspendStreak += 1;
      void ctx.resume().catch(() => {});
    } else if (ctx.state === 'running') {
      suspendStreak = 0;
    }
    return ctx;
  } catch {
    // 构造失败(并发上限等):丢弃缓存,下次调用再试
    ctx = null;
    return null;
  }
}

/** 手势解锁是否已挂监听(幂等守卫) */
let gestureUnlockArmed = false;

function handleGesture(): void {
  // 取用即自愈:interrupted 重建、suspended 在手势内同步发起 resume;
  // fromGesture=true 时额外执行「待重建/高龄/卡死」的换新兜底
  getSharedAudioContext(true);
}

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
  events.forEach((ev) => window.addEventListener(ev, handleGesture, true));
}

/** 可见性监听是否已挂(幂等守卫) */
let visibilityArmed = false;

function handleVisibilityChange(): void {
  if (document.visibilityState !== 'visible') return;
  // 刚在播放(TTS)时不动,避免拦腰切断;宽限过后再标记
  if (Date.now() - lastScheduleAt > SCHEDULE_GRACE_MS) needsRebuild = true;
}

/**
 * 窗口从隐藏恢复可见(托盘唤出/休眠唤醒)时标记待重建:WKWebView 的音频
 * 输出路由可能在隐藏期间被系统回收/切换,而 state 不发生任何变化 ——
 * 现有自愈(closed/interrupted/suspended)全都无从触发。置标记后由下一个
 * 用户手势静默换新上下文,重新绑定当前输出设备。
 */
function armVisibilityRebuild(): void {
  if (typeof document === 'undefined' || visibilityArmed) return;
  visibilityArmed = true;
  document.addEventListener('visibilitychange', handleVisibilityChange);
}

// 模块加载即挂手势监听(常驻):任意用户交互都能(重新)解锁共享上下文
armGestureUnlock();
armVisibilityRebuild();

/**
 * 音频诊断信息(挂在 window.__comboSfxDebug 供控制台直接调用):
 * 再遇「全部无声」时无需重启,先看这里 —— state 是否 running、上下文
 * 高龄、距上次排期时长、是否已标记待重建,据此判断是假 running 还是
 * 未解锁(suspended)。
 */
export function sfxDebugInfo(): {
  state: string | null;
  ageMs: number | null;
  msSinceLastSchedule: number | null;
  needsRebuild: boolean;
} {
  const now = Date.now();
  return {
    state: ctx ? String(ctx.state) : null,
    ageMs: ctxCreatedAt ? now - ctxCreatedAt : null,
    msSinceLastSchedule: lastScheduleAt ? now - lastScheduleAt : null,
    needsRebuild,
  };
}
if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).__comboSfxDebug = sfxDebugInfo;
}

/**
 * 测试专用清理:摘除常驻监听并重置模块状态。vi.resetModules 后旧模块实例
 * 的手势/可见性监听仍挂在共享的 window/document 上,会在后续用例的事件里
 * 触发旧模块创建上下文,污染计数 —— 各用例 afterEach 统一调用摘除。
 */
export function disposeAudioHooksForTests(): void {
  if (typeof window !== 'undefined') {
    window.removeEventListener('pointerdown', handleGesture, true);
    window.removeEventListener('keydown', handleGesture, true);
  }
  if (typeof document !== 'undefined') {
    document.removeEventListener('visibilitychange', handleVisibilityChange);
  }
  ctx = null;
  ctxCreatedAt = 0;
  suspendStreak = 0;
  lastScheduleAt = 0;
  needsRebuild = false;
  gestureUnlockArmed = false;
  visibilityArmed = false;
}

/** 所有音效共用的总音量,避免突兀 */
const MASTER_GAIN = 0.5;

function masterOut(c: AudioContext, t: number): GainNode {
  markAudioScheduled();
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

/**
 * 连击气泡音:轻量的气泡「啵」爆破音,combo 越高气泡略大(起始略低)。
 * `count` 支持一次连续吐多颗(跟随 combo 数字增长:1→2 吐 1 颗,2→10 吐
 * 8 颗),每颗按各自数值取音高、错开 0.09s 排期,连成「鱼吐泡泡」似的一串;
 * 单次连发上限 16 颗,极端跳涨(如 0→50)也不会一口气爆出几十颗。
 */
export function playComboHit(combo: number, count = 1): void {
  const c = getSharedAudioContext();
  if (!c || c.state !== 'running') return;
  try {
    const t = c.currentTime;
    const out = masterOut(c, t);
    const n = Math.max(1, Math.min(16, Math.floor(count)));
    for (let i = 0; i < n; i++) {
      // 第 i 颗对应最早那次增长:数值从 combo-n+1 到 combo,音高随数值渐变
      comboBubbleOne(c, out, t + i * 0.09, combo - n + 1 + i);
    }
  } catch {
    /* 音频失败不影响主流程 */
  }
}

/** 单颗连击气泡:主音「啵」快上滑 + 极短带通噪声破裂瞬态(见 playComboHit) */
function comboBubbleOne(c: AudioContext, out: AudioNode, at: number, combo: number): void {
  const k = Math.max(0, Math.min(100, combo)) / 100;
  // 轻量小气泡:起始与终点都偏高、时长极短,听感是「啵」而不是「咚」
  const f0 = 950 - k * 260; // combo=1 → ~947Hz 小气泡;100 → 690Hz 略大
  const f1 = 1500 + k * 340; // 上滑终点 ~1503Hz → 1840Hz
  const dur = 0.055 + k * 0.03; // 55ms → 85ms,轻短

  // 主音(blub):正弦指数快上滑 —— 气泡上浮时体积胀大、共振频率升高
  const blip = c.createOscillator();
  const bg = c.createGain();
  blip.type = 'sine';
  blip.frequency.setValueAtTime(f0, at);
  blip.frequency.exponentialRampToValueAtTime(f1, at + dur * 0.6);
  bg.gain.setValueAtTime(0.0001, at);
  bg.gain.exponentialRampToValueAtTime(0.3 + 0.1 * k, at + 0.003);
  bg.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  blip.connect(bg);
  bg.connect(out);
  blip.start(at);
  blip.stop(at + dur + 0.01);

  // 破裂瞬态(pop):极短带通噪声,给「爆破」感,轻到不抢戏
  const noise = noiseSource(c);
  const bp = c.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = f1 * 1.4;
  bp.Q.value = 1.5;
  const ng = c.createGain();
  ng.gain.setValueAtTime(0.0001, at);
  ng.gain.exponentialRampToValueAtTime(0.07 + 0.05 * k, at + 0.002);
  ng.gain.exponentialRampToValueAtTime(0.0001, at + 0.03);
  noise.connect(bp);
  bp.connect(ng);
  ng.connect(out);
  noise.start(at);
  noise.stop(at + 0.035);
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

/** 任务取消:双音下行(E6 → A5,与完成音互为镜像),音量略轻,一听即知「任务停了」 */
export function playNotifyCancel(): void {
  const c = getSharedAudioContext();
  if (!c || c.state !== 'running') return;
  try {
    const t = c.currentTime;
    const out = masterOut(c, t);
    tone(c, out, 1318.51, t, 0.16, 0.32);
    tone(c, out, 880, t + 0.12, 0.24, 0.32);
  } catch {
    /* 音频失败不影响主流程 */
  }
}

/** 任务出错:低音下行四度(C5 → G4),时长更长、音量更重,与完成/取消区分明显 */
export function playNotifyError(): void {
  const c = getSharedAudioContext();
  if (!c || c.state !== 'running') return;
  try {
    const t = c.currentTime;
    const out = masterOut(c, t);
    tone(c, out, 523.25, t, 0.2, 0.42);
    tone(c, out, 392, t + 0.2, 0.34, 0.42);
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
