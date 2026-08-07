/**
 * 远程访问令牌管理。
 *
 * 移动端扫码打开后,URL 中携带 `?token=<xxx>`(由桌面端生成并嵌入二维码)。
 * 启动时从 URL 提取并存入 localStorage,后续每个 API/SSE 请求自动携带。
 * 桌面端(本地回环)无需令牌,proxy 中间件自动放行。
 */
const KEY = 'combo.token';

export function getAccessToken(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function setAccessToken(token: string): void {
  try {
    localStorage.setItem(KEY, token);
  } catch {
    /* 忽略存储不可用 */
  }
}

export function clearAccessToken(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* 忽略存储不可用 */
  }
}

/**
 * 从当前 URL 的 `?token=` 提取令牌并持久化,然后从地址栏移除令牌参数
 * (避免泄露在浏览历史/日志中)。仅当 URL 含 token 时生效。
 *
 * @returns 提取到的 token(若有)
 */
export function extractTokenFromUrl(): string | null {
  if (typeof window === 'undefined') return null;
  const params = new URLSearchParams(window.location.search);
  const token = params.get('token');
  if (!token) return null;
  setAccessToken(token);
  // 从地址栏移除 token 参数,保留其余查询参数
  params.delete('token');
  const remaining = params.toString();
  const newSearch = remaining ? `?${remaining}` : '';
  const newUrl = `${window.location.pathname}${newSearch}${window.location.hash}`;
  window.history.replaceState(null, '', newUrl);
  return token;
}

/** 当前是否持有令牌(移动端/远程访问场景)。 */
export function hasAccessToken(): boolean {
  return getAccessToken() !== null;
}
