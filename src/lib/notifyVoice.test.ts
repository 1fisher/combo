import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  pickVoicePhrase,
  speakNotifyVoice,
  VOICE_AWAIT_ANSWER,
  VOICE_AWAIT_CONFIRM,
  VOICE_RUN_DONE,
  VOICE_RUN_ERROR,
} from './notifyVoice';
import { synthesizeSpeechTest } from './api';
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
  return { ApiError, synthesizeSpeechTest: vi.fn() };
});
vi.mock('./speech', () => ({ waitSpeechModelReady: vi.fn() }));
vi.mock('./sfx', () => ({ getSharedAudioContext: vi.fn() }));

const apiMock = vi.mocked(synthesizeSpeechTest);
const waitMock = vi.mocked(waitSpeechModelReady);
const ctxMock = vi.mocked(getSharedAudioContext);

/** 排空播报队列(串行 promise 链 + 微任务)。 */
async function drainQueue(ms = 20): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

/** 假 AudioBufferSourceNode:start 时同步触发 onended,播放立即完成。 */
function makeFakeCtx() {
  const started: string[] = [];
  const ctx = {
    decodeAudioData: vi.fn(async () => ({ fake: 'buffer' })),
    createBufferSource: () => ({
      buffer: null,
      connect: vi.fn(),
      start() {
        started.push('start');
        this.onended?.();
      },
      onended: null as (() => void) | null,
    }),
    destination: {},
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
    apiMock.mockReset();
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

  it('合成成功后解码并顺序播放', async () => {
    vi.stubGlobal('AudioContext', class {});
    const { ctx, started } = makeFakeCtx();
    ctxMock.mockReturnValue(ctx as unknown as AudioContext);
    apiMock.mockResolvedValue(new ArrayBuffer(8) as ArrayBuffer);

    speakNotifyVoice('任务完成啦');
    await drainQueue();

    expect(apiMock).toHaveBeenCalledWith('任务完成啦');
    expect(ctx.decodeAudioData).toHaveBeenCalledTimes(1);
    expect(started).toHaveLength(1);
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
      .mockResolvedValueOnce(new ArrayBuffer(8) as ArrayBuffer);
    waitMock.mockResolvedValue(undefined);

    speakNotifyVoice('需要你的确认');
    await drainQueue();

    expect(apiMock).toHaveBeenCalledTimes(2);
    expect(waitMock).toHaveBeenCalledTimes(1);
    expect(started).toHaveLength(1);
  });

  it('等待超时则放弃本次播报,不再重试', async () => {
    vi.stubGlobal('AudioContext', class {});
    const { ApiError } = await import('./api');
    apiMock.mockRejectedValue(new ApiError(503, 'not ready', 'tts_not_ready'));
    waitMock.mockRejectedValue(new Error('timeout'));

    speakNotifyVoice('需要你的确认');
    await drainQueue();

    expect(apiMock).toHaveBeenCalledTimes(1);
    expect(ctxMock).not.toHaveBeenCalled();
  });

  it('合成失败(非未就绪)静默跳过,不抛错', async () => {
    vi.stubGlobal('AudioContext', class {});
    apiMock.mockRejectedValue(new Error('network'));
    expect(() => speakNotifyVoice('任务完成啦')).not.toThrow();
    await drainQueue();
    expect(apiMock).toHaveBeenCalledTimes(1);
  });

  it('多条播报串行排队,按顺序播放', async () => {
    vi.stubGlobal('AudioContext', class {});
    const { ctx, started } = makeFakeCtx();
    ctxMock.mockReturnValue(ctx as unknown as AudioContext);
    const texts: string[] = [];
    apiMock.mockImplementation(async (text: string) => {
      texts.push(text);
      // 稍作延迟,验证第二条不会并发插入
      await new Promise((r) => setTimeout(r, 5));
      return new ArrayBuffer(8) as ArrayBuffer;
    });

    speakNotifyVoice('第一条');
    speakNotifyVoice('第二条');
    speakNotifyVoice('第三条');
    await drainQueue(60);

    expect(texts).toEqual(['第一条', '第二条', '第三条']);
    expect(started).toHaveLength(3);
  });
});
