import { describe, expect, it } from 'vitest';
import { appendTranscript, float32ToPcm16 } from './audio';

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
