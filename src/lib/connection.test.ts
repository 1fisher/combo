import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  checkHealth,
  clearProxyUrlOverride,
  ensureProxyBaseUrl,
  findLocalComboCli,
  getProxyBaseUrl,
  getProxyUrlOverride,
  isLocalHostname,
  resolveProxyBaseUrl,
  setProxyBaseUrl,
  setProxyUrlOverride,
} from './connection';

/** 本机默认端口:serve 被占用自动 +1,前端从该端口起扫描。 */
const DEFAULT = 'http://127.0.0.1:18236';

/** 未配置任何代理时,扫描本机端口;stub fetch 全部拒绝以模拟本机无 serve。 */
function stubNoBackend() {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connection refused')));
}

describe('connection helpers', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('setProxyBaseUrl strips trailing slash', () => {
    setProxyBaseUrl(`${DEFAULT}/`);
    expect(getProxyBaseUrl()).toBe(DEFAULT);
  });

  it('resolveProxyBaseUrl prefers localStorage override over env/local defaults', async () => {
    localStorage.setItem('combo.proxyUrl', 'http://192.168.1.10:18236');
    expect(await resolveProxyBaseUrl()).toBe('http://192.168.1.10:18236');
  });

  it('setProxyUrlOverride persists and applies immediately', () => {
    setProxyUrlOverride('http://proxy.example:18236/');
    expect(getProxyBaseUrl()).toBe('http://proxy.example:18236');
    expect(getProxyUrlOverride()).toBe('http://proxy.example:18236');
  });

  it('clearProxyUrlOverride falls back to local default', async () => {
    setProxyUrlOverride('http://proxy.example:18236/');
    clearProxyUrlOverride();
    expect(getProxyUrlOverride()).toBeNull();
    expect(getProxyBaseUrl()).toBe('');
    // 非 Tauri、无环境变量、本机无 serve 时回退本地默认端口
    stubNoBackend();
    expect(await resolveProxyBaseUrl()).toBe(DEFAULT);
  });

  it('ensureProxyBaseUrl resolves and sets the base when empty', async () => {
    clearProxyUrlOverride();
    setProxyBaseUrl('');
    stubNoBackend();
    const url = await ensureProxyBaseUrl();
    expect(url).toBe(DEFAULT);
    expect(getProxyBaseUrl()).toBe(DEFAULT);
  });

  it('ensureProxyBaseUrl returns the current base when already set', async () => {
    setProxyBaseUrl('http://192.168.1.5:18236');
    expect(await ensureProxyBaseUrl()).toBe('http://192.168.1.5:18236');
  });

  it('checkHealth returns true on 200', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true } as Response),
    );
    expect(await checkHealth('http://127.0.0.1:1')).toBe(true);
  });

  it('checkHealth returns false on 500', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false } as Response),
    );
    expect(await checkHealth('http://127.0.0.1:1')).toBe(false);
  });

  it('checkHealth returns false on network error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('boom')));
    expect(await checkHealth('http://127.0.0.1:1')).toBe(false);
  });

  it('isLocalHostname 识别回环/本机域名', () => {
    expect(isLocalHostname('http://127.0.0.1:18236')).toBe(true);
    expect(isLocalHostname('http://localhost:18236')).toBe(true);
    expect(isLocalHostname('http://[::1]:18236')).toBe(true);
    expect(isLocalHostname('http://10.0.0.5:18236')).toBe(false);
    expect(isLocalHostname('https://combo.example.com')).toBe(false);
  });

  it('findLocalComboCli 返回第一个健康的本机端口(自动匹配被占用后 +1 的实例)', async () => {
    // 18236 被占 → serve 自动递增到 18237,扫描应匹配到它
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) =>
        Promise.resolve({ ok: url.includes(':18237') } as Response),
      ),
    );
    expect(await findLocalComboCli()).toBe('http://127.0.0.1:18237');
  });

  it('findLocalComboCli 本机无 serve 时返回 null', async () => {
    stubNoBackend();
    expect(await findLocalComboCli()).toBeNull();
  });
});
