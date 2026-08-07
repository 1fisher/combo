import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  checkHealth,
  clearProxyUrlOverride,
  ensureProxyBaseUrl,
  getProxyBaseUrl,
  getProxyUrlOverride,
  resolveProxyBaseUrl,
  setProxyBaseUrl,
  setProxyUrlOverride,
} from './connection';

describe('connection helpers', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('setProxyBaseUrl strips trailing slash', () => {
    setProxyBaseUrl('http://127.0.0.1:18234/');
    expect(getProxyBaseUrl()).toBe('http://127.0.0.1:18234');
  });

  it('resolveProxyBaseUrl prefers localStorage override over env/local defaults', async () => {
    localStorage.setItem('combo.proxyUrl', 'http://192.168.1.10:18234');
    expect(await resolveProxyBaseUrl()).toBe('http://192.168.1.10:18234');
  });

  it('setProxyUrlOverride persists and applies immediately', () => {
    setProxyUrlOverride('http://proxy.example:18234/');
    expect(getProxyBaseUrl()).toBe('http://proxy.example:18234');
    expect(getProxyUrlOverride()).toBe('http://proxy.example:18234');
  });

  it('clearProxyUrlOverride falls back to local default', async () => {
    setProxyUrlOverride('http://proxy.example:18234/');
    clearProxyUrlOverride();
    expect(getProxyUrlOverride()).toBeNull();
    expect(getProxyBaseUrl()).toBe('');
    // 非 Tauri、无环境变量时回退本地默认
    expect(await resolveProxyBaseUrl()).toBe('http://127.0.0.1:18234');
  });

  it('ensureProxyBaseUrl resolves and sets the base when empty', async () => {
    clearProxyUrlOverride();
    setProxyBaseUrl('');
    const url = await ensureProxyBaseUrl();
    expect(url).toBe('http://127.0.0.1:18234');
    expect(getProxyBaseUrl()).toBe('http://127.0.0.1:18234');
  });

  it('ensureProxyBaseUrl returns the current base when already set', async () => {
    setProxyBaseUrl('http://192.168.1.5:18234');
    expect(await ensureProxyBaseUrl()).toBe('http://192.168.1.5:18234');
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
});
