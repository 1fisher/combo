import { describe, expect, it, vi } from 'vitest';
import { appendTranscript, float32ToPcm16, mergeDictationTail, playDictationChime } from './audio';

describe('float32ToPcm16', () => {
  it('正常范围内映射并 clamp 削波', () => {
    const pcm = float32ToPcm16(new Float32Array([0, 0.5, -0.5, 1, -1, 2, -2]));
    expect(pcm[0]).toBe(0);
    expect(pcm[1]).toBe(Math.round(0.5 * 0x7fff));
    expect(pcm[2]).toBe(Math.round(-0.5 * 0x8000));
    expect(pcm[3]).toBe(0x7fff);
    expect(pcm[4]).toBe(-0x8000);
    expect(pcm[5]).toBe(0x7fff);
    expect(pcm[6]).toBe(-0x8000);
  });
});

describe('appendTranscript', () => {
  it('空输入直接返回文本', () => {
    expect(appendTranscript('', ' 你好 ')).toBe('你好');
  });
  it('中文直接拼接,不补空格', () => {
    expect(appendTranscript('帮我写', '一个函数')).toBe('帮我写一个函数');
  });
  it('英文/数字边界补空格', () => {
    expect(appendTranscript('use stat', 'please')).toBe('use stat please');
    expect(appendTranscript('count is 3', 'items')).toBe('count is 3 items');
  });
  it('中英混排无空格需求', () => {
    expect(appendTranscript('调用rust', '函数')).toBe('调用rust函数');
  });
  it('空白转写不影响原输入', () => {
    expect(appendTranscript('hello', '  ')).toBe('hello');
  });
});

describe('mergeDictationTail', () => {
  it('旧后端无 finalized:整串作为推断显示', () => {
    expect(mergeDictationTail('', '你好', null)).toEqual({ confirmed: '', partial: '你好' });
    expect(mergeDictationTail('你', '你好', null)).toEqual({ confirmed: '', partial: '你好' });
  });

  it('推断增长:确认前缀稳定,新增内容进推断尾巴', () => {
    // 第一段:全部是推断
    let r = mergeDictationTail('', '今天天气很好', '');
    expect(r).toEqual({ confirmed: '', partial: '今天天气很好' });
    // 同一段继续出字:确认前缀仍为空(尚未分段固化),推断整体增长
    r = mergeDictationTail(r.confirmed + r.partial, '今天天气很好我们', '');
    expect(r).toEqual({ confirmed: '', partial: '今天天气很好我们' });
  });

  it('分段固化:推断移入确认前缀,已识别文字不消失', () => {
    // 说话中模型先推断出带幻觉尾巴的文本(推断阶段,未确认)
    let r = mergeDictationTail('', '今天天气很好吧', '');
    // 分段收尾:后端把幻觉尾巴「吧」裁剪掉,本次 text 与 finalized 一致
    r = mergeDictationTail(r.confirmed + r.partial, '今天天气很好', '今天天气很好');
    // 旧推断「吧」保留为旧推断,不整段消失
    expect(r).toEqual({ confirmed: '今天天气很好', partial: '吧' });
    // 下一段新推断到达:在分歧点就地替换「吧」
    r = mergeDictationTail(r.confirmed + r.partial, '今天天气很好我们', '今天天气很好');
    expect(r).toEqual({ confirmed: '今天天气很好', partial: '我们' });
  });

  it('收尾回缩无多余尾巴时,确认前缀直接接管', () => {
    const r = mergeDictationTail('今天天气很好', '今天天气很好', '今天天气很好');
    expect(r).toEqual({ confirmed: '今天天气很好', partial: '' });
  });

  it('确认前缀在分段间单调增长,旧推断按偏移裁剪', () => {
    // 段1 已确认「我们」
    let r = mergeDictationTail('', '我们', '我们');
    expect(r).toEqual({ confirmed: '我们', partial: '' });
    // 段2 推断「去公园」,随后段2 也固化
    r = mergeDictationTail(r.confirmed + r.partial, '我们去公园', '我们');
    expect(r).toEqual({ confirmed: '我们', partial: '去公园' });
    r = mergeDictationTail(r.confirmed + r.partial, '我们去公园', '我们去公园');
    expect(r).toEqual({ confirmed: '我们去公园', partial: '' });
  });
});

