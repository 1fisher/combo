import { getProxyBaseUrl } from '../connection';
import { getClientId } from '../clientId';
import { getAccessToken } from '../authToken';
import { getP2pTransport } from '../p2p/transport';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    /** 后端结构化错误码(如 dir_permission_required),供前端针对性弹窗 */
    public code?: string,
    /** 部分错误携带的关联路径(如待授权目录) */
    public path?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function apiRequest<T>(
  path: string,
  opts: { method?: string; query?: Record<string, string>; body?: unknown; timeoutMs?: number } = {}
): Promise<T> {
  const base = getProxyBaseUrl();
  const q = new URLSearchParams(opts.query ?? {});
  if (!q.has('client_id')) q.set('client_id', getClientId());
  // 远程访问令牌:通过 Authorization header 传递(proxy 中间件校验)
  const token = getAccessToken();
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const ac = new AbortController();
  const timer = opts.timeoutMs
    ? setTimeout(() => ac.abort(), opts.timeoutMs)
    : undefined;
  let res: Response;
  try {
    const url = `${base}${path}?${q.toString()}`;
    // P2P 就绪时请求走 WebRTC DataChannel(移动端经中转访问场景)
    const p2p = getP2pTransport();
    if (p2p?.isReady()) {
      res = await p2p.fetch(url, {
        method: opts.method ?? 'GET',
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: ac.signal,
      });
    } else {
      res = await fetch(url, {
        method: opts.method ?? 'GET',
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: ac.signal,
      });
    }
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') {
      throw new ApiError(0, '请求超时');
    }
    throw new ApiError(0, 'network error');
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (!res.ok) {
    let message = res.statusText;
    let code: string | undefined;
    let path: string | undefined;
    try {
      const j = (await res.json()) as { message?: string; code?: string; path?: string };
      if (j.message) message = j.message;
      code = j.code;
      path = j.path;
    } catch {
      /* keep statusText */
    }
    throw new ApiError(res.status, message, code, path);
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

/** 二进制请求体版 apiRequest(如语音 PCM 上传):body 为原始字节,响应仍按 JSON 解析。 */
export async function apiRequestRaw<T>(
  path: string,
  opts: {
    method?: string;
    query?: Record<string, string>;
    body: ArrayBuffer;
    contentType?: string;
    timeoutMs?: number;
  }
): Promise<T> {
  const base = getProxyBaseUrl();
  const q = new URLSearchParams(opts.query ?? {});
  if (!q.has('client_id')) q.set('client_id', getClientId());
  const token = getAccessToken();
  const headers: Record<string, string> = {
    'Content-Type': opts.contentType ?? 'application/octet-stream',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const ac = new AbortController();
  const timer = opts.timeoutMs ? setTimeout(() => ac.abort(), opts.timeoutMs) : undefined;
  let res: Response;
  try {
    const url = `${base}${path}?${q.toString()}`;
    const p2p = getP2pTransport();
    if (p2p?.isReady()) {
      res = await p2p.fetch(url, {
        method: opts.method ?? 'POST',
        headers,
        body: opts.body,
        signal: ac.signal,
      });
    } else {
      res = await fetch(url, {
        method: opts.method ?? 'POST',
        headers,
        body: opts.body,
        signal: ac.signal,
      });
    }
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') {
      throw new ApiError(0, '请求超时');
    }
    throw new ApiError(0, 'network error');
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (!res.ok) {
    let message = res.statusText;
    let code: string | undefined;
    try {
      const j = (await res.json()) as { message?: string; code?: string };
      if (j.message) message = j.message;
      code = j.code;
    } catch {
      /* keep statusText */
    }
    throw new ApiError(res.status, message, code);
  }
  const text = await res.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

/**
 * 二进制响应版请求(如 TTS 合成返回 WAV):响应按 ArrayBuffer 读取,
 * 错误响应仍按 JSON 解析为 ApiError;支持外部 AbortSignal(打断朗读)。
 */
export async function apiRequestBinary(
  path: string,
  opts: {
    method?: string;
    query?: Record<string, string>;
    body?: unknown;
    timeoutMs?: number;
    signal?: AbortSignal;
  } = {}
): Promise<ArrayBuffer> {
  const base = getProxyBaseUrl();
  const q = new URLSearchParams(opts.query ?? {});
  if (!q.has('client_id')) q.set('client_id', getClientId());
  const token = getAccessToken();
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const ac = new AbortController();
  const timer = opts.timeoutMs ? setTimeout(() => ac.abort(), opts.timeoutMs) : undefined;
  if (opts.signal) {
    opts.signal.addEventListener('abort', () => ac.abort(), { once: true });
  }
  const signal = opts.signal ?? ac.signal;
  let res: Response;
  try {
    const url = `${base}${path}?${q.toString()}`;
    const p2p = getP2pTransport();
    const init = {
      method: opts.method ?? 'POST',
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal,
    };
    res = p2p?.isReady() ? await p2p.fetch(url, init) : await fetch(url, init);
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') {
      throw new ApiError(0, '请求已取消');
    }
    throw new ApiError(0, 'network error');
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (!res.ok) {
    let message = res.statusText;
    let code: string | undefined;
    try {
      const j = (await res.json()) as { message?: string; code?: string };
      if (j.message) message = j.message;
      code = j.code;
    } catch {
      /* keep statusText */
    }
    throw new ApiError(res.status, message, code);
  }
  return res.arrayBuffer();
}
