import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { P2pTransport } from './transport';
import { setAccessToken } from '../authToken';
import { setLanUrl } from '../lanDirect';

interface FakeDc {
  readyState: string;
  send: (frame: string) => void;
  close: () => void;
  onmessage: ((ev: { data: string }) => void) | null;
  onclose: (() => void) | null;
}

function makeReadyTransport(): { t: P2pTransport; dc: FakeDc; sent: string[] } {
  const t = new P2pTransport();
  const sent: string[] = [];
  const dc: FakeDc = {
    readyState: 'open',
    send: (f) => sent.push(f),
    close: vi.fn(),
    onmessage: null,
    onclose: null,
  };
  // 注入伪 DataChannel 并标记就绪(绕过真实 WebRTC 协商)
  (t as unknown as { dc: FakeDc }).dc = dc;
  (t as unknown as { state: string }).state = 'ready';
  return { t, dc, sent };
}

/** 模拟桌面端回帧。 */
function feed(t: P2pTransport, frames: Record<string, unknown>[]): void {
  const onFrame = (t as unknown as { onFrame: (s: string) => void }).onFrame.bind(t);
  for (const f of frames) onFrame(JSON.stringify(f));
}

describe('P2pTransport', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal('window', {
      ...window,
      location: {
        ...window.location,
        origin: 'https://proxy.apesoft.cn',
        hostname: 'proxy.apesoft.cn',
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends a small request as a single req frame', async () => {
    const { t, sent } = makeReadyTransport();
    const pending = t.fetch('https://proxy.apesoft.cn/v1/health?client_id=c1', {
      method: 'GET',
      headers: { Authorization: 'Bearer tok' },
    });
    const req = JSON.parse(sent[0]);
    expect(req.t).toBe('req');
    expect(req.method).toBe('GET');
    expect(req.path).toBe('/v1/health');
    expect(req.query).toBe('client_id=c1');
    expect(req.headers.Authorization).toBe('Bearer tok');
    expect(req.body).toBeNull();
    feed(t, [
      { t: 'start', id: req.id, status: 200, headers: { 'content-type': 'application/json' } },
      { t: 'chunk', id: req.id, d: btoa('{"ok":true}') },
      { t: 'end', id: req.id },
    ]);
    const res = await pending;
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(await res.text()).toBe('{"ok":true}');
  });

  it('splits large request bodies into body frames', async () => {
    const { t, sent } = makeReadyTransport();
    const big = 'x'.repeat(20 * 1024); // 20KB > 12KB b64 上限
    const pending = t.fetch('https://proxy.apesoft.cn/v1/files/content', {
      method: 'PUT',
      body: big,
    });
    const req = JSON.parse(sent[0]);
    expect(req.t).toBe('req');
    expect(req.more).toBe(true);
    expect(req.body).toBeNull();
    const bodyFrames = sent.slice(1).map((s) => JSON.parse(s));
    expect(bodyFrames.every((f) => f.t === 'body')).toBe(true);
    expect(bodyFrames[bodyFrames.length - 1].last).toBe(true);
    // 分片重组后应等于原始内容
    const joined = bodyFrames.map((f) => atob(f.d)).join('');
    expect(joined).toBe(big);
    feed(t, [
      { t: 'start', id: req.id, status: 204, headers: {} },
      { t: 'end', id: req.id },
    ]);
    const res = await pending;
    expect(res.status).toBe(204);
  });

  it('rejects with error status on err frame', async () => {
    const { t, sent } = makeReadyTransport();
    const pending = t.fetch('/v1/health');
    const req = JSON.parse(sent[0]);
    feed(t, [{ t: 'err', id: req.id, status: 409, message: '冲突' }]);
    await expect(pending).rejects.toMatchObject({ status: 409, message: '冲突' });
  });

  it('streams SSE-style chunks incrementally', async () => {
    const { t, sent } = makeReadyTransport();
    const pending = t.fetch('/v1/workspaces/ws1/events');
    const req = JSON.parse(sent[0]);
    feed(t, [{ t: 'start', id: req.id, status: 200, headers: { 'content-type': 'text/event-stream' } }]);
    const res = await pending;
    feed(t, [
      { t: 'chunk', id: req.id, d: btoa('data: {"a":1}\n\n') },
      { t: 'chunk', id: req.id, d: btoa('data: {"b":2}\n\n') },
    ]);
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    const first = dec.decode((await reader.read()).value);
    expect(first).toBe('data: {"a":1}\n\n');
    feed(t, [{ t: 'end', id: req.id }]);
    const second = dec.decode((await reader.read()).value);
    expect(second).toBe('data: {"b":2}\n\n');
    const fin = await reader.read();
    expect(fin.done).toBe(true);
  });

  it('isReady reflects dc state and transport falls back to dead on close', () => {
    const { t, dc } = makeReadyTransport();
    expect(t.isReady()).toBe(true);
    dc.readyState = 'closed';
    expect(t.isReady()).toBe(false);
  });

  it('p2pApplicable requires token and non-local origin', async () => {
    const { p2pApplicable } = await import('./transport');
    expect(p2pApplicable()).toBe(false); // 无 token
    setAccessToken('tok');
    expect(p2pApplicable()).toBe(true);
    // 局域网直连页面(origin === lan)不启用 P2P
    vi.stubGlobal('window', {
      ...window,
      location: { ...window.location, origin: 'http://192.168.1.5:18236', hostname: '192.168.1.5' },
    });
    setLanUrl('http://192.168.1.5:18236/');
    expect(p2pApplicable()).toBe(false);
  });
});
