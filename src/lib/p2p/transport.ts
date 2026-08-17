/**
 * WebRTC P2P 传输层(移动端经中转页面访问时生效)。
 *
 * 连接建立:
 * 1. 经中转 `/v1/relay/signal?token=` WS 交换 SDP(桌面端为 answer 方);
 * 2. DataChannel "combo" 打开后,fetch/SSE 请求改走 P2P(见 p2pFetch);
 * 3. 连接失败或中途断开 → 自动回退中转隧道(普通 fetch),不影响可用性。
 *
 * 线路帧与桌面端 `p2p.rs::DcFrame` 镜像:
 * - 请求:{"t":"req",id,method,path,query,headers,body<b64>,more} + {"t":"body",id,d,latest}
 * - 响应:{"t":"start",id,status,headers} / {"t":"chunk",id,d} / {"t":"end",id} / {"t":"err",...}
 * - 保活:{"t":"ping"} / {"t":"pong"}
 * 单帧 base64 负载 ≤12KB(桌面端 DataChannel 单消息 16KB 上限)。
 */

import { getAccessToken } from '../authToken';
import { getLanUrl } from '../lanDirect';
import { isTauri } from '../connection';
import { useConnectionStore } from '../../stores/connectionStore';

const FRAME_B64_MAX = 12 * 1024;
const RAW_SPLIT = 9 * 1024;
const CONNECT_TIMEOUT_MS = 15_000;
const RETRY_AFTER_MS = 2 * 60_000;

export type P2pState = 'idle' | 'connecting' | 'ready' | 'dead';

interface PendingReq {
  onHeaders: (status: number, headers: Record<string, string>) => void;
  onError: (status: number, message: string) => void;
  onChunk: (bytes: Uint8Array) => void;
  onEnd: () => void;
}

