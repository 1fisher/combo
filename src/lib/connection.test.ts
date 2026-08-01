import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  checkHealth,
  getProxyBaseUrl,
  setProxyBaseUrl,
} from './connection';

describe('connection helpers', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('setProxyBaseUrl strips trailing slash', () => {
    setProxyBaseUrl('http://127.0.0.1:18234/');
    expect(getProxyBaseUrl()).toBe('http://127.0.0.1:18234');
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
