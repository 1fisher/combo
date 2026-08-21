import { useConnectionStore } from '../stores/connectionStore';

let proxyBaseUrl = '';

/** 运行时代理地址覆盖(localStorage),用于前后端分离部署时指向远端 proxy。 */
const PROXY_OVERRIDE_KEY = 'combo.proxyUrl';

/** 外部访问域名(localStorage),用于域名部署时生成二维码和远程连接。 */
const EXTERNAL_URL_KEY = 'combo.externalUrl';

/** combo-cli 默认本地端口:被占用时 serve 自动 +1 递增,前端按此端口起扫描本机实例。 */
export const DEFAULT_LOCAL_PORT = 18236;

/** 本机 combo-cli 端口扫描范围(18236 → 18236 + SCAN_PORT_COUNT - 1)。 */
export const SCAN_PORT_COUNT = 20;

/** 默认中转域名,远程访问时通过此地址做中转,实现扫码即用。 */
export const DEFAULT_RELAY_URL = 'https://proxy.apesoft.cn';

// ---------- 外部访问域名 ----------

export function getExternalUrl(): string | null {
  try {
    return localStorage.getItem(EXTERNAL_URL_KEY);
  } catch {
    return null;
  }
}

/**
 * 获取生效的外部访问地址:优先用户配置的自定义域名,否则使用默认中转域名。
 * 用于移动端扫码二维码的基础地址。
 */
export function getEffectiveExternalUrl(): string {
  return getExternalUrl() ?? DEFAULT_RELAY_URL;
}

export function setExternalUrl(url: string): void {
  // 归一化 scheme 为小写(Https:// → https://),避免后续 ws/wss 转换正则失配
  const normalized = url.trim().replace(/^(HTTPS?|https?):\/\//i, (m) => m.toLowerCase());
  const clean = normalized.replace(/\/$/, '');
  try {
    if (clean) localStorage.setItem(EXTERNAL_URL_KEY, clean);
    else localStorage.removeItem(EXTERNAL_URL_KEY);
  } catch {
    /* 忽略存储不可用 */
  }
}

export function clearExternalUrl(): void {
  try {
    localStorage.removeItem(EXTERNAL_URL_KEY);
  } catch {
    /* 忽略存储不可用 */
  }
}

// ---------- 代理地址 ----------

/**
 * 规范化并校验代理地址:仅接受 http/https(裸 `host[:port]` 默认补 `http://`),
 * 其他协议(`javascript:`/`data:`/`file:` 等)一律拒绝。代理地址会被拼进
 * `<img src>`/`<iframe src>`/fetch 等所有后端请求 URL,而它属不可信输入
 * (设置界面手动输入 → localStorage 持久化),必须在写入边界收敛,
 * 避免任意 DOM 文本流入 URL 上下文(CodeQL js/xss / xss-through-dom)。
 *
 * @returns 规范化后的地址;`''` 表示显式清空;`null` 表示非法(拒绝写入)
 */
export function normalizeHttpBaseUrl(url: string): string | null {
  const trimmed = url.trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  let candidate = trimmed;
  if (!/^https?:\/\//i.test(candidate)) {
    // 已带其他协议前缀(如 javascript:、data:)直接拒绝;裸 host[:port] 补 http://
    if (/^[a-z][a-z0-9+.-]*:/i.test(candidate)) return null;
    candidate = `http://${candidate}`;
  }
  try {
    const u = new URL(candidate);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/$/, '')}`;
  } catch {
    return null;
  }
}

export function getProxyBaseUrl(): string {
  return proxyBaseUrl;
}

export function setProxyBaseUrl(url: string): void {
  const clean = normalizeHttpBaseUrl(url);
  if (clean === null) return; // 非法协议:拒绝写入,保留现有值
  proxyBaseUrl = clean;
}

let resolvingBase: Promise<string> | null = null;

/**
 * 确保代理地址已解析:已设置则直接返回;否则异步解析并设置。
 * 供挂载期就需要 base 的组件(终端 WebSocket、SSE)使用,
 * 避免拿到空字符串导致相对 URL 连到页面源(localhost:5173)。
 */
export function ensureProxyBaseUrl(): Promise<string> {
  const current = getProxyBaseUrl();
  if (current) return Promise.resolve(current);
  if (!resolvingBase) {
    resolvingBase = resolveProxyBaseUrl()
      .then((url) => {
        setProxyBaseUrl(url);
        return url;
      })
      .finally(() => {
        resolvingBase = null;
      });
  }
  return resolvingBase;
}

export function getProxyUrlOverride(): string | null {
  try {
    return localStorage.getItem(PROXY_OVERRIDE_KEY);
  } catch {
    return null;
  }
}

/** 保存代理地址覆盖并立即生效。非法协议(非 http/https)拒绝写入。 */
export function setProxyUrlOverride(url: string): void {
  const clean = normalizeHttpBaseUrl(url);
  if (!clean) return; // 空串/非法值都不写入(清空走 clearProxyUrlOverride)
  try {
    localStorage.setItem(PROXY_OVERRIDE_KEY, clean);
  } catch {
    /* 忽略存储不可用 */
  }
  setProxyBaseUrl(clean);
}

/** 清除覆盖,回到环境变量/本地默认值。 */
export function clearProxyUrlOverride(): void {
  try {
    localStorage.removeItem(PROXY_OVERRIDE_KEY);
  } catch {
    /* 忽略存储不可用 */
  }
  setProxyBaseUrl('');
}

export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export async function checkHealth(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/v1/health`);
    return res.ok;
  } catch {
    return false;
  }
}

