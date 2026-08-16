import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * sfx 模块会缓存模块级 AudioContext,各用例用 vi.resetModules + 动态 import
 * 取全新模块实例,FakeAudioContext 记录每次 new 出来的实例供断言。
 */

class FakeAudioParam {
  value = 0;
  setValueAtTime = vi.fn();
  linearRampToValueAtTime = vi.fn();
  exponentialRampToValueAtTime = vi.fn();
}

class FakeAudioNode {
  connect = vi.fn();
}

class FakeGainNode extends FakeAudioNode {
  gain = new FakeAudioParam();
}

class FakeOscillatorNode extends FakeAudioNode {
  type: OscillatorType = 'sine';
  frequency = new FakeAudioParam();
  start = vi.fn();
  stop = vi.fn();
}

class FakeBufferSourceNode extends FakeAudioNode {
  buffer: unknown = null;
  start = vi.fn();
  stop = vi.fn();
}

class FakeBiquadFilterNode extends FakeAudioNode {
  type: BiquadFilterType = 'lowpass';
  frequency = new FakeAudioParam();
  Q = new FakeAudioParam();
}

const contexts: FakeAudioContext[] = [];

class FakeAudioContext {
  state: AudioContextState = 'running';
  currentTime = 0;
  destination = new FakeAudioNode();
  resume = vi.fn().mockResolvedValue(undefined);
  createGain = vi.fn(() => new FakeGainNode());
  createOscillator = vi.fn(() => new FakeOscillatorNode());
  createBufferSource = vi.fn(() => new FakeBufferSourceNode());
  createBiquadFilter = vi.fn(() => new FakeBiquadFilterNode());
  createBuffer = vi.fn(() => ({ getChannelData: () => new Float32Array(64) }));

  constructor() {
    contexts.push(this);
  }
}

/** 安装 stub 并加载全新 sfx 模块,返回 [模块, 本用例的 AudioContext] */
async function loadSfxWithStub() {
  contexts.length = 0;
  vi.stubGlobal('AudioContext', FakeAudioContext);
  vi.resetModules();
  const mod = await import('./sfx');
  return { mod, ctx: () => contexts[0] };
}

describe('sfx', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('环境不支持 AudioContext 时静默跳过,不抛错', async () => {
    vi.resetModules();
    const mod = await import('./sfx');
    expect(() => {
      mod.playComboHit(5);
      mod.playNotifyDone();
      mod.playNotifyAttention();
    }).not.toThrow();
  });

  it('playComboHit 合成气泡音(主音上滑 + 二次谐波 + 破裂瞬态),combo 越高气泡越大越饱满', async () => {
    const { mod, ctx } = await loadSfxWithStub();
    mod.playComboHit(1);
    let c = ctx();
    expect(c.createOscillator).toHaveBeenCalledTimes(2);
    expect(c.createBufferSource).toHaveBeenCalledTimes(1);
    const blip = c.createOscillator.mock.results[0].value as FakeOscillatorNode;
    expect(blip.type).toBe('sine');
    // combo=1:小气泡,起始 ~418Hz,指数上滑到 ~783Hz(气泡上浮的「啵」)
    expect(blip.frequency.setValueAtTime.mock.calls[0][0]).toBeCloseTo(418.2, 3);
    expect(blip.frequency.exponentialRampToValueAtTime.mock.calls[0][0]).toBeCloseTo(782.6, 3);
    // 二次谐波同步上滑(2 倍频),提供水润质感
    const harm = c.createOscillator.mock.results[1].value as FakeOscillatorNode;
    expect(harm.frequency.setValueAtTime.mock.calls[0][0]).toBeCloseTo(836.4, 3);
    // 破裂瞬态:白噪声过带通
    expect(c.createBiquadFilter).toHaveBeenCalledTimes(1);
    const bp = c.createBiquadFilter.mock.results[0].value as FakeBiquadFilterNode;
    expect(bp.type).toBe('bandpass');

    mod.playComboHit(100);
    c = ctx();
    const blip100 = c.createOscillator.mock.results[2].value as FakeOscillatorNode;
    // 100 连击:大气泡,起始降至 240Hz、上滑终点升至 1040Hz,更饱满
    expect(blip100.frequency.setValueAtTime).toHaveBeenCalledWith(240, 0);
    expect(blip100.frequency.exponentialRampToValueAtTime.mock.calls[0][0]).toBeCloseTo(1040, 3);
    expect(blip100.start).toHaveBeenCalled();
    expect(blip100.stop).toHaveBeenCalled();
  });

  it('playNotifyDone 是双音上行(A5 → E6)', async () => {
    const { mod, ctx } = await loadSfxWithStub();
    mod.playNotifyDone();
    const c = ctx();
    expect(c.createOscillator).toHaveBeenCalledTimes(2);
    const [a, b] = c.createOscillator.mock.results.map((r) => r.value as FakeOscillatorNode);
    expect(a.frequency.setValueAtTime).toHaveBeenCalledWith(880, 0);
    expect(b.frequency.setValueAtTime).toHaveBeenCalledWith(1318.51, 0.12);
    expect(a.start).toHaveBeenCalled();
    expect(b.start).toHaveBeenCalled();
  });

  it('playNotifyAttention 是双短音且用 triangle 波(柔和些)', async () => {
    const { mod, ctx } = await loadSfxWithStub();
    mod.playNotifyAttention();
    const c = ctx();
    expect(c.createOscillator).toHaveBeenCalledTimes(2);
    const oscs = c.createOscillator.mock.results.map((r) => r.value as FakeOscillatorNode);
    expect(oscs.map((o) => o.type)).toEqual(['triangle', 'triangle']);
    expect(oscs[0].frequency.setValueAtTime).toHaveBeenCalledWith(739.99, 0);
    expect(oscs[1].frequency.setValueAtTime).toHaveBeenCalledWith(987.77, 0.15);
  });
});
