/**
 * 移动端连接设置:解析扫码/粘贴的连接地址,并判定是否展示「连接设置屏」。
 *
 * 连接地址(桌面端 MobileConnectDialog 生成的二维码内容)形如:
 *   https://<中转域名>/?token=<令牌>[&lan=http://<桌面局域网IP>:<端口>]
 *
 * 扫码后解析出 token/lan/server,存入与既有远程访问相同的 localStorage 键:
 *  - token → combo.token(authToken.ts)
 *  - lan   → combo.lanUrl(lanDirect.ts,内部有私有网段白名单校验)
 *
 * Web/PWA:健康检查通过后进入工作台(同源代理)。
 * 原生壳(Android):构造目标页地址并整页导航过去,由页面自身启动逻辑
 * 接管鉴权与连接方式选择;壳内 localStorage 与目标页隔离,因此另存
 * 「最近连接地址」供下次启动预填。
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
import { isNativeApp } from './native';

export interface ConnectParams {
  /** 连接来源 server(协议://主机[:端口]) */
  server: string;
  /** 访问令牌 */
  token: string;
  /** 局域网直连地址(私有网段白名单校验后才有值) */
  lan: string | null;
}

// ---------- Android 壳:目标页构造与最近连接记忆 ----------

/** 原生壳记忆「最近一次连接的服务器地址」(localStorage),下次启动预填。 */
const LAST_SERVER_KEY = 'combo.nativeLastServer';

export function getLastServer(): string | null {
  try {
    return localStorage.getItem(LAST_SERVER_KEY);
  } catch {
    return null;
  }
}

export function rememberLastServer(server: string): void {
  try {
    localStorage.setItem(LAST_SERVER_KEY, server);
  } catch {
    /* 忽略存储不可用 */
  }
}

/**
 * 由连接参数构造移动端页面地址(WebView 随后整页导航过去):
 *   <server>/?token=<令牌>[&lan=<局域网直连地址>]
 * 页面自身的启动逻辑(extractTokenFromUrl 等)会接管鉴权与连接方式选择。
 */
export function buildTargetUrl(params: ConnectParams): string {
  const server = params.server.replace(/\/+$/, '');
  const query = new URLSearchParams({ token: params.token });
  if (params.lan) query.set('lan', params.lan);
  return `${server}/?${query.toString()}`;
}

// ---------- 连接地址解析 ----------

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

// ---------- 连接屏展示判定 ----------

/**
 * 连接屏展示决策(纯函数,便于测试):
 *  - 原生壳(Android/iOS):本地 origin 是壳自身,永远先展示连接屏;
 *  - Tauri 桌面套壳:本地有 serve,无需连接设置;
 *  - 已持有令牌:视为已连接,直接进入工作台;
 *  - 本地回环(桌面浏览器开发):无需令牌,直接进入;
 *  - 远端(非回环)+ 未持令牌:仅移动视口或已安装 standalone 时展示。
 */
export function shouldShowMobileConnect(input: {
  isNative?: boolean;
  isTauri: boolean;
  hasToken: boolean;
  isLocalOrigin: boolean;
  isStandalone: boolean;
  isMobile: boolean;
}): boolean {
  if (input.isNative) return true;
  if (input.isTauri) return false;
  if (input.hasToken) return false;
  if (input.isLocalOrigin) return false;
  return input.isStandalone || input.isMobile;
}

/** 是否应展示「连接设置屏」。原生壳永远展示;其余见 shouldShowMobileConnect。 */
export function shouldShowMobileConnectScreen(): boolean {
  if (typeof window === 'undefined') return false;
  return shouldShowMobileConnect({
    isNative: isNativeApp(),
    isTauri: isTauri(),
    hasToken: hasAccessToken(),
    isLocalOrigin: isLocalHostname(window.location.origin),
    isStandalone: isStandalonePwa(),
    isMobile: isMobileViewport(),
  });
}

// ---------- 连接动作 ----------

/**
 * 保存连接并打通服务,返回是否连接成功。
 *
 * Web/PWA:`verifyHealth` 默认开启,健康检查通过才算成功(避免带着不可达
 * 配置进入工作台)。原生壳传 `{ verifyHealth: false }` 跳过预检——壳内
 * fetch 存在 CORS/混合内容不确定性,且导航后的页面自身有完整的连接态 UI,
 * 预检失败不应阻断进入。
 */
export async function applyConnection(
  params: ConnectParams,
  opts: { verifyHealth?: boolean } = {},
): Promise<{ ok: boolean; error?: string }> {
  const verifyHealth = opts.verifyHealth ?? true;

  setAccessToken(params.token);
  if (params.lan) setLanUrl(params.lan);

  // 决定 API 基础地址(仅 Web/PWA 场景生效;原生壳随后整页导航,此配置无副作用):
  //  - 手动/扫码地址与当前源一致 → 用当前源(中转/域名,首选 P2P/中转);
  //  - 不同源且为合法 http(s) → 设为代理覆盖(用户显式指向远端);
  //  - 否则回退当前源。
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const normalizedServer = normalizeHttpBaseUrl(params.server);
  if (!verifyHealth || !origin) {
    // 原生壳:只落盘 token/lan,不做代理配置(导航后由目标页自己管理)
    if (!verifyHealth) return { ok: true };
  }
  if (normalizedServer && normalizedServer !== origin) {
    setProxyUrlOverride(normalizedServer);
  } else {
    clearProxyUrlOverride(); // 扫描的二维码指向当前源:清除之前的手动覆盖
  }

  const base = normalizedServer && normalizedServer !== origin ? normalizedServer : origin;
  if (!base) return { ok: false, error: '缺少连接地址' };

  if (!verifyHealth) return { ok: true };

  try {
    const res = await fetch(`${base}/v1/health`, { method: 'GET' });
    if (!res.ok) throw new Error(`健康检查失败(${res.status})`);
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `无法连接到该地址,请检查桌面端是否在线、网络是否可达(${msg})` };
  }
}
