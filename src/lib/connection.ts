import { useConnectionStore } from '../stores/connectionStore';

let proxyBaseUrl = '';

/** 运行时代理地址覆盖(localStorage),用于前后端分离部署时指向远端 proxy。 */
const PROXY_OVERRIDE_KEY = 'combo.proxyUrl';

/** 外部访问域名(localStorage),用于域名部署时生成二维码和远程连接。 */
const EXTERNAL_URL_KEY = 'combo.externalUrl';

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
  const clean = url.trim().replace(/\/$/, '');
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

export function getProxyBaseUrl(): string {
  return proxyBaseUrl;
}

export function setProxyBaseUrl(url: string): void {
  proxyBaseUrl = url.replace(/\/$/, '');
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

/** 保存代理地址覆盖并立即生效。 */
export function setProxyUrlOverride(url: string): void {
  const clean = url.trim().replace(/\/$/, '');
  if (!clean) return;
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

export async function resolveProxyBaseUrl(): Promise<string> {
  // 运行时覆盖优先:前后端分离部署时用户可手动指向远端 proxy
  const override = getProxyUrlOverride();
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
    // 轮询 command 直到端口就绪,或事件到达
    const { listen } = await import('@tauri-apps/api/event');
    return await new Promise<string>((resolve) => {
      let resolved = false;
      const done = (url: string) => {
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
      // 轮询 command(每 500ms,持续 5s)以覆盖端口延迟就绪
      let attempts = 0;
      const poll = () => {
        if (resolved || attempts >= 10) return;
        attempts++;
        invoke<number | null>('get_proxy_port').then((p) => {
          if (p) done(`http://127.0.0.1:${p}`);
          else if (!resolved) setTimeout(poll, 500);
        }).catch(() => {
          if (!resolved) setTimeout(poll, 500);
        });
      };
      setTimeout(poll, 100);
      // 最终兜底
      setTimeout(() => done('http://127.0.0.1:18234'), 6000);
    });
  }
  // 浏览器模式:非 localhost 域名(中转/域名部署)时,使用同源地址作为代理
  if (typeof window !== 'undefined') {
    const { hostname } = window.location;
    if (hostname !== 'localhost' && hostname !== '127.0.0.1') {
      return window.location.origin;
    }
  }
  return 'http://127.0.0.1:18234';
}

export async function connectLoop(opts: { intervalMs?: number } = {}): Promise<void> {
  const intervalMs = opts.intervalMs ?? 2000;
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
    const ok = await checkHealth(base);
    useConnectionStore.getState().setStatus(ok ? 'connected' : 'disconnected');
    if (!ok) {
      staleCount++;
      // 连续 3 次失败:重新解析端口(可能 proxy-ready 竞态导致用了错误端口)
      if (staleCount >= 3) {
        useConnectionStore.getState().setError('agent 服务不可用,正在重试...');
        const fresh = await resolveProxyBaseUrl();
        if (fresh !== base) {
          setProxyBaseUrl(fresh);
          base = fresh;
        }
        staleCount = 0;
      }
    } else {
      staleCount = 0;
      useConnectionStore.getState().setError(null);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
