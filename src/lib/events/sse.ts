import { getClientId } from '../clientId';
import { getAccessToken } from '../authToken';
import { ensureProxyBaseUrl } from '../connection';
import { getP2pTransport } from '../p2p/transport';
import { EventCoalescer } from './coalesce';
import type { EventEnvelope } from './payloadTypes';

export type OnPayload = (env: EventEnvelope) => void;

export interface EventSourceOpts {
  backoffMs?: number;
  maxBackoffMs?: number;
  /** workspace 不存在(404)时回调,通常用于清除过期的选中态 */
  onGone?: () => void;
}

/** 页面从后台恢复后,超过此时长(毫秒)未收到数据则判定连接已 stale */
const STALE_THRESHOLD_MS = 30_000;

export class WorkspaceEventSource {
  private controller: AbortController | null = null;
  private stopped = false;
  connected = false;
  private readonly backoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly onGone?: () => void;
  private lastDataAt = 0;
  /** 当前退避等待的 resolve 函数,外部可调用以跳过等待立即重连 */
  private resolveSleep: (() => void) | null = null;
  private cleanupFns: Array<() => void> = [];
  /** message 帧合流:同一窗口内只把最新快照写入 store,降低流式渲染压力 */
  private coalescer: EventCoalescer;

  constructor(
    private readonly workspaceId: string,
    onPayload: OnPayload,
    opts?: EventSourceOpts
  ) {
    this.backoffMs = opts?.backoffMs ?? 1000;
    this.maxBackoffMs = opts?.maxBackoffMs ?? 30_000;
    this.onGone = opts?.onGone;
    this.coalescer = new EventCoalescer(onPayload);
  }

  start(): void {
    this.stopped = false;
    this.setupLifecycleHandlers();
    void this.loop();
  }

  stop(): void {
    this.stopped = true;
    // 先冲刷合流挂起的帧,避免停止时丢最后的流式快照
    this.coalescer.flush();
    this.cleanupFns.forEach((fn) => fn());
    this.cleanupFns = [];
    this.controller?.abort();
    this.connected = false;
  }

  /**
   * 立即中断当前等待或 stale 连接,触发重连。
   * 在网络恢复(online 事件)或页面回到前台(visibilitychange)时调用。
   */
  private forceReconnect(): void {
    // 情况 1: 正处于退避等待中 → 跳过等待立即重连
    if (this.resolveSleep) {
      this.resolveSleep();
      return;
    }
    // 情况 2: 连接中但可能已 stale(长时间无数据)→ abort 强制重连
    if (this.controller && Date.now() - this.lastDataAt > STALE_THRESHOLD_MS) {
      this.controller.abort();
    }
  }

  /** 监听页面可见性变化和网络恢复事件,触发立即重连 */
  private setupLifecycleHandlers(): void {
    const onVisibility = () => {
      if (document.visibilityState === 'visible') this.forceReconnect();
    };
    const onOnline = () => this.forceReconnect();

    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('online', onOnline);

    this.cleanupFns.push(
      () => document.removeEventListener('visibilitychange', onVisibility),
      () => window.removeEventListener('online', onOnline),
    );
  }

  private async loop(): Promise<void> {
    let delay = this.backoffMs;
    while (!this.stopped) {
      let connected = false;
      try {
        connected = await this.consume();
        // 正常 EOF:短暂重连
      } catch {
        /* network error */
      }
      if (this.stopped) return;
      // 成功建立过连接则重置退避到初始值,避免重连间隔越来越长
      if (connected) delay = this.backoffMs;
      // 等待退避延迟,可被 forceReconnect 提前唤醒
      await new Promise<void>((resolve) => {
        this.resolveSleep = resolve;
        setTimeout(resolve, delay);
      });
      this.resolveSleep = null;
      delay = Math.min(delay * 2, this.maxBackoffMs);
    }
  }

  /**
   * 建立一次 SSE 连接并消费事件流,直到连接断开。
   * @returns 是否成功建立过连接(用于退避重置判断)
   */
  private async consume(): Promise<boolean> {
    const controller = new AbortController();
    this.controller = controller;
    let didConnect = false;
    try {
      // 等待代理地址就绪(未解析时异步解析),避免相对 URL 连到页面源
      const base = await ensureProxyBaseUrl();
      const url = `${base}/v1/workspaces/${this.workspaceId}/events?client_id=${encodeURIComponent(getClientId())}`;
      const headers: Record<string, string> = { Accept: 'text/event-stream' };
      const token = getAccessToken();
      if (token) headers.Authorization = `Bearer ${token}`;
      // P2P 就绪时 SSE 走 WebRTC DataChannel(流式 chunk 透传)
      const p2p = getP2pTransport();
      const res = p2p?.isReady()
        ? await p2p.fetch(url, { headers, signal: controller.signal })
        : await fetch(url, {
            headers,
            signal: controller.signal,
          });
      if (!res.ok || !res.body) {
        if (res.status === 404) {
          this.stopped = true;
          this.onGone?.();
        }
        throw new Error(`sse status ${res.status}`);
      }
      didConnect = true;
      this.connected = true;
      this.lastDataAt = Date.now();
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        this.lastDataAt = Date.now();
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
            this.coalescer.push(env);
          } catch (e) {
            console.warn('[sse] 事件解析失败', e);
          }
        }
      }
      const ts = new Date().toISOString().slice(11, 23);
      console.debug(`[${ts}][sse] 连接断开 stopped=${this.stopped} workspace="${this.workspaceId}"`);
      return true;
    } catch (e) {
      // abort 或网络错误:若此前已成功连接,则视为已连接过(用于退避重置)
      if (didConnect) return true;
      throw e;
    } finally {
      this.connected = false;
    }
  }
}
