/**
 * 局域网直连引导。
 *
 * 桌面端二维码在 token 之外携带 `&lan=http://<桌面局域网IP>:<端口>`:
 * - 手机扫码打开中转页面 → 本模块提取并持久化 lan 地址 → 自动整页跳转到
 *   桌面端直连页面(页面与 API 全部同源直连,不再经中转);
 * - 手机不在同一网络时跳转会失败(浏览器错误页),返回中转页后由
 *   sessionStorage 标记避免再次自动跳转,UI 显示「已回退云端中转」。
 *
 * 注:https 中转页面无法用 fetch 探测 http 局域网地址(mixed content),
 * 只能通过整页导航尝试;每会话仅自动尝试一次。
 */

const LAN_URL_KEY = 'combo.lanUrl';
const LAN_TRIED_KEY = 'combo.lanTried';

/**
 * 局域网直连地址白名单:必须为 http/https,且主机为私有网段/本机地址。
 * 该值来自二维码 `?lan=` 参数(攻击者可伪造扫码页),若放任任意 http/https
 * 地址进入 `window.location.replace`,会把扫码用户重定向到任意站点
 * (开放重定向);`javascript:` 等可执行协议则直接 XSS。故写入与跳转两处
 * 都做双重校验:协议白名单 + 主机限定 RFC1918 私有网段 / loopback /
 * 链路本地 / CGNAT(Tailscale 等 100.64.0.0/10)/ mDNS 域名。
 */
function isAllowedLanUrl(value: string): boolean {
  let host: string;
  try {
    const u = new URL(value);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    host = u.hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (host === '::1' || host.startsWith('fe80:')) return true;
  // 仅接受 IPv4 字面量做私网判断;域名一律拒绝(DNS 可指向公网钓鱼站)
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const octets = m.slice(1).map(Number);
  if (octets.some((n) => n > 255)) return false;
  const [a, b] = [octets[0], octets[1]];
  return (
    a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

export function getLanUrl(): string | null {
  try {
    return localStorage.getItem(LAN_URL_KEY);
  } catch {
    return null;
  }
}

export function setLanUrl(url: string): void {
  try {
    const clean = url.trim().replace(/\/$/, '');
    if (clean && isAllowedLanUrl(clean)) localStorage.setItem(LAN_URL_KEY, clean);
  } catch {
    /* 忽略存储不可用 */
  }
}

export function clearLanUrl(): void {
  try {
    localStorage.removeItem(LAN_URL_KEY);
    sessionStorage.removeItem(LAN_TRIED_KEY);
  } catch {
    /* 忽略存储不可用 */
  }
}

function lanTried(): boolean {
  try {
    return sessionStorage.getItem(LAN_TRIED_KEY) === '1';
  } catch {
    return false;
  }
}

/** 局域网直连尝试过但用户回到了中转页(视为直连失败)。 */
export function lanDirectFailed(): boolean {
  const lan = getLanUrl();
  if (!lan) return false;
  try {
    if (typeof window !== 'undefined' && window.location.origin === lan) return false;
  } catch {
    /* ignore */
  }
  return lanTried();
}

/** 清除「已尝试」标记(用户点击重试直连时调用)。 */
export function resetLanTried(): void {
  try {
    sessionStorage.removeItem(LAN_TRIED_KEY);
  } catch {
    /* 忽略存储不可用 */
  }
}

/**
 * 从当前 URL 的 `?lan=` 提取局域网地址并持久化,然后从地址栏移除该参数。
 * @returns 提取到的 lan 地址(若有)
 */
export function extractLanFromUrl(): string | null {
  if (typeof window === 'undefined') return null;
  const params = new URLSearchParams(window.location.search);
  const lan = params.get('lan');
  if (!lan) return null;
  setLanUrl(lan);
  params.delete('lan');
  const remaining = params.toString();
  const newSearch = remaining ? `?${remaining}` : '';
  window.history.replaceState(
    null,
    '',
    `${window.location.pathname}${newSearch}${window.location.hash}`
  );
  return lan;
}

/**
 * 尝试自动跳转到局域网直连页面(每会话仅一次)。
 * 跳转目标 = `<lan>/?token=<token>`:桌面端直连页面自行提取 token。
 * @returns 是否发起了跳转
 */
export function maybeRedirectToLan(token: string | null): boolean {
  if (typeof window === 'undefined') return false;
  const lan = getLanUrl();
  if (!lan || !token) return false;
  // 协议 + 主机白名单(存储值同样可能是伪造的):仅允许 http(s) 私网地址,
  // 拒绝 javascript: 等可执行协议与公网站点(防开放重定向)。
  if (!isAllowedLanUrl(lan)) return false;
  let sameOrigin = false;
  try {
    sameOrigin = window.location.origin === lan;
  } catch {
    return false;
  }
  if (sameOrigin) return false; // 已在直连页面
  if (isLocalHostname(window.location.origin)) return false; // 桌面开发模式
  if (lanTried()) return false; // 本会话已尝试过,不再自动跳(避免回退循环)
  try {
    sessionStorage.setItem(LAN_TRIED_KEY, '1');
  } catch {
    /* 存储不可用时仍允许跳转 */
  }
  const url = `${lan}/?token=${encodeURIComponent(token)}`;
  window.location.replace(url);
  return true;
}

function isLocalHostname(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    return (
      hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1'
    );
  } catch {
    return false;
  }
}
