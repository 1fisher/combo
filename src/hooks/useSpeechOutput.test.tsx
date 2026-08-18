import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

// --- mock 网络与音频 ---
// 注意:实现必须走 vi.fn(impl) 构造器传入。测试基建(test-setup.ts 的
// beforeEach 里 vi.restoreAllMocks())会清掉后续 mockImplementation() 设置
// 的实现,而构造器传入的实现不会被清除。
const fetchMock = vi.fn(async (url: string) => {
  if (url.includes('/v1/speech/status')) {
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({ enabled: true, ready: false, phase: 'not_ready', model: 'piper-zh-xiaoya' }),
    };
  }
  if (url.includes('/v1/speech?')) {
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => new ArrayBuffer(44 + 8),
    };
  }
  throw new Error(`unexpected url ${url}`);
});
vi.stubGlobal('fetch', fetchMock);

class FakeAudioContext {
  state = 'running';
  destination = {};
  async decodeAudioData(_buf: ArrayBuffer): Promise<AudioBuffer> {
    return { duration: 0, length: 0, numberOfChannels: 1, sampleRate: 22050 } as AudioBuffer;
  }
  createBufferSource() {
    // start() 后异步触发 onended,模拟真实播放结束(否则朗读队列永远卡在第一句)
    const src: {
      buffer: AudioBuffer | null;
      connect: ReturnType<typeof vi.fn>;
      start: ReturnType<typeof vi.fn>;
      stop: ReturnType<typeof vi.fn>;
      onended: (() => void) | null;
    } = {
      buffer: null,
      connect: vi.fn(),
      start: vi.fn(() => {
        setTimeout(() => src.onended?.(), 0);
      }),
      stop: vi.fn(),
      onended: null,
    };
    return src;
  }
  resume() {
    return Promise.resolve();
  }
  close() {
    return Promise.resolve();
  }
}
vi.stubGlobal('AudioContext', FakeAudioContext);

// --- mock agentStore(独立状态,避免真实持久化干扰) ---
const { useAgentStore } = await import('../stores/agentStore');

function makeWrapper() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
  };
}

beforeEach(() => {
  fetchMock.mockClear();
  useAgentStore.getState().setActiveWorkspace('ws1');
  useAgentStore.getState().setActiveSessionId('s1');
});

describe('useSpeechOutput', () => {
  it('assistant 文本增量按句合成,不重复合成已消费前缀', async () => {
    const { useSpeechOutput } = await import('./useSpeechOutput');
    renderHook(() => useSpeechOutput(), { wrapper: makeWrapper() });
    // 先进入 running(仅朗读本次运行的增量,历史消息不读)
    useAgentStore.getState().setActiveSessionId('s1');
    useAgentStore.getState().markRun('s1', 'r1', 'running');
    // 第一段增量
    useAgentStore
      .getState()
      .upsertMessage('s1', {
        id: 'm1',
        role: 'assistant',
        session_id: 's1',
        model: 'm',
        provider: 'p',
        created_at: 1,
        updated_at: 1,
        parts: [{ type: 'text', data: { text: '你好。世界' } }],
      });
    await waitFor(() => {
      const calls = fetchMock.mock.calls.filter((c) =>
        String(c[0]).includes('/v1/speech?')
      ) as unknown as [string, { body: string }][];
      expect(calls.length).toBe(1);
      expect(JSON.parse(calls[0][1].body).text).toBe('你好。');
    });
    // 增量补全第二句(不重读 你好。)
    useAgentStore
      .getState()
      .upsertMessage('s1', {
        id: 'm1',
        role: 'assistant',
        session_id: 's1',
        model: 'm',
        provider: 'p',
        created_at: 1,
        updated_at: 2,
        parts: [{ type: 'text', data: { text: '你好。世界真大。' } }],
      });
    await waitFor(() => {
      const calls = fetchMock.mock.calls.filter((c) =>
        String(c[0]).includes('/v1/speech?')
      ) as unknown as [string, { body: string }][];
      expect(calls.length).toBe(2);
      expect(JSON.parse(calls[1][1].body).text).toBe('世界真大。');
    });
  });
});
