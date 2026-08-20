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

/**
 * 把非 2xx 响应解析为 ApiError。错误体两种形态:
 * - JSON `{message, code, path}`(如 dir_permission_required);
 * - 纯文本(axum `(StatusCode, String)` 错误即此形态,body 是中文提示但
 *   content-type 为 text/plain,如 409 的「该会话已有正在进行的任务…」)。
 * 此前只按 JSON 解析,失败退回 statusText(用户只看到 "Conflict" 这类
 * 状态名,拿不到真实原因),这里改为文本兜底。body 只能读一次,故先
 * 读 text 再尝试 JSON.parse。
 */
async function toApiError(res: Response): Promise<ApiError> {
  let message = res.statusText;
  let code: string | undefined;
  let errPath: string | undefined;
  const raw = await res.text().catch(() => '');
  if (raw) {
    try {
      const j = JSON.parse(raw) as { message?: unknown; code?: unknown; path?: unknown };
      if (j && typeof j === 'object') {
        if (typeof j.message === 'string' && j.message) message = j.message;
        if (typeof j.code === 'string' && j.code) code = j.code;
        if (typeof j.path === 'string' && j.path) errPath = j.path;
      }
    } catch {
      /* 非 JSON:纯文本错误体,截断后直接作为错误消息 */
      const t = raw.trim().slice(0, 500);
      if (t) message = t;
    }
  }
  return new ApiError(res.status, message, code, errPath);
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
    throw await toApiError(res);
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
    throw await toApiError(res);
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
    throw await toApiError(res);
  }
  return res.arrayBuffer();
}

/**
 * NDJSON 流式请求(如 TTS 流式合成):响应体为逐行 JSON,每解析出一行就
 * 回调 onLine(行内 JSON 已解析);onLine 抛错会取消下载并把错误抛出。
 * P2P 就绪时走 DataChannel(响应一次性到达,无流式 body,退化为全量读取后
 * 逐行回调,行为一致)。错误响应按 JSON 解析为 ApiError(同 apiRequestBinary)。
 */
export async function apiRequestNdjson(
  path: string,
  opts: {
    body?: unknown;
    signal?: AbortSignal;
    onLine: (line: unknown) => void;
  }
): Promise<void> {
  const base = getProxyBaseUrl();
  const q = new URLSearchParams();
  if (!q.has('client_id')) q.set('client_id', getClientId());
  const token = getAccessToken();
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const url = `${base}${path}?${q.toString()}`;
  const init = {
    method: 'POST',
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal: opts.signal,
  };
  let res: Response;
  try {
    const p2p = getP2pTransport();
    res = p2p?.isReady() ? await p2p.fetch(url, init) : await fetch(url, init);
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') {
      throw new ApiError(0, '请求已取消');
    }
    throw new ApiError(0, 'network error');
  }
  if (!res.ok) {
    throw await toApiError(res);
  }
  const dispatch = (raw: string) => {
    const line = raw.trim();
    if (!line) return;
    opts.onLine(JSON.parse(line));
  };
  if (typeof res.body?.getReader === 'function') {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const raw = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        try {
          dispatch(raw);
        } catch (e) {
          void reader.cancel().catch(() => {});
          throw e;
        }
      }
    }
    buf += decoder.decode();
    dispatch(buf);
  } else {
    // P2P / 旧环境无流式 body:全量读取后逐行回调
    const text = await res.text();
    for (const raw of text.split('\n')) dispatch(raw);
  }
}
