import { useConnectionStore } from '../stores/connectionStore';
import { ensureCrush } from './api';

let proxyBaseUrl = '';

export function getProxyBaseUrl(): string {
  return proxyBaseUrl;
}

export function setProxyBaseUrl(url: string): void {
  proxyBaseUrl = url.replace(/\/$/, '');
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
  return 'http://127.0.0.1:18234';
}

export async function connectLoop(opts: { intervalMs?: number } = {}): Promise<void> {
  const intervalMs = opts.intervalMs ?? 2000;
  if (!getProxyBaseUrl()) {
    setProxyBaseUrl(await resolveProxyBaseUrl());
  }
  let base = getProxyBaseUrl();
  let staleCount = 0;
  let ensureInFlight = false;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const ok = await checkHealth(base);
    useConnectionStore.getState().setStatus(ok ? 'connected' : 'disconnected');
    if (!ok) {
      staleCount++;
      // 连续 3 次失败:触发 crush 重启(后台 supervisor 也在监控,
      // 前端触发更快),同时重新解析端口(可能 proxy-ready 竞态导致用了错误端口)
      if (staleCount >= 3) {
        if (!ensureInFlight) {
          ensureInFlight = true;
          ensureCrush()
            .then((r) => {
              useConnectionStore.getState().setError(
                r.healthy ? null : 'crush 服务不可用,正在重试...'
              );
            })
            .catch(() => {
              useConnectionStore.getState().setError('crush 重启失败,正在重试...');
            })
            .finally(() => {
              ensureInFlight = false;
            });
        }
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
