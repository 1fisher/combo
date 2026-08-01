import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceEventSource } from './sse';
import type { EventEnvelope } from './payloadTypes';
import { setProxyBaseUrl } from '../connection';

const base = 'http://127.0.0.1:9999';

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
}

beforeEach(() => {
  setProxyBaseUrl(base);
  vi.stubGlobal('fetch', vi.fn());
});
afterEach(() => vi.unstubAllGlobals());

describe('WorkspaceEventSource', () => {
  it('parses events split across chunks', async () => {
    const seen: EventEnvelope[] = [];
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        streamOf(['data: {"type":"message","payload":{"id":"m1",', '"x":1}}\n\ndata: {"type":"session"}\n\n']),
        {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        }
      )
    );
    const src = new WorkspaceEventSource('w1', (env) => seen.push(env), { backoffMs: 5 });
    src.start();
    await vi.waitFor(() => expect(seen.length).toBe(2), { timeout: 2000 });
    src.stop();
    expect(seen[0].type).toBe('message');
    expect((seen[0].payload as { id: string }).id).toBe('m1');
    expect(seen[1].type).toBe('session');
  });

  it('reconnects after a network error', async () => {
    const seen: EventEnvelope[] = [];
    vi.mocked(fetch)
      .mockRejectedValueOnce(new TypeError('failed to fetch'))
      .mockResolvedValueOnce(
        new Response(streamOf(['data: {"type":"permission_request","payload":{"id":"p1"}}\n\n']), {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        })
      );
    const src = new WorkspaceEventSource('w1', (env) => seen.push(env), { backoffMs: 5 });
    src.start();
    await vi.waitFor(() => expect(seen.length).toBe(1), { timeout: 2000 });
    src.stop();
    // 首次失败后必然重连;EOF 后还会继续重连,故只断言 >= 2
    expect(fetch.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('sends client_id query param', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(streamOf([]), {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    );
    const src = new WorkspaceEventSource('w1', () => {}, { backoffMs: 5 });
    src.start();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled(), { timeout: 2000 });
    src.stop();
    const [url] = vi.mocked(fetch).mock.calls[0];
    expect(String(url)).toContain('/v1/workspaces/w1/events?client_id=');
  });
});