/** 带超时的健康检查(扫描端口时避免某个端口挂起拖慢整个扫描)。 */
async function checkHealthTimeout(baseUrl: string, timeoutMs: number): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}/v1/health`, { signal: ctrl.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** 判断地址是否指向本机(localhost/回环)。 */
export function isLocalHostname(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    return (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '::1' ||
      hostname === '[::1]'
    );
  } catch {
    return false;
  }
}

/**
 * 扫描本机 combo-cli:从默认端口 18236 起逐个健康检查,返回第一个可用地址;
 * 全部不可用返回 null。combo-cli serve 端口被占用时自动 +1,因此按端口段扫描
 * 即可匹配到本机正在运行的那一个实例。
 */
export async function findLocalComboCli(): Promise<string | null> {
  for (let i = 0; i < SCAN_PORT_COUNT; i++) {
    const base = `http://127.0.0.1:${DEFAULT_LOCAL_PORT + i}`;
    if (await checkHealthTimeout(base, 300)) return base;
  }
  return null;
}

export async function resolveProxyBaseUrl(): Promise<string> {
  // 运行时覆盖优先:前后端分离部署时用户可手动指向远端 proxy
  // (历史版本写入的值未经白名单校验,读取时再收敛一次)
  const override = normalizeHttpBaseUrl(getProxyUrlOverride() ?? '');
  if (override) return override;
  const fromEnv = import.meta.env.VITE_PROXY_URL as string | undefined;
  if (fromEnv) return fromEnv.replace(/\/$/, '');
  if (isTauri()) {
    const { invoke } = await import('@tauri-apps/api/core');
    // 优先通过 command 主动查询端口(消除 proxy-ready 事件竞态)
    try {
      const port = await invoke<number | null>('get_proxy_port');
      if (port) return `http://127.0.0.1:${port}`;
    } catch {
      // command 不存在(旧版本),回退到事件机制
    }
    // 轮询 command 直到端口就绪,或事件到达;超过 10s 仍未就绪(如内嵌 serve
    // 启动失败)则回退到本机端口扫描,自动匹配外部 combo-cli serve。
    const { listen } = await import('@tauri-apps/api/event');
    const portUrl = await new Promise<string | null>((resolve) => {
      let resolved = false;
      const done = (url: string | null) => {
        if (!resolved) {
          resolved = true;
          resolve(url);
        }
      };
      listen<{ port: number }>('proxy-ready', (e) => {
        done(`http://127.0.0.1:${e.payload.port}`);
      }).then((fn) => {
        // 收到 listener 注册成功后,也主动查一次(端口可能已就绪)
        invoke<number | null>('get_proxy_port').then((p) => {
          if (p) done(`http://127.0.0.1:${p}`);
        }).catch(() => {});
        // 保留 unlisten 引用避免被 GC
        void fn;
      });
      // 持续轮询直到端口就绪(内嵌 serve 绑定 18236+,端口经事件下发)
      const poll = () => {
        if (resolved) return;
        invoke<number | null>('get_proxy_port').then((p) => {
          if (p) done(`http://127.0.0.1:${p}`);
          else if (!resolved) setTimeout(poll, 500);
        }).catch(() => {
          if (!resolved) setTimeout(poll, 500);
        });
      };
      setTimeout(poll, 100);
      setTimeout(() => done(null), 10_000);
    });
    if (portUrl) return portUrl;
  }
  // 浏览器模式:非 localhost 域名(中转/域名部署)时,使用同源地址作为代理
  if (typeof window !== 'undefined') {
    const { hostname } = window.location;
    if (hostname !== 'localhost' && hostname !== '127.0.0.1') {
      return window.location.origin;
    }
  }
  // 本机默认:扫描本机 combo-cli(默认端口 18236 起,被占用自动 +1);
  // 全部不可用时回到默认端口,connectLoop 在失败时持续扫描自动匹配。
  const found = await findLocalComboCli();
  return found ?? `http://127.0.0.1:${DEFAULT_LOCAL_PORT}`;
}

