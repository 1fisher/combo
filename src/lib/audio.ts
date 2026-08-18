/** 录音音频处理:Float32 采样 → 16kHz 单声道 PCM16(供本地流式 ASR 推流)。 */

/** Float32 采样 → PCM16 小端(削波 clamp 到 [-1, 1])。 */
export function float32ToPcm16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]));
    // 四舍五入而非截断,减少直流偏移
    out[i] = Math.round(s < 0 ? s * 0x8000 : s * 0x7fff);
  }
  return out;
}

/** 把转写文本追加到现有输入:中文直接拼接,末尾是英文/数字时补一个空格。 */
export function appendTranscript(current: string, text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return current;
  if (!current) return trimmed;
  const needsSpace = /[A-Za-z0-9]$/.test(current) && /^[A-Za-z0-9]/.test(trimmed);
  return current + (needsSpace ? ' ' : '') + trimmed;
}

/**
 * 流式听写文本合并:保持已确认(分段固化)文本稳定,只让当前段的推断尾巴更新。
 *
 * 后端 partial 携带累计 `text`(= 已确认 + 当前段推断)与 `finalized`(已确认前缀,
 * 单调增长)。分段收尾时后端会把推断尾巴裁剪掉(重解码去噪),若前端直接整串
 * 替换,已识别的文字会在说话中「消失」。这里在收尾回缩时保留旧尾巴里超出新
 * 确认前缀的部分作为「旧推断」,待下一段推断到达时在分歧点就地替换 —— 类似
 * 输入法组合:确认的留下,推断的边擦边改。
 *
 * @param prevTail  上次显示的尾巴(confirmed + partial)
 * @param text      后端本次累计文本
 * @param finalized 后端已确认前缀;旧后端不下发时为 null,回退为整串推断
 * @returns 新的 { confirmed, partial },显示尾巴为 confirmed + partial
 */
export function mergeDictationTail(
  prevTail: string,
  text: string,
  finalized: string | null
): { confirmed: string; partial: string } {
  if (finalized == null) {
    return { confirmed: '', partial: text };
  }
  const fresh = text.slice(finalized.length);
  if (fresh.length > 0) {
    // 有新的推断内容:确认前缀 + 最新推断(直接显示,让推断就地修正)
    return { confirmed: finalized, partial: fresh };
  }
  // 累计文本与确认前缀一致:分段收尾裁剪了推断尾巴。保留旧尾巴里超出
  // 新确认前缀的部分,等下一段推断到达时替换,避免已识别文字整段消失。
  const stale = prevTail.slice(finalized.length);
  return { confirmed: finalized, partial: stale };
}

/** 听写提示音共用的 AudioContext(懒创建,零资源文件依赖)。 */
let chimeCtx: AudioContext | null = null;

function chimeContext(): AudioContext | null {
  try {
    if (!chimeCtx) chimeCtx = new AudioContext();
    // 首次需在用户手势内 resume,否则浏览器 autoplay 策略会保持挂起
    if (chimeCtx.state === 'suspended') void chimeCtx.resume();
    return chimeCtx;
  } catch {
    return null; // 环境不支持时静默降级
  }
}

/** 合成一个短促正弦音:指数衰减包络避免爆音。 */
function playChimeTone(ctx: AudioContext, freq: number, startAt: number, duration: number) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(freq, startAt);
  gain.gain.setValueAtTime(0.15, startAt);
  gain.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(startAt);
  osc.stop(startAt + duration + 0.02);
}

/**
 * 语音输入开启/关闭提示音(Web Audio 合成,无音频资源):
 * 开启 = 440→660Hz 上扬双音,关闭 = 660→440Hz 下抑双音,
 * 方向感清晰;环境不支持时静默。
 */
export function playDictationChime(kind: 'start' | 'stop'): void {
  const ctx = chimeContext();
  if (!ctx) return;
  const t = ctx.currentTime + 0.02;
  const notes = kind === 'start' ? [440, 660] : [660, 440];
  notes.forEach((freq, i) => playChimeTone(ctx, freq, t + i * 0.09, 0.12));
}
