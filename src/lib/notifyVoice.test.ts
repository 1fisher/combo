import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  pickVoicePhrase,
  speakNotifyVoice,
  VOICE_AWAIT_ANSWER,
  VOICE_AWAIT_CONFIRM,
  VOICE_RUN_DONE,
  VOICE_RUN_ERROR,
} from './notifyVoice';
import { streamSpeech } from './api';
import { waitSpeechModelReady } from './speech';
import { getSharedAudioContext } from './sfx';

vi.mock('./api', () => {
  // 构造签名对齐真实 ApiError(status, message, code),保证测试代码同时通过类型检查
  class ApiError extends Error {
    status?: number;
    code?: string;
    constructor(status?: number, message?: string, code?: string) {
      super(message);
      this.status = status;
      this.code = code;
    }
  }
  // 默认实现:一次流式合成回一个 chunk(2 采样 PCM16)
  const streamSpeech = vi.fn(
    async (
      _text: string,
      opts: { onChunk: (pcm: ArrayBuffer, sampleRate: number, hard: boolean) => void },
    ) => {
      opts.onChunk(new Int16Array([16384, -16384]).buffer as ArrayBuffer, 22050, true);
      return 1;
    },
  );
  return { ApiError, streamSpeech };
});
vi.mock('./speech', () => ({ waitSpeechModelReady: vi.fn() }));
vi.mock('./sfx', () => ({ getSharedAudioContext: vi.fn() }));

const apiMock = vi.mocked(streamSpeech);
const waitMock = vi.mocked(waitSpeechModelReady);
const ctxMock = vi.mocked(getSharedAudioContext);

/** 排空播报队列(串行 promise 链 + 播放轮询)。 */
async function drainQueue(ms = 60): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

/** 假 AudioContext:PCM 解码用 createBuffer,播放 start() 后异步触发 onended。 */
function makeFakeCtx() {
  const started: number[] = [];
  const ctx = {
    currentTime: 10,
    state: 'running',
    destination: {},
    createBuffer: (_ch: number, length: number, sampleRate: number) => ({
      duration: length / sampleRate,
      length,
      numberOfChannels: 1,
      sampleRate,
      getChannelData: () => new Float32Array(length),
    }),
    createBufferSource: () => {
      const src: {
        buffer: unknown;
        connect: ReturnType<typeof vi.fn>;
        start: (at?: number) => void;
        stop: ReturnType<typeof vi.fn>;
        onended: (() => void) | null;
      } = {
        buffer: null,
        connect: vi.fn(),
        start: (at?: number) => {
          started.push(at ?? -1);
          setTimeout(() => src.onended?.(), 0);
        },
        stop: vi.fn(),
        onended: null,
      };
      return src;
    },
  };
  return { ctx, started };
}

describe('pickVoicePhrase', () => {
  it('随机挑选的结果一定来自池内', () => {
    for (let i = 0; i < 50; i++) {
      expect(VOICE_RUN_DONE).toContain(pickVoicePhrase(VOICE_RUN_DONE));
    }
  });

  it('空池返回空串(播报自动跳过)', () => {
    expect(pickVoicePhrase([])).toBe('');
  });

  it('四组提示语均非空且句子简短(适合语音播报)', () => {
    for (const pool of [VOICE_RUN_DONE, VOICE_RUN_ERROR, VOICE_AWAIT_CONFIRM, VOICE_AWAIT_ANSWER]) {
      expect(pool.length).toBeGreaterThanOrEqual(3);
      for (const phrase of pool) {
        expect(phrase.trim().length).toBeGreaterThan(0);
        expect(phrase.length).toBeLessThanOrEqual(40);
      }
    }
  });
});