/**
 * 健康检查间隔(自适应):
 * - 连接正常时低频探活(15s)——健康轮询只为刷新连接状态,无需高频;
 * - 断连时快速重试(2s)——尽快恢复,并保持「连续 3 次失败触发重扫描」
 *   的恢复节奏(约 6s)不变;
 * - 页面不可见(后台标签/最小化到托盘)时暂停探活,恢复可见后 ≤2s 内补查。
 */
const HEALTHY_INTERVAL_MS = 15_000;
const UNHEALTHY_INTERVAL_MS = 2_000;

export async function connectLoop(opts: { retryIntervalMs?: number } = {}): Promise<void> {
  const retryMs = opts.retryIntervalMs ?? UNHEALTHY_INTERVAL_MS;
  let base = getProxyBaseUrl();
  if (!base) {
    base = await resolveProxyBaseUrl();
    setProxyBaseUrl(base);
  }
  let staleCount = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    // 运行时覆盖/清除代理地址后立即切换
    const current = getProxyBaseUrl();
    if (current && current !== base) {
      base = current;
      staleCount = 0;
    } else if (!current) {
      base = await resolveProxyBaseUrl();
      setProxyBaseUrl(base);
      staleCount = 0;
    }
    // 页面不可见时跳过探活(避免后台标签/托盘最小化时持续打 /v1/health)
    if (typeof document !== 'undefined' && document.hidden) {
      await new Promise((r) => setTimeout(r, retryMs));
      continue;
    }
    const ok = await checkHealth(base);
    useConnectionStore.getState().setStatus(ok ? 'connected' : 'disconnected');
    if (!ok) {
      staleCount++;
      // 连续 3 次失败:本机地址连接失败 → 自动扫描匹配本机 combo-cli
      // (serve 默认 18236,被占用自动 +1);用户配置了非本机代理地址时
      // 保留配置(远程部署/中转场景),不做本地回退。
      if (staleCount >= 3) {
        useConnectionStore.getState().setError('agent 服务不可用,正在重试...');
        if (isLocalHostname(base)) {
          const found = await findLocalComboCli();
          if (found && found !== base) {
            setProxyBaseUrl(found);
            base = found;
          }
        } else {
          // 非本机地址(用户配置的代理/域名部署):重新解析,仍不可用则保留配置
          const fresh = await resolveProxyBaseUrl();
          if (fresh !== base) {
            setProxyBaseUrl(fresh);
            base = fresh;
          }
        }
        staleCount = 0;
      }
    } else {
      staleCount = 0;
      useConnectionStore.getState().setError(null);
    }
    // 正常连接低频探活,断连时快速重试
    await new Promise((r) => setTimeout(r, ok ? HEALTHY_INTERVAL_MS : retryMs));
  }
}
