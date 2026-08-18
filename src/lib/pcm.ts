/**
 * PCM 音频工具:后端流式 TTS(`/v1/speech/stream`)返回 base64 编码的
 * PCM16LE 单声道字节,这里解码为可直接排期播放的 AudioBuffer —
 * 不经 decodeAudioData(无异步解码开销、时长精确),播放时浏览器对采样率
 * 与 AudioContext 不一致的情况自动重采样。
 */

/** base64 → 字节(环境无 atob 时返回空,调用方按空 chunk 跳过)。 */
export function decodeBase64(s: string): Uint8Array {
  if (typeof atob !== 'function') return new Uint8Array(0);
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** PCM16LE 单声道字节 → AudioBuffer(采样率取源采样率)。 */
export function pcm16ToAudioBuffer(
  ctx: BaseAudioContext,
  pcm: ArrayBuffer,
  sampleRate: number,
): AudioBuffer {
  const src = new Int16Array(pcm);
  const buf = ctx.createBuffer(1, src.length, sampleRate);
  const dst = buf.getChannelData(0);
  for (let i = 0; i < src.length; i++) dst[i] = src[i] / 32768;
  return buf;
}
