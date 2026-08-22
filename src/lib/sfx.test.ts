import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

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
  const mod = trackMod(await import('./sfx'));
  return { mod, ctx: () => contexts[0] };
}

/** 本用例文件加载过的全部 sfx 模块实例(afterEach 统一摘除常驻监听) */
const loadedSfxMods: Array<{ disposeAudioHooksForTests: () => void }> = [];

function trackMod<T extends { disposeAudioHooksForTests: () => void }>(mod: T): T {
  loadedSfxMods.push(mod);
  return mod;
}

describe('sfx', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    loadedSfxMods.splice(0).forEach((m) => m.disposeAudioHooksForTests());
  });

  it('环境不支持 AudioContext 时静默跳过,不抛错', async () => {
    vi.resetModules();
    const mod = trackMod(await import('./sfx'));
    expect(() => {
      mod.playComboHit(5);
      mod.playNotifyDone();
      mod.playNotifyCancel();
      mod.playNotifyError();
      mod.playNotifyAttention();
    }).not.toThrow();
  });

  it('playComboHit 合成轻量气泡上升声(单振荡器快上滑),combo 越高气泡略大', async () => {
    const { mod, ctx } = await loadSfxWithStub();
    mod.playComboHit(1);
    let c = ctx();
    // 轻量版只留主音(气泡上升),不再叠加二次谐波(那是旧版「饱满/偏重」的来源)
    expect(c.createOscillator).toHaveBeenCalledTimes(1);
    const blip = c.createOscillator.mock.results[0].value as FakeOscillatorNode;
    expect(blip.type).toBe('sine');
    // combo=1:小气泡,起始 ~947Hz,指数上滑到 ~1503Hz(轻短的「啵」)
    expect(blip.frequency.setValueAtTime.mock.calls[0][0]).toBeCloseTo(947.4, 3);
    expect(blip.frequency.exponentialRampToValueAtTime.mock.calls[0][0]).toBeCloseTo(1503.4, 3);

    mod.playComboHit(100);
    c = ctx();
    const blip100 = c.createOscillator.mock.results[1].value as FakeOscillatorNode;
    // 100 连击:气泡略大,起始降至 690Hz、上滑终点 1840Hz,仍轻短
    expect(blip100.frequency.setValueAtTime).toHaveBeenCalledWith(690, 0);
    expect(blip100.frequency.exponentialRampToValueAtTime.mock.calls[0][0]).toBeCloseTo(1840, 3);
    expect(blip100.start).toHaveBeenCalled();
    expect(blip100.stop).toHaveBeenCalled();
  });

  it('playComboHit count:一次连吐多颗(2→10 涨 8 颗,0.09s 错开、音高渐变)', async () => {
    const { mod, ctx } = await loadSfxWithStub();
    mod.playComboHit(10, 8);
    const c = ctx();
    // 每颗 = 主音振荡器
    expect(c.createOscillator).toHaveBeenCalledTimes(8);
    const blips = c.createOscillator.mock.results.map((r) => r.value as FakeOscillatorNode);
    // 第 i 颗对应 combo = 10-8+1+i = 3+i:起始频率随数值渐变
    expect(blips[0].frequency.setValueAtTime.mock.calls[0][0]).toBeCloseTo(950 - 0.03 * 260, 3);
    expect(blips[7].frequency.setValueAtTime.mock.calls[0][0]).toBeCloseTo(924, 3);
    // 每颗错开 0.09s 排期,连续吐泡泡
    expect(blips[1].start).toHaveBeenCalledWith(0.09);
    expect(blips[7].start).toHaveBeenCalledWith(0.63);
  });

  it('playComboHit count 越界 clamp:至少 1 颗、至多 16 颗', async () => {
    const { mod, ctx } = await loadSfxWithStub();
    mod.playComboHit(5, 0);
    mod.playComboHit(5, 99);
    const c = ctx();
    // 0 → clamp 为 1 颗;99 → clamp 为 16 颗
    expect(c.createOscillator).toHaveBeenCalledTimes(17);
  });

  it('上下文未 running(suspended)时跳过播放:不调度,避免解锁后积压的声音迟到爆出', async () => {
    const { mod, ctx } = await loadSfxWithStub();
    // 先取用一次让上下文创建出来,再模拟系统挂起
    const created = mod.getSharedAudioContext();
    (created as unknown as { state: AudioContextState }).state = 'suspended';
    mod.playComboHit(5);
    mod.playNotifyDone();
    mod.playNotifyAttention();
    const c = ctx();
    expect(c.createOscillator).not.toHaveBeenCalled();
    expect(c.createGain).not.toHaveBeenCalled();
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

  it('playNotifyCancel 是双音下行(E6 → A5,与完成音镜像)', async () => {
    const { mod, ctx } = await loadSfxWithStub();
    mod.playNotifyCancel();
    const c = ctx();
    expect(c.createOscillator).toHaveBeenCalledTimes(2);
    const oscs = c.createOscillator.mock.results.map((r) => r.value as FakeOscillatorNode);
    expect(oscs[0].frequency.setValueAtTime).toHaveBeenCalledWith(1318.51, 0);
    expect(oscs[1].frequency.setValueAtTime).toHaveBeenCalledWith(880, 0.12);
  });

  it('playNotifyError 是低音下行四度(C5 → G4),与完成/取消区分明显', async () => {
    const { mod, ctx } = await loadSfxWithStub();
    mod.playNotifyError();
    const c = ctx();
    expect(c.createOscillator).toHaveBeenCalledTimes(2);
    const oscs = c.createOscillator.mock.results.map((r) => r.value as FakeOscillatorNode);
    expect(oscs[0].frequency.setValueAtTime).toHaveBeenCalledWith(523.25, 0);
    expect(oscs[1].frequency.setValueAtTime).toHaveBeenCalledWith(392, 0.2);
  });
});