/** 最小 AudioContext 替身:记录振荡器频率与音量包络调用。 */
class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  state = 'suspended';
  currentTime = 0;
  destination = {};
  oscillators: Array<{
    type: string;
    frequency: {
      setValueAtTime: ReturnType<typeof vi.fn>;
      exponentialRampToValueAtTime: ReturnType<typeof vi.fn>;
    };
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
  }> = [];
  gains: Array<{
    gain: {
      setValueAtTime: ReturnType<typeof vi.fn>;
      linearRampToValueAtTime: ReturnType<typeof vi.fn>;
      exponentialRampToValueAtTime: ReturnType<typeof vi.fn>;
    };
  }> = [];
  resume = vi.fn();

  constructor() {
    FakeAudioContext.instances.push(this);
  }

  createOscillator() {
    const osc = {
      type: '',
      frequency: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
      connect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
    };
    this.oscillators.push(osc);
    return osc;
  }

  createGain() {
    const gain = {
      gain: {
        setValueAtTime: vi.fn(),
        linearRampToValueAtTime: vi.fn(),
        exponentialRampToValueAtTime: vi.fn(),
      },
      connect: vi.fn(),
    };
    this.gains.push(gain);
    return gain;
  }
}

describe('playDictationChime', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    FakeAudioContext.instances = [];
  });

  it('无 AudioContext 环境静默降级不抛错', () => {
    expect(() => playDictationChime('start')).not.toThrow();
    expect(() => playDictationChime('stop')).not.toThrow();
  });

  it('开启播升调气泡(620→840),关闭播降调气泡(840→620)', () => {
    vi.stubGlobal('AudioContext', FakeAudioContext);
    playDictationChime('start');
    playDictationChime('stop');
    const ctx = FakeAudioContext.instances[0];
    // 首建 resume 解锁 autoplay 策略
    expect(ctx.resume).toHaveBeenCalled();
    // 4 颗气泡:start 两颗(升调)+ stop 两颗(降调)
    expect(ctx.oscillators).toHaveLength(4);
    expect(ctx.oscillators[0].frequency.setValueAtTime.mock.calls[0][0]).toBe(620);
    expect(ctx.oscillators[1].frequency.setValueAtTime.mock.calls[0][0]).toBe(840);
    expect(ctx.oscillators[2].frequency.setValueAtTime.mock.calls[0][0]).toBe(840);
    expect(ctx.oscillators[3].frequency.setValueAtTime.mock.calls[0][0]).toBe(620);
    // 气泡感:每个音都有频率指数滑动(上滑/下滑)
    for (const osc of ctx.oscillators) {
      expect(osc.frequency.exponentialRampToValueAtTime).toHaveBeenCalled();
    }
    // start 上滑至 ~1.8 倍,stop 下滑至 ~0.62 倍
    expect(ctx.oscillators[0].frequency.exponentialRampToValueAtTime.mock.calls[0][0]).toBeCloseTo(620 * 1.8);
    expect(ctx.oscillators[2].frequency.exponentialRampToValueAtTime.mock.calls[0][0]).toBeCloseTo(840 * 0.62);
    // 音量包络:从 0 快起至 0.12 再指数衰减,防爆音
    expect(ctx.gains[0].gain.setValueAtTime.mock.calls[0][0]).toBe(0);
    expect(ctx.gains[0].gain.linearRampToValueAtTime).toHaveBeenCalled();
    expect(ctx.gains[0].gain.exponentialRampToValueAtTime).toHaveBeenCalled();
    // 每个音都调度了 start/stop
    for (const osc of ctx.oscillators) {
      expect(osc.start).toHaveBeenCalled();
      expect(osc.stop).toHaveBeenCalled();
    }
  });
});
