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
