import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AsrStream } from './asrStream';

vi.mock('./connection', () => ({
  ensureProxyBaseUrl: async () => 'http://127.0.0.1:18236',
}));

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;

  readyState = FakeWebSocket.CONNECTING;
  binaryType = 'blob';
  url: string;
  sent: Array<string | ArrayBuffer> = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(data: string | ArrayBuffer) {
    this.sent.push(data);
  }

  close() {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  message(data: unknown) {
    this.onmessage?.({ data });
  }
}

async function openStream(
  onPartial: (text: string, finalized: string | null) => void
): Promise<{ stream: AsrStream; ws: FakeWebSocket }> {
  const pending = AsrStream.open(16000, { onPartial });
  // open 在 new WebSocket 前有一次 await(base URL 解析),等宏任务确保已构造
  await new Promise((r) => setTimeout(r, 0));
  const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  ws.open();
  const stream = await pending;
  return { stream, ws };
}

describe('AsrStream', () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('连接携带 sample_rate 参数,partial 增量回调', async () => {
    const partials: Array<[string, string | null]> = [];
    const { stream, ws } = await openStream((t, f) => partials.push([t, f]));
    expect(ws.url).toContain('/v1/transcribe/stream?sample_rate=16000');

    // 旧后端无 finalized 字段 → null;新后端带 finalized(已确认前缀)
    ws.message('{"type":"partial","text":"你"}');
    ws.message('{"type":"partial","text":"你好"}');
    ws.message('{"type":"partial","text":"你好世界","finalized":"你好"}');
    expect(partials).toEqual([
      ['你', null],
      ['你好', null],
      ['你好世界', '你好'],
    ]);

    stream.close();
  });

  it('finish 发送收尾指令并等待 final 文本', async () => {
    const { stream, ws } = await openStream(() => {});
    const finalPromise = stream.finish();
    expect(ws.sent).toContain('{"type":"finish"}');

    ws.message('{"type":"final","text":"你好世界"}');
    await expect(finalPromise).resolves.toBe('你好世界');
    stream.close();
  });

  it('服务端 error 消息使 finish 失败', async () => {
    const { stream, ws } = await openStream(() => {});
    const finalPromise = stream.finish();
    ws.message('{"type":"error","message":"语音识别模型尚未就绪"}');
    await expect(finalPromise).rejects.toThrow('语音识别模型尚未就绪');
    stream.close();
  });

  it('连接断开使 finish 失败', async () => {
    const { stream, ws } = await openStream(() => {});
    const finalPromise = stream.finish();
    ws.close();
    await expect(finalPromise).rejects.toThrow('语音识别连接已断开');
  });

  it('sendPcm 推送二进制帧,连接未打开时丢弃', async () => {
    const { stream, ws } = await openStream(() => {});
    const pcm = new Int16Array([0, 16384, -16384]);
    stream.sendPcm(pcm);
    expect(ws.sent).toHaveLength(1);
    const frame = ws.sent[0] as ArrayBuffer;
    expect(new Int16Array(frame)).toEqual(pcm);

    ws.close();
    stream.sendPcm(pcm);
    expect(ws.sent).toHaveLength(1);
  });

  it('非 JSON 与非文本帧被忽略', async () => {
    const partials: string[] = [];
    const { stream, ws } = await openStream((t) => partials.push(t));
    ws.message('not-json');
    ws.message(new ArrayBuffer(8));
    expect(partials).toEqual([]);
    stream.close();
  });
});
