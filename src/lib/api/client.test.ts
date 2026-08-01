import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiRequest } from './client';
import { setProxyBaseUrl } from '../connection';

const base = 'http://127.0.0.1:9999';

beforeEach(() => {
  setProxyBaseUrl(base);
  vi.stubGlobal('fetch', vi.fn());
});
afterEach(() => vi.unstubAllGlobals());

describe('apiRequest', () => {
  it('injects client_id query param and parses json', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ id: 'w1' }), { status: 200 })
    );
    const out = await apiRequest<{ id: string }>('/v1/workspaces');
    expect(out.id).toBe('w1');
    const [url] = vi.mocked(fetch).mock.calls[0];
    expect(String(url)).toContain('client_id=');
  });

  it('throws ApiError with server message on 4xx', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ message: 'bad request' }), { status: 400 })
    );
    await expect(apiRequest('/v1/workspaces')).rejects.toMatchObject({
      status: 400,
      message: 'bad request',
    } satisfies Partial<ApiError>);
  });

  it('returns undefined for 204 responses', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 204 }));
    const out = await apiRequest<void>('/v1/workspaces');
    expect(out).toBeUndefined();
  });

  it('throws ApiError(0) on network error', async () => {
    vi.mocked(fetch).mockRejectedValue(new TypeError('failed to fetch'));
    await expect(apiRequest('/v1/workspaces')).rejects.toMatchObject({
      status: 0,
    });
  });
});
