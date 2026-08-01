import { useConnectionStore } from '../stores/connectionStore';

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
    const { listen } = await import('@tauri-apps/api/event');
    return await new Promise<string>((resolve) => {
      const unlistenP = listen<{ port: number }>('proxy-ready', (e) => {
        unlistenP.then((fn) => fn());
        resolve(`http://127.0.0.1:${e.payload.port}`);
      });
      // 2s 超时兜底
      setTimeout(() => resolve('http://127.0.0.1:18234'), 2000);
    });
  }
  return 'http://127.0.0.1:18234';
}

export async function connectLoop(opts: { intervalMs?: number } = {}): Promise<void> {
  const intervalMs = opts.intervalMs ?? 2000;
  if (!getProxyBaseUrl()) {
    setProxyBaseUrl(await resolveProxyBaseUrl());
  }
  const base = getProxyBaseUrl();
  // 立即先探一次,后续进入轮询
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const ok = await checkHealth(base);
    useConnectionStore.getState().setStatus(ok ? 'connected' : 'disconnected');
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
