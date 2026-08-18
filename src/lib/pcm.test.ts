import { describe, expect, it } from 'vitest';
import { decodeBase64, pcm16ToAudioBuffer } from './pcm';

describe('decodeBase64', () => {
  it('解码为原始字节', () => {
    // 4 字节 PCM16:0x0000, 0xC040
    const bytes = decodeBase64(btoa(String.fromCharCode(0, 0, 0x40, 0xc0)));
    expect(Array.from(bytes)).toEqual([0, 0, 0x40, 0xc0]);
  });

  it('空串解码为空字节', () => {
    expect(decodeBase64('').byteLength).toBe(0);
  });
});

describe('pcm16ToAudioBuffer', () => {
  it('PCM16 字节转为 Float32 AudioBuffer(除以 32768 归一化)', () => {
    const pcm = new Int16Array([16384, -16384, 0]).buffer as ArrayBuffer;
    const created: {
      length: number;
      sampleRate: number;
      channels: Float32Array[];
    }[] = [];
    const fakeCtx = {
      createBuffer: (_ch: number, length: number, sampleRate: number) => {
        const data = new Float32Array(length);
        created.push({ length, sampleRate, channels: [data] });
        return {
          duration: length / sampleRate,
          length,
          numberOfChannels: 1,
          sampleRate,
          getChannelData: () => data,
        };
      },
    } as unknown as BaseAudioContext;
    const buf = pcm16ToAudioBuffer(fakeCtx, pcm, 22050);
    expect(buf.length).toBe(3);
    expect(buf.sampleRate).toBe(22050);
    expect(buf.getChannelData(0)[0]).toBeCloseTo(0.5, 5);
    expect(buf.getChannelData(0)[1]).toBeCloseTo(-0.5, 5);
    expect(buf.getChannelData(0)[2]).toBe(0);
    expect(created).toHaveLength(1);
  });

  it('单声道,采样数即 PCM16 采样数', () => {
    const pcm = new Int16Array(new Array(100).fill(1000)).buffer as ArrayBuffer;
    const fakeCtx = {
      createBuffer: (_ch: number, length: number, sampleRate: number) => {
        const data = new Float32Array(length);
        return {
          duration: length / sampleRate,
          length,
          numberOfChannels: 1,
          sampleRate,
          getChannelData: () => data,
        };
      },
    } as unknown as BaseAudioContext;
    const buf = pcm16ToAudioBuffer(fakeCtx, pcm, 16000);
    expect(buf.length).toBe(100);
    expect(buf.duration).toBeCloseTo(100 / 16000, 8);
  });
});
