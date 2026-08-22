/**
 * 移动端连接设置:解析扫码/粘贴的连接地址,并判定是否展示「连接设置屏」。
 *
 * 连接地址(桌面端 MobileConnectDialog 生成的二维码内容)形如:
 *   https://<中转域名>/?token=<令牌>[&lan=http://<桌面局域网IP>:<端口>]
 *
 * 扫码后解析出 token/lan/server,存入与既有远程访问相同的 localStorage 键:
 *  - token → combo.token(authToken.ts)
 *  - lan   → combo.lanUrl(lanDirect.ts,内部有私有网段白名单校验)
 * 再经由代理地址覆盖(connection.ts)决定 API 走当前源(中转/域名)还是
 * 手动配置的地址,最后健康检查通过即进入工作台。
 */
import { hasAccessToken, setAccessToken } from './authToken';
import { setLanUrl } from './lanDirect';
import {
  clearProxyUrlOverride,
  isLocalHostname,
  normalizeHttpBaseUrl,
  setProxyUrlOverride,
} from './connection';
import { isStandalonePwa, isMobileViewport } from './pwa';
import { isTauri } from './connection';

export interface ConnectParams {
  /** 连接来源 server(协议://主机[:端口]) */
  server: string;
  /** 访问令牌 */
  token: string;
  /** 局域网直连地址(私有网段白名单校验后才有值) */
  lan: string | null;
}

/**
 * 解析连接地址(二维码内容/粘贴的地址)。
 * 仅接受 http(s),且必须携带 `token` 参数;返回 null 表示无法解析。
 */
export function parseConnectUrl(raw: string): ConnectParams | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const token = url.searchParams.get('token');
  if (!token) return null;
  const server = `${url.protocol}//${url.host}`;
  const lan = url.searchParams.get('lan');
  return {
    server,
    token,
    lan: lan && lan.trim() ? lan.trim() : null,
  };
}

/**
 * 连接屏展示决策(纯函数,便于测试):
 *  - Tauri 桌面套壳:本地有 serve,无需连接设置;
 *  - 已持有令牌:视为已连接,直接进入工作台;
 *  - 本地回环(桌面浏览器开发):无需令牌,直接进入;
 *  - 远端(非回环)+ 未持令牌:仅移动视口或已安装 standalone 时展示。
 */
export function shouldShowMobileConnect(input: {
  isTauri: boolean;
  hasToken: boolean;
  isLocalOrigin: boolean;
  isStandalone: boolean;
  isMobile: boolean;
}): boolean {
  if (input.isTauri) return false;
  if (input.hasToken) return false;
  if (input.isLocalOrigin) return false;
  return input.isStandalone || input.isMobile;
}

/**
 * 是否应展示「连接设置屏」:远程/移动端、尚未持有令牌。
 * 本地回环(桌面开发)与 Tauri 套壳无需令牌,直接进入工作台;已安装的
 * standalone PWA 或移动视口且未连接时展示连接屏。
 */
export function shouldShowMobileConnectScreen(): boolean {
  if (typeof window === 'undefined') return false;
  return shouldShowMobileConnect({
    isTauri: isTauri(),
    hasToken: hasAccessToken(),
    isLocalOrigin: isLocalHostname(window.location.origin),
    isStandalone: isStandalonePwa(),
    isMobile: isMobileViewport(),
  });
}

/**
 * 保存连接并打通服务,返回是否连接成功。
 * @param onOk 连接成功后回调(由调用方决定下一步,如隐藏连接屏)
 */
export async function applyConnection(
  params: ConnectParams,
): Promise<{ ok: boolean; error?: string }> {
  setAccessToken(params.token);
  if (params.lan) setLanUrl(params.lan);

  // 决定 API 基础地址:
  //  - 手动/扫码地址与当前源一致 → 用当前源(中转/域名,首选 P2P/中转);
  //  - 不同源且为合法 http(s) → 设为代理覆盖(用户显式指向远端);
  //  - 否则回退当前源。
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const normalizedServer = normalizeHttpBaseUrl(params.server);
  if (normalizedServer && normalizedServer !== origin) {
    setProxyUrlOverride(normalizedServer);
  } else {
    clearProxyUrlOverride(); // 扫描的二维码指向当前源:清除之前的手动覆盖
  }

  const base = normalizedServer && normalizedServer !== origin ? normalizedServer : origin;
  if (!base) return { ok: false, error: '缺少连接地址' };

  try {
    const res = await fetch(`${base}/v1/health`, { method: 'GET' });
    if (!res.ok) throw new Error(`健康检查失败(${res.status})`);
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `无法连接到该地址,请检查桌面端是否在线、网络是否可达(${msg})` };
  }
}
