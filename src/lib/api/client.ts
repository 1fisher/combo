import { getProxyBaseUrl } from '../connection';
import { getClientId } from '../clientId';
import { getAccessToken } from '../authToken';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string
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
    res = await fetch(`${base}${path}?${q.toString()}`, {
      method: opts.method ?? 'GET',
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: ac.signal,
    });
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
    try {
      const j = (await res.json()) as { message?: string };
      if (j.message) message = j.message;
    } catch {
      /* keep statusText */
    }
    throw new ApiError(res.status, message);
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}
