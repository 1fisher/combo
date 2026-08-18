import { getSpeechStatus, prepareSpeech } from './api';
import type { Api } from './api/types';

/** 模型下载/加载等待超时(镜像 useDictation)。 */
export const SPEECH_PREPARE_TIMEOUT_MS = 15 * 60_000;
/** 模型就绪轮询间隔。 */
export const SPEECH_POLL_INTERVAL_MS = 1000;

/**
 * 等待语音合成模型就绪:未就绪/失败时自动触发后台下载(POST /v1/speech/prepare),
 * 轮询 /v1/speech/status 并把下载进度经 onProgress 回传(0~1,null 表示无需展示);
 * 就绪即返回,超时抛错。朗读 hook 与设置区「试听」共用;通知语音播报传更短的
 * timeoutMs,等不到就放弃当次播报而不是干等 15 分钟。
 */
export async function waitSpeechModelReady(
  onProgress?: (p: number | null) => void,
  timeoutMs: number = SPEECH_PREPARE_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let status: Api.SpeechStatus | undefined;
    try {
      status = await getSpeechStatus();
    } catch {
      /* 状态查询失败按未就绪处理,下一轮重试 */
    }
    if (status) {
      if (status.ready) {
        onProgress?.(null);
        return;
      }
      onProgress?.(
        status.phase === 'downloading' && typeof status.progress === 'number'
          ? status.progress
          : null
      );
      if (status.phase === 'not_ready' || status.phase === 'failed') {
        try {
          await prepareSpeech();
        } catch {
          /* 触发失败由下一轮 status 反映 */
        }
      }
    }
    if (Date.now() > deadline) {
      onProgress?.(null);
      throw new Error('语音模型准备超时,请检查网络后重试');
    }
    await new Promise((r) => setTimeout(r, SPEECH_POLL_INTERVAL_MS));
  }
}