describe('speakNotifyVoice', () => {
  beforeEach(() => {
    apiMock.mockClear();
    apiMock.mockImplementation(
      async (
        _t: string,
        opts: { onChunk: (pcm: ArrayBuffer, sr: number, hard: boolean) => void },
      ) => {
        opts.onChunk(new Int16Array([16384, -16384]).buffer as ArrayBuffer, 22050, true);
        return 1;
      },
    );
    waitMock.mockReset();
    ctxMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('环境无 AudioContext 时直接跳过,不发起合成请求', async () => {
    // jsdom 默认无 AudioContext;显式确保不存在
    vi.stubGlobal('AudioContext', undefined);
    speakNotifyVoice('任务完成啦');
    await drainQueue();
    expect(apiMock).not.toHaveBeenCalled();
  });

  it('流式合成成功后解码并无缝排期播放', async () => {
    vi.stubGlobal('AudioContext', class {});
    const { ctx, started } = makeFakeCtx();
    ctxMock.mockReturnValue(ctx as unknown as AudioContext);

    speakNotifyVoice('任务完成啦');
    await drainQueue();

    expect(apiMock).toHaveBeenCalledWith('任务完成啦', expect.objectContaining({ test: true }));
    expect(started).toHaveLength(1);
    expect(started[0]).toBeGreaterThanOrEqual(10.03);
  });

  it('空白文本不播报', async () => {
    vi.stubGlobal('AudioContext', class {});
    speakNotifyVoice('   ');
    await drainQueue();
    expect(apiMock).not.toHaveBeenCalled();
  });

  it('模型未就绪:限时等待下载后重试一次,就绪则播报', async () => {
    vi.stubGlobal('AudioContext', class {});
    const { ctx, started } = makeFakeCtx();
    ctxMock.mockReturnValue(ctx as unknown as AudioContext);
    const { ApiError } = await import('./api');
    apiMock
      .mockRejectedValueOnce(new ApiError(503, 'not ready', 'tts_not_ready'))
      .mockImplementationOnce(
        async (
          _t: string,
          opts: { onChunk: (pcm: ArrayBuffer, sr: number, hard: boolean) => void },
        ) => {
          opts.onChunk(new Int16Array([16384]).buffer as ArrayBuffer, 22050, false);
          return 1;
        },
      );
    waitMock.mockResolvedValue(undefined);

    speakNotifyVoice('需要你的确认');
    await drainQueue();

    expect(apiMock).toHaveBeenCalledTimes(2);
    expect(waitMock).toHaveBeenCalledTimes(1);
    expect(started).toHaveLength(1);
  });

  it('等待超时则放弃本次播报,不再重试', async () => {
    vi.stubGlobal('AudioContext', class {});
    const { ctx, started } = makeFakeCtx();
    ctxMock.mockReturnValue(ctx as unknown as AudioContext);
    const { ApiError } = await import('./api');
    apiMock.mockRejectedValue(new ApiError(503, 'not ready', 'tts_not_ready'));
    waitMock.mockRejectedValue(new Error('timeout'));

    speakNotifyVoice('需要你的确认');
    await drainQueue();

    expect(apiMock).toHaveBeenCalledTimes(1);
    expect(started).toHaveLength(0);
  });

  it('合成失败(非未就绪)静默跳过,不抛错', async () => {
    vi.stubGlobal('AudioContext', class {});
    const { ctx, started } = makeFakeCtx();
    ctxMock.mockReturnValue(ctx as unknown as AudioContext);
    apiMock.mockRejectedValue(new Error('network'));
    expect(() => speakNotifyVoice('任务完成啦')).not.toThrow();
    await drainQueue();
    expect(apiMock).toHaveBeenCalledTimes(1);
    expect(started).toHaveLength(0);
  });

  it('多条播报串行排队,按顺序合成播放', async () => {
    vi.stubGlobal('AudioContext', class {});
    const { ctx, started } = makeFakeCtx();
    ctxMock.mockReturnValue(ctx as unknown as AudioContext);
    const texts: string[] = [];
    apiMock.mockImplementation(
      async (
        text: string,
        opts: { onChunk: (pcm: ArrayBuffer, sr: number, hard: boolean) => void },
      ) => {
        texts.push(text);
        // 稍作延迟,验证第二条不会并发插入
        await new Promise((r) => setTimeout(r, 5));
        opts.onChunk(new Int16Array([16384, -16384]).buffer as ArrayBuffer, 22050, true);
        return 1;
      },
    );

    speakNotifyVoice('第一条');
    speakNotifyVoice('第二条');
    speakNotifyVoice('第三条');
    await drainQueue(600);

    expect(texts).toEqual(['第一条', '第二条', '第三条']);
    expect(started).toHaveLength(3);
  });

  it('一条播报内的多个片段按播放时间轴递增排期(无缝衔接)', async () => {
    vi.stubGlobal('AudioContext', class {});
    const { ctx, started } = makeFakeCtx();
    ctxMock.mockReturnValue(ctx as unknown as AudioContext);
    apiMock.mockImplementation(
      async (
        _t: string,
        opts: { onChunk: (pcm: ArrayBuffer, sr: number, hard: boolean) => void },
      ) => {
        // 两个片段:10 采样(约 0.45s @22050)+ 6 采样
        opts.onChunk(new Int16Array(new Array(10).fill(16000)).buffer as ArrayBuffer, 22050, true);
        opts.onChunk(new Int16Array(new Array(6).fill(-16000)).buffer as ArrayBuffer, 22050, false);
        return 2;
      },
    );

    speakNotifyVoice('任务完成啦,快回来。');
    await drainQueue(300);

    expect(started).toHaveLength(2);
    // 第二段排期起点 = 第一段起点 + 第一段时长 + 硬边界间隙
    const firstDur = 10 / 22050;
    expect(started[1]).toBeCloseTo(started[0]! + firstDur + 0.26, 5);
  });
});
