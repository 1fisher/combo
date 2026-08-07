import { getClientId } from '../clientId';
import { ensureProxyBaseUrl } from '../connection';
import type { EventEnvelope } from './payloadTypes';

export type OnPayload = (env: EventEnvelope) => void;

export interface EventSourceOpts {
  backoffMs?: number;
  /** workspace 不存在(404)时回调,通常用于清除过期的选中态 */
  onGone?: () => void;
}

export class WorkspaceEventSource {
  private controller: AbortController | null = null;
  private stopped = false;
  connected = false;
  private readonly backoffMs: number;
  private readonly onGone?: () => void;

  constructor(
    private readonly workspaceId: string,
    private readonly onPayload: OnPayload,
    opts?: EventSourceOpts
  ) {
    this.backoffMs = opts?.backoffMs ?? 1000;
    this.onGone = opts?.onGone;
  }

  start(): void {
    this.stopped = false;
    void this.loop();
  }

  stop(): void {
    this.stopped = true;
    this.controller?.abort();
    this.connected = false;
  }

  private async loop(): Promise<void> {
    let delay = this.backoffMs;
    while (!this.stopped) {
      try {
        await this.consume();
        // 正常 EOF:短暂重连
      } catch {
        /* network error */
      }
      if (this.stopped) return;
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 30_000);
    }
  }

  private async consume(): Promise<void> {
    const controller = new AbortController();
    this.controller = controller;
    // 等待代理地址就绪(未解析时异步解析),避免相对 URL 连到页面源
    const base = await ensureProxyBaseUrl();
    const url = `${base}/v1/workspaces/${this.workspaceId}/events?client_id=${encodeURIComponent(getClientId())}`;
    const res = await fetch(url, {
      headers: { Accept: 'text/event-stream' },
      signal: controller.signal,
    });
    if (!res.ok || !res.body) {
      if (res.status === 404) {
        this.stopped = true;
        this.onGone?.();
      }
      throw new Error(`sse status ${res.status}`);
    }
    this.connected = true;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        // SSE 规范:同一事件可有多行 data:,需用 \n 拼接为完整负载
        const dataLines = chunk
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5));
        if (dataLines.length === 0) continue;
        const raw = dataLines.join('\n');
        try {
          const env = JSON.parse(raw.trim()) as EventEnvelope;
          const inner = env.payload as { type?: string };
          const ts = new Date().toISOString().slice(11, 23);
          // [stream-debug] 完整 SSE 事件(含原始 JSON)
          console.debug(
            `[${ts}][sse] type="${env.type}" inner="${inner?.type}" data=${raw.trim().slice(0, 500)}`
          );
          this.onPayload(env);
        } catch (e) {
          console.warn('[sse] 事件解析失败', e);
        }
      }
    }
    this.connected = false;
    const ts = new Date().toISOString().slice(11, 23);
    console.debug(`[${ts}][sse] 连接断开 stopped=${this.stopped} workspace="${this.workspaceId}"`);
  }
}
