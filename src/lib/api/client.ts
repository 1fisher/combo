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