/**
 * 共享 AudioContext 的关键行为:
 * 1. 手势解锁(常驻)—— WebKit 自动播放策略要求 AudioContext 在用户手势内
 *    启动/恢复,SSE 触发的音效(combo/任务完成)不在手势内,必须由手势内
 *    同步 resume 解锁;监听不捕除,上下文运行中被系统再挂起(隐藏到托盘/
 *    休眠唤醒/切换音频设备)后,下一个手势仍能重新解锁,否则永久无声;
 * 2. 自愈重建 —— 上下文 closed/中断卡死后,下次调用必须能拿到新实例,
 * 且被弃实例要 close 释放 WebKit 的上下文数量配额。
 * 用独立的 Fake(state 起始 suspended、resume 异步兑现翻转状态)模拟真实 WebKit。
 *
 * 注意:每个用例经 loadSfxSuspended 拿到全新模块实例,但旧模块挂在共享
 * window/document 上的常驻监听(手势/可见性)不会摘除 —— dispatch 事件时
 * 它们也会触发并创建上下文。因此 Fake 类按用例独立工厂化,instances 计数
 * 只统计本用例模块的创建,不受历史模块监听污染。
 */

type SuspendedAC = {
  state: AudioContextState;
  resume: Mock<() => Promise<void>>;
  close: Mock<() => Promise<void>>;
  createGain: Mock;
  createOscillator: Mock;
};

function makeSuspendedACClass() {
  const instances: SuspendedAC[] = [];
  class SuspendedAudioContext {
    static instances = instances;
    state: AudioContextState = 'suspended';
    // 与真实 WebKit 行为一致:状态在 promise 异步兑现时才翻转
    resume: Mock<() => Promise<void>> = vi.fn(() =>
      Promise.resolve().then(() => {
        this.state = 'running';
      })
    );
    close = vi.fn(async () => {
      this.state = 'closed';
    });
    // 供「挂起时不调度」断言用
    createGain = vi.fn();
    createOscillator = vi.fn();
    constructor() {
      instances.push(this);
    }
  }
  return SuspendedAudioContext;
}

async function loadSfxSuspended() {
  vi.resetModules();
  const AC = makeSuspendedACClass();
  vi.stubGlobal('AudioContext', AC);
  return { ...trackMod(await import('./sfx')), AC };
}

