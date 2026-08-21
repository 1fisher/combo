/**
 * 流式语音识别 WebSocket 客户端。
 *
 * 连接 `GET /v1/transcribe/stream?sample_rate=16000`(`?token=` 传远程访问令牌,
 * 浏览器 WebSocket 不能设 header),持续推送 PCM16 二进制帧,
 * 服务端经 Paraformer 流式模型回发:
 * - `{"type":"partial","text":..,"finalized":..}` 增量文本(`text` 累计文本,
 *   `finalized` 为已确认前缀,分段固化后单调增长,旧后端无此字段);
 * - `{"type":"final","text":..}` 发送 `{"type":"finish"}` 后的最终文本;
 * - `{"type":"error","code":"asr_not_ready",..}` 模型未就绪。
 */

import { ensureProxyBaseUrl } from './connection';
import { getAccessToken } from './authToken';

export type AsrStreamHandlers = {
  /** 每次增量文本更新(累计文本 + 已确认前缀,旧后端无 finalized 时为 null)。 */
  onPartial: (text: string, finalized: string | null) => void;
  /** 服务端主动报错(如模型未就绪)或连接异常断开。 */
  onError?: (message: string) => void;
};

/** 等待最终结果的超时(毫秒):收尾解码通常毫秒级,超时视为连接异常。 */
const FINISH_TIMEOUT_MS = 30_000;

export class AsrStream {
  private ws: WebSocket;
  private handlers: AsrStreamHandlers;
  private finalPromise: Promise<string> | null = null;
  private settleFinal: ((text: string) => void) | null = null;
  private failFinal: ((message: string) => void) | null = null;
  private finishTimer: number | null = null;

  private constructor(ws: WebSocket, handlers: AsrStreamHandlers) {
    this.ws = ws;
    this.handlers = handlers;
    ws.onmessage = (ev) => this.handleMessage(ev.data);
    ws.onclose = () => {
      this.handlers.onError?.('语音识别连接已断开');
      this.failFinal?.('语音识别连接已断开');
    };
  }

  /** 建立流式识别连接(模型未就绪时服务端回 error 后关闭)。 */
  static async open(sampleRate: number, handlers: AsrStreamHandlers): Promise<AsrStream> {
    const base = await ensureProxyBaseUrl();
    const wsBase = base.replace(/^http/, 'ws');
    const params = new URLSearchParams({ sample_rate: String(sampleRate) });
    // WebSocket 无法设置 Authorization header,通过 query 参数传递令牌
    const token = getAccessToken();
    if (token) params.set('token', token);

    const ws = new WebSocket(`${wsBase}/v1/transcribe/stream?${params.toString()}`);
    ws.binaryType = 'arraybuffer';
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error('无法连接语音识别服务'));
      ws.onclose = () => reject(new Error('语音识别服务连接失败'));
    });
    return new AsrStream(ws, handlers);
  }

  private handleMessage(data: unknown): void {
    if (typeof data !== 'string') return;
    let msg: { type?: string; text?: string; finalized?: string; message?: string };
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (msg.type === 'partial') {
      const finalized = typeof msg.finalized === 'string' ? msg.finalized : null;
      this.handlers.onPartial(msg.text ?? '', finalized);
    } else if (msg.type === 'final') {
      this.clearFinishTimer();
      this.settleFinal?.(msg.text ?? '');
    } else if (msg.type === 'error') {
      const message = msg.message || '语音识别失败';
      this.handlers.onError?.(message);
      this.clearFinishTimer();
      this.failFinal?.(message);
    }
  }

  private clearFinishTimer(): void {
    if (this.finishTimer != null) {
      window.clearTimeout(this.finishTimer);
      this.finishTimer = null;
    }
  }

  /** 推送一段 16kHz 单声道 PCM16 音频。 */
  sendPcm(pcm: Int16Array): void {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    // TS7 中 TypedArray.buffer.slice() 返回 ArrayBuffer | SharedArrayBuffer,
    // WebSocket.send 只接受 ArrayBuffer;PCM 缓冲由前端采集器独占,不会是
    // SharedArrayBuffer,显式收窄类型并切片到实际数据范围。
    const buffer: ArrayBuffer = pcm.buffer.slice(
      pcm.byteOffset,
      pcm.byteOffset + pcm.byteLength,
    ) as ArrayBuffer;
    this.ws.send(buffer);
  }

  /** 通知服务端音频结束,等待最终文本。 */
  finish(): Promise<string> {
    if (this.finalPromise) return this.finalPromise;
    this.finalPromise = new Promise<string>((resolve, reject) => {
      this.settleFinal = resolve;
      this.failFinal = reject;
      this.finishTimer = window.setTimeout(() => {
        reject(new Error('语音识别收尾超时'));
        this.close();
      }, FINISH_TIMEOUT_MS);
    });
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'finish' }));
    } else {
      this.failFinal?.('语音识别连接已断开');
    }
    return this.finalPromise;
  }

  /** 关闭连接(丢弃未完成的结果)。 */
  close(): void {
    this.clearFinishTimer();
    this.ws.onmessage = null;
    this.ws.onclose = null;
    this.ws.onerror = null;
    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
      this.ws.close(1000);
    }
  }
}