function b64Encode(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

function b64Decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function randomId(): string {
  return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

/** P2P 是否适用:中转页面(非 Tauri、非本机、有令牌、非局域网直连页)。 */
export function p2pApplicable(): boolean {
  if (typeof window === 'undefined') return false;
  if (isTauri()) return false;
  if (!getAccessToken()) return false;
  const lan = getLanUrl();
  if (lan && window.location.origin === lan) return false; // 已是局域网直连
  const { hostname } = window.location;
  return hostname !== 'localhost' && hostname !== '127.0.0.1';
}

export class P2pTransport {
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private ws: WebSocket | null = null;
  private pending = new Map<string, PendingReq>();
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private lastAttempt = 0;
  state: P2pState = 'idle';

  isReady(): boolean {
    return this.state === 'ready' && this.dc !== null && this.dc.readyState === 'open';
  }

  /** 建立 P2P 连接(幂等;失败标记 dead,RETRY_AFTER_MS 后允许重试)。 */
  async ensureConnected(): Promise<boolean> {
    if (this.isReady()) return true;
    if (this.state === 'connecting') return false;
    if (this.state === 'dead' && Date.now() - this.lastAttempt < RETRY_AFTER_MS) return false;
    if (!p2pApplicable()) return false;
    this.lastAttempt = Date.now();
    this.state = 'connecting';
    try {
      await this.connect();
      return true;
    } catch (e) {
      console.info('[p2p] 连接失败,回退中转:', e);
      this.cleanup();
      this.state = 'dead';
      return false;
    }
  }

  private async connect(): Promise<void> {
    const token = getAccessToken();
    if (!token) throw new Error('缺少访问令牌');
    const wsBase = window.location.origin.replace(/^http/, 'ws');
    const ws = new WebSocket(`${wsBase}/v1/relay/signal?token=${encodeURIComponent(token)}`);
    this.ws = ws;

    const pc = new RTCPeerConnection({
      iceServers: [
        { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
      ],
    });
    this.pc = pc;

    const dc = pc.createDataChannel('combo', { ordered: true });
    this.dc = dc;
    dc.onmessage = (ev) => this.onFrame(String(ev.data));
    dc.onclose = () => this.die();

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') this.die();
    };

    const opened = new Promise<void>((resolve, reject) => {
      dc.onopen = () => resolve();
      dc.onerror = (e) => reject(new Error(`DataChannel 错误: ${e}`));
      setTimeout(() => reject(new Error('P2P 连接超时')), CONNECT_TIMEOUT_MS);
    });

    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error('信令 WS 连接失败'));
      setTimeout(() => reject(new Error('信令 WS 超时')), 8000);
    });

    ws.onmessage = (ev) => {
      let msg: { type: string; data?: string; message?: string };
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (msg.type === 'signal' && msg.data) {
        void this.onSignal(msg.data).catch((e) => this.die(e));
      } else if (msg.type === 'error') {
        this.die(new Error(msg.message ?? '中转信令错误'));
      } else if (msg.type === 'closed') {
        this.die(new Error('桌面端已断开'));
      }
    };
    ws.onclose = () => {
      if (this.state !== 'ready') this.die(new Error('信令通道关闭'));
    };

    // offer:等 ICE 收集完成(非 trickle)再发送完整 SDP
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await this.waitGatheringComplete(pc);
    if (!pc.localDescription) throw new Error('本地描述未就绪');
    this.sendSignal(
      JSON.stringify({ kind: 'offer', sdp: pc.localDescription })
    );

    await opened;
    this.state = 'ready';
    useConnectionStore.getState().setTransport('p2p');
    this.pingTimer = setInterval(() => {
      if (this.isReady()) this.rawSend(JSON.stringify({ t: 'ping' }));
    }, 20_000);
  }

  private waitGatheringComplete(pc: RTCPeerConnection): Promise<void> {
    return new Promise((resolve) => {
      if (pc.iceGatheringState === 'complete') return resolve();
      const timer = setTimeout(resolve, 5000); // 超时按已有候选
      pc.onicegatheringstatechange = () => {
        if (pc.iceGatheringState === 'complete') {
          clearTimeout(timer);
          resolve();
        }
      };
    });
  }

  private async onSignal(data: string): Promise<void> {
    const payload = JSON.parse(data) as {
      kind: string;
      sdp?: { type: RTCSdpType; sdp: string };
    };
    if (payload.kind === 'answer' && payload.sdp && this.pc) {
      await this.pc.setRemoteDescription(payload.sdp);
    } else if (payload.kind === 'error' || payload.kind === 'closed') {
      throw new Error(`桌面端信令: ${payload.kind}`);
    }
  }

  private sendSignal(data: string): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'signal', data }));
    }
  }

  private rawSend(frame: string): void {
    try {
      this.dc?.send(frame);
    } catch {
      this.die();
    }
  }

  private onFrame(text: string): void {
    let f: { t: string; [k: string]: unknown };
    try {
      f = JSON.parse(text);
    } catch {
      return;
    }
    const id = f.id as string | undefined;
    const p = id ? this.pending.get(id) : undefined;
    switch (f.t) {
      case 'start':
        p?.onHeaders(f.status as number, (f.headers as Record<string, string>) ?? {});
        break;
      case 'chunk':
        p?.onChunk(b64Decode(f.d as string));
        break;
      case 'end':
        if (p) {
          this.pending.delete(id!);
          p.onEnd();
        }
        break;
      case 'err':
        if (p) {
          this.pending.delete(id!);
          p.onError(f.status as number, f.message as string);
        }
        break;
      case 'pong':
        break;
      default:
        break;
    }
  }

  private die(err?: unknown): void {
    if (err) console.info('[p2p] 连接断开:', err);
    for (const [, p] of this.pending) p.onError(0, 'P2P 连接断开');
    this.pending.clear();
    this.cleanup();
    this.state = 'dead';
    this.lastAttempt = Date.now();
    // 回退:连接方式不再是 P2P(交回初始判定 local/lan/relay)
    const store = useConnectionStore.getState();
    if (store.transport === 'p2p') {
      const lan = getLanUrl();
      const isLan = lan && typeof window !== 'undefined' && window.location.origin === lan;
      store.setTransport(isLan ? 'lan' : 'relay');
    }
  }

  private cleanup(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    try {
      this.dc?.close();
    } catch {
      /* ignore */
    }
    this.dc = null;
    try {
      this.pc?.close();
    } catch {
      /* ignore */
    }
    this.pc = null;
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
  }

  /**
   * fetch 兼容层:URL 可为绝对地址(仅取 pathname+search)。
   * 返回标准 Response(body 为流,SSE 可直接读取)。
   */
  async fetch(
    url: string,
    init: { method?: string; headers?: Record<string, string>; body?: BodyInit | null; signal?: AbortSignal } = {}
  ): Promise<Response> {
    if (!this.isReady()) throw new Error('P2P 未就绪');
    let path = url;
    let query = '';
    try {
      const u = new URL(url, window.location.origin);
      path = u.pathname;
      query = u.search.replace(/^\?/, '');
    } catch {
      /* 相对路径直接使用 */
    }
    const id = randomId();
    const method = (init.method ?? 'GET').toUpperCase();

    const headers: Record<string, string> = {};
    if (init.headers) {
      for (const [k, v] of Object.entries(init.headers)) {
        if (typeof v === 'string') headers[k] = v;
      }
    }

    let bodyBytes: Uint8Array | null = null;
    if (init.body != null) {
      bodyBytes =
        typeof init.body === 'string'
          ? new TextEncoder().encode(init.body)
          : new Uint8Array(await new Response(init.body).arrayBuffer());
    }

    let headerResolve!: (v: { status: number; headers: Record<string, string> }) => void;
    let headerReject!: (e: Error) => void;
    const headerDeferred = new Promise<{ status: number; headers: Record<string, string> }>(
      (resolve, reject) => {
        headerResolve = resolve;
        headerReject = reject;
      }
    );

    let chunkPush: (b: Uint8Array) => void = () => {};
    let streamClose: () => void = () => {};
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        chunkPush = (bytes) => controller.enqueue(bytes);
        streamClose = () => controller.close();
      },
    });

    const pending: PendingReq = {
      onHeaders: (status, h) => headerResolve({ status, headers: h }),
      onError: (status, message) => {
        headerReject(new P2pHttpError(status, message));
        try {
          streamClose();
        } catch {
          /* ignore */
        }
      },
      onChunk: (bytes) => chunkPush(bytes),
      onEnd: () => {
        try {
          streamClose();
        } catch {
          /* ignore */
        }
      },
    };
    this.pending.set(id, pending);

    if (init.signal) {
      init.signal.addEventListener('abort', () => {
        if (this.pending.delete(id)) {
          this.rawSend(JSON.stringify({ t: 'cancel', id }));
          headerReject(new DOMException('请求已取消', 'AbortError'));
          try {
            streamClose();
          } catch {
            /* ignore */
          }
        }
      }, { once: true });
    }

    // 发送请求(体超 12KB 分片)
    if (bodyBytes) {
      const b64 = b64Encode(bodyBytes);
      if (b64.length > FRAME_B64_MAX) {
        this.rawSend(
          JSON.stringify({ t: 'req', id, method, path, query, headers, body: null, more: true })
        );
        for (let offset = 0; offset < bodyBytes.length; offset += RAW_SPLIT) {
          const end = Math.min(offset + RAW_SPLIT, bodyBytes.length);
          const last = end >= bodyBytes.length;
          this.rawSend(
            JSON.stringify({ t: 'body', id, d: b64Encode(bodyBytes.subarray(offset, end)), last })
          );
        }
      } else {
        this.rawSend(JSON.stringify({ t: 'req', id, method, path, query, headers, body: b64 }));
      }
    } else {
      this.rawSend(JSON.stringify({ t: 'req', id, method, path, query, headers, body: null }));
    }

    const { status, headers: respHeaders } = await headerDeferred;
    const h = new Headers();
    for (const [k, v] of Object.entries(respHeaders)) {
      try {
        h.set(k, v);
      } catch {
        /* 非法头跳过 */
      }
    }
    // 204/205/304 不允许携带 body,构造 Response 时必须显式传 null
    const bodyless = status === 204 || status === 205 || status === 304;
    return bodyless
      ? new Response(null, { status, headers: h })
      : new Response(stream, { status, headers: h });
  }
}

export class P2pHttpError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
    this.name = 'P2pHttpError';
  }
}

let transport: P2pTransport | null = null;

export function getP2pTransport(): P2pTransport | null {
  if (typeof window === 'undefined') return null;
  if (!transport) transport = new P2pTransport();
  return transport;
}

export function p2pReady(): boolean {
  return transport?.isReady() ?? false;
}

/** 应用启动后异步建立 P2P(不阻塞;失败静默回退中转)。 */
export async function ensureP2pConnected(): Promise<void> {
  const t = getP2pTransport();
  if (!t) return;
  await t.ensureConnected();
}