describe('sfx 共享 AudioContext', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    loadedSfxMods.splice(0).forEach((m) => m.disposeAudioHooksForTests());
  });

  it('手势解锁:手势内发起 resume;运行中常驻监听空转不重复 resume', async () => {
    const { getSharedAudioContext, AC } = await loadSfxSuspended();
    // 任意时刻取用都拿到同一实例(全应用唯一播放上下文)
    window.dispatchEvent(new Event('pointerdown'));
    const c = getSharedAudioContext();
    expect(c instanceof AC).toBe(true);
    await vi.waitFor(() => expect(c?.state).toBe('running'));
    // 运行中:后续手势与取用都不会重复 resume(监听保留但空转)
    const fake = c as unknown as SuspendedAC;
    fake.resume.mockClear();
    window.dispatchEvent(new Event('pointerdown'));
    window.dispatchEvent(new Event('keydown'));
    expect(getSharedAudioContext()).toBe(c);
    expect(fake.resume).not.toHaveBeenCalled();
  });

  it('运行中被再次挂起(隐藏到托盘/休眠唤醒):常驻手势监听在下一个手势重新解锁', async () => {
    const { getSharedAudioContext } = await loadSfxSuspended();
    window.dispatchEvent(new Event('pointerdown'));
    const c = getSharedAudioContext();
    await vi.waitFor(() => expect(c?.state).toBe('running'));
    // 系统把上下文重新挂起
    (c as unknown as { state: AudioContextState }).state = 'suspended';
    const fake = c as unknown as SuspendedAC;
    fake.resume.mockClear();
    window.dispatchEvent(new Event('keydown'));
    await vi.waitFor(() => expect(fake.resume).toHaveBeenCalled());
    await vi.waitFor(() => expect(c?.state).toBe('running'));
  });

  it('未解锁前调用也安全:suspended 时跳过本次播放,不抛错也不排队迟播', async () => {
    const { getSharedAudioContext, playNotifyDone, playComboHit } =
      await loadSfxSuspended();
    const c = getSharedAudioContext();
    expect(c?.state).toBe('suspended');
    expect(() => {
      playNotifyDone();
      playComboHit(3);
    }).not.toThrow();
    const fake = c as unknown as SuspendedAC;
    expect(fake.createGain).not.toHaveBeenCalled();
    expect(fake.createOscillator).not.toHaveBeenCalled();
  });

  it('自愈重建:上下文 closed 后丢弃缓存,下次调用拿到新实例', async () => {
    const { getSharedAudioContext, AC } = await loadSfxSuspended();
    const c1 = getSharedAudioContext();
    (c1 as unknown as { state: AudioContextState }).state = 'closed';
    const c2 = getSharedAudioContext();
    expect(c2).not.toBe(c1);
    expect(AC.instances).toHaveLength(2);
  });

  it('自愈重建:interrupted(WebKit 输出中断)同样重建,且 close 被弃实例释放配额', async () => {
    const { getSharedAudioContext, AC } = await loadSfxSuspended();
    const c1 = getSharedAudioContext() as unknown as SuspendedAC;
    // Safari 系专属状态,TS 类型未收录,按运行时字符串写入
    (c1 as unknown as { state: string }).state = 'interrupted';
    const c2 = getSharedAudioContext();
    expect(c2).not.toBe(c1);
    expect(AC.instances).toHaveLength(2);
    expect(c1.close).toHaveBeenCalled();
    // 新实例在后续手势内可正常解锁(监听常驻)
    window.dispatchEvent(new Event('pointerdown'));
    await vi.waitFor(() => expect(c2?.state).toBe('running'));
  });

  it('高龄兜底:上下文超过阈值且静默时,下一个用户手势内静默换新(假 running 自愈)', async () => {
    vi.useFakeTimers();
    try {
      const { getSharedAudioContext, AC } = await loadSfxSuspended();
      const c1 = getSharedAudioContext() as unknown as SuspendedAC;
      await vi.advanceTimersByTimeAsync(1); // resume 兑现 → running
      expect((c1 as unknown as { state: string }).state).toBe('running');
      // 静默 11 分钟(期间无任何排期)后点击:state 仍是 running,
      // 但输出管线可能已假死 —— 按高龄在手势内换新,重新绑定音频输出
      await vi.advanceTimersByTimeAsync(11 * 60_000);
      window.dispatchEvent(new Event('pointerdown'));
      expect(AC.instances).toHaveLength(2);
      expect(AC.instances[0]).toBe(c1);
      expect(c1.close).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('宽限期保护:近期排期过声音(TTS 可能在播)时推迟换新,不拦腰切断朗读', async () => {
    vi.useFakeTimers();
    try {
      const { getSharedAudioContext, playNotifyDone, AC } =
        await loadSfxSuspended();
      const c1 = getSharedAudioContext() as unknown as SuspendedAC;
      await vi.advanceTimersByTimeAsync(1);
      expect((c1 as unknown as { state: string }).state).toBe('running');
      // 涨龄到接近阈值时播一次音效(排期上报),再涨过阈值
      await vi.advanceTimersByTimeAsync(9 * 60_000 + 59_000);
      playNotifyDone(); // markAudioScheduled:lastScheduleAt ≈ t=599s
      await vi.advanceTimersByTimeAsync(6_000); // 龄 605s > 阈值,但距排期仅 6s < 宽限
      window.dispatchEvent(new Event('pointerdown'));
      expect(AC.instances).toHaveLength(1); // 不换新,不打断播放
      await vi.advanceTimersByTimeAsync(10_000); // 距排期超过宽限
      window.dispatchEvent(new Event('pointerdown'));
      expect(AC.instances).toHaveLength(2); // 此刻才静默换新
    } finally {
      vi.useRealTimers();
    }
  });

  it('窗口从隐藏恢复可见:输出路由可能已失效,标记待重建并在下一手势换新', async () => {
    const { getSharedAudioContext, AC } = await loadSfxSuspended();
    const c1 = getSharedAudioContext();
    await vi.waitFor(() => expect(c1?.state).toBe('running'));
    Object.defineProperty(document, 'visibilityState', {
      value: 'visible',
      configurable: true,
    });
    document.dispatchEvent(new Event('visibilitychange'));
    // 年轻上下文也照样标记:隐藏期间 WebKit 可能回收了输出管线而 state 不变
    window.dispatchEvent(new Event('pointerdown'));
    expect(AC.instances).toHaveLength(2);
  });

  it('resume 反复无效(suspendStreak ≥ 3):手势内判定卡死,换新上下文', async () => {
    const { getSharedAudioContext, AC } = await loadSfxSuspended();
    const c1 = getSharedAudioContext() as unknown as SuspendedAC;
    // 模拟管线卡死:resume 兑现但 state 永远不变
    c1.resume.mockImplementation(() => Promise.resolve());
    // 初始取用 streak=1;两次手势 → 3;第三次手势触发换新
    window.dispatchEvent(new Event('pointerdown'));
    window.dispatchEvent(new Event('pointerdown'));
    expect(AC.instances).toHaveLength(1);
    window.dispatchEvent(new Event('pointerdown'));
    expect(AC.instances).toHaveLength(2);
    expect(c1.close).toHaveBeenCalled();
  });
});
