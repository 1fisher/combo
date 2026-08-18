import { ApiError, synthesizeSpeechTest } from './api';
import { waitSpeechModelReady } from './speech';
import { getSharedAudioContext } from './sfx';

/**
 * 通知语音播报:任务结束 / 需要交互(确认、提问)时,除系统通知与提示音外,
 * 再用 TTS 语音模型把一句随机提示语念出来 — 离开工位也能「听见」结果。
 *
 * - 走 `POST /v1/speech/test` 合成(与设置区「试听」同路),不要求
 *   `[tts] enabled` 朗读开关打开:播报是通知的补充通道,与「朗读回复」互相独立;
 * - 播报与否由调用方按 uiPreferencesStore 的开关判定(免打扰 > 各类通知开关
 *   > 通知语音播报),本模块只负责「念」;
 * - 多条播报串行排队,避免任务完成与交互请求撞车时语音重叠;
 * - 首次使用模型未就绪(503 tts_not_ready):限时等待后台下载,超时静默放弃
 *   本次播报(通知本体不受影响),下载完成后下次播报自然生效;
 * - 全程吞错:语音只是锦上添花,任何失败都不影响通知主流程。
 */

/** 模型未就绪时的最长等待(首次使用触发下载,piper 中文模型 ~14MB)。 */
const VOICE_MODEL_WAIT_MS = 20_000;

/** 任务完成提示语(随机挑选)。 */
export const VOICE_RUN_DONE: readonly string[] = [
  '任务完成啦,快回来看看结果吧。',
  '搞定,你交代的任务已经顺利完成。',
  '报告,任务全部完成,等你检阅。',
  '这一波任务做完了,回来查看成果吧。',
  '收工,任务顺利完成,欢迎回来验收。',
];

/** 任务出错提示语(随机挑选)。 */
export const VOICE_RUN_ERROR: readonly string[] = [
  '哎呀,任务出错了,快回来看看。',
  '任务运行遇到问题,需要你看一下。',
  '不好,任务中断了,回来看看出了什么状况。',
  '任务执行出错,请回来处理。',
];

/** 工具确认提示语(随机挑选)。 */
export const VOICE_AWAIT_CONFIRM: readonly string[] = [
  '有个操作在等你确认,别让我等太久。',
  '注意,这个步骤需要你批准才能继续。',
  '停一下,有操作待你确认,快回来看看。',
  '需要你的确认,我在这里等你。',
];

/** 提问提示语(随机挑选)。 */
export const VOICE_AWAIT_ANSWER: readonly string[] = [
  '有个问题在等你回答,快来吧。',
  '提问时间到,有个问题需要你解答。',
  '我被一个问题卡住了,等你回来指点。',
  '注意,有问题等你回答,别走远哦。',
];

/** 从提示语池随机挑一句;空池返回空串(播报自动跳过)。 */
export function pickVoicePhrase(pool: readonly string[]): string {
  if (pool.length === 0) return '';
  return pool[Math.floor(Math.random() * pool.length)] ?? '';
}

/** 环境是否具备播报能力:无 AudioContext(如 jsdom/旧内核)时直接跳过,不发请求。 */
function audioCapable(): boolean {
  if (typeof window === 'undefined') return false;
  const w = window as unknown as { AudioContext?: unknown; webkitAudioContext?: unknown };
  return Boolean(w.AudioContext ?? w.webkitAudioContext);
}

/** 播报队列:串行播放,任务完成与交互请求同时到达时按序念出。 */
let voiceQueue: Promise<void> = Promise.resolve();

/**
 * 用语音模型播报一句提示(fire-and-forget):入队串行播放,失败静默跳过,
 * 绝不抛错、不影响系统通知的发送。
 */
export function speakNotifyVoice(text: string): void {
  const t = text.trim();
  if (!t || !audioCapable()) return;
  voiceQueue = voiceQueue
    .then(() => speakOnce(t))
    .catch(() => {
      /* 播报失败静默跳过:语音只是通知的补充通道 */
    });
}

/** 合成并播放一句话;未就绪时限时等待下载后重试一次。 */
async function speakOnce(text: string): Promise<void> {
  let wav: ArrayBuffer;
  try {
    wav = await synthesizeSpeechTest(text);
  } catch (e) {
    if (!(e instanceof ApiError) || e.code !== 'tts_not_ready') return;
    try {
      await waitSpeechModelReady(undefined, VOICE_MODEL_WAIT_MS);
    } catch {
      return; // 等待超时/失败:放弃本次播报,模型就绪后下次自然生效
    }
    try {
      wav = await synthesizeSpeechTest(text);
    } catch {
      return;
    }
  }
  const ctx = getSharedAudioContext();
  if (!ctx) return;
  let buffer: AudioBuffer;
  try {
    buffer = await ctx.decodeAudioData(wav);
  } catch {
    return;
  }
  await new Promise<void>((resolve) => {
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(ctx.destination);
    src.onended = () => resolve();
    src.start();
  });
}
