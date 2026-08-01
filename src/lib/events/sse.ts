import { getClientId } from '../clientId';
import { getProxyBaseUrl } from '../connection';
import type { EventEnvelope } from './payloadTypes';

export type OnPayload = (env: EventEnvelope) => void;

export class WorkspaceEventSource {
  private controller: AbortController | null = null;
  private stopped = false;
  connected = false;
  private readonly backoffMs: number;

  constructor(
    private readonly workspaceId: string,
    private readonly onPayload: OnPayload,
    opts?: { backoffMs?: number }
  ) {
    this.backoffMs = opts?.backoffMs ?? 1000;
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
    const base = getProxyBaseUrl();
    const url = `${base}/v1/workspaces/${this.workspaceId}/events?client_id=${encodeURIComponent(getClientId())}`;
    const res = await fetch(url, {
      headers: { Accept: 'text/event-stream' },
      signal: controller.signal,
    });
    if (!res.ok || !res.body) throw new Error(`sse status ${res.status}`);
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
        const dataLine = chunk.split('\n').find((l) => l.startsWith('data:'));
        if (!dataLine) continue;
        try {
          const env = JSON.parse(dataLine.slice(5).trim()) as EventEnvelope;
          this.onPayload(env);
        } catch {
          /* ignore malformed frame */
        }
      }
    }
    this.connected = false;
  }
}
