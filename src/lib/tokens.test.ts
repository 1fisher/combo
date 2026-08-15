import { describe, expect, it } from 'vitest';
import type { MessageVM } from '../stores/agentStore';
import {
  DEFAULT_CONTEXT_WINDOW,
  estimateSessionTokens,
  estimateTokens,
  formatTokenCount,
  getContextUsage,
  getRealUsage,
} from './tokens';

function msg(partial: Partial<MessageVM>): MessageVM {
  return {
    id: 'm1',
    role: 'assistant',
    parts: [],
    createdAt: 1,
    updatedAt: 1,
    streaming: false,
    ...partial,
  };
}

describe('estimateTokens', () => {
  it('CJK 按 1 token/字,ASCII 按 4 字符/token', () => {
    // 20 个中文字 → 20;40 个 ASCII 字符 → 10
    expect(estimateTokens('你好世界你好世界你好世界你好世界你好世界')).toBe(20);
    expect(estimateTokens('a'.repeat(40))).toBe(10);
    expect(estimateTokens('')).toBe(0);
  });
});

describe('formatTokenCount', () => {
  it('格式化千/百万级 token 数', () => {
    expect(formatTokenCount(0)).toBe('0');
    expect(formatTokenCount(999)).toBe('999');
    expect(formatTokenCount(128000)).toBe('128k');
    expect(formatTokenCount(131072)).toBe('131k');
    expect(formatTokenCount(2000000)).toBe('2m');
  });
});

describe('getRealUsage / getContextUsage', () => {
  const withFinish = (
    usage?: {
      input_tokens: number;
      output_tokens: number;
      total_input_tokens?: number;
      total_output_tokens?: number;
    },
  ): MessageVM =>
    msg({
      role: 'assistant',
      parts: [
        { type: 'text', data: { text: '你好' } },
        { type: 'finish', data: { reason: 'end_turn', usage } },
      ],
    });

  it('从最后一条 assistant 消息的 finish part 提取 usage', () => {
    const messages = [
      msg({ role: 'user', parts: [{ type: 'text', data: { text: 'hi' } }] }),
      withFinish({ input_tokens: 100, output_tokens: 30 }),
    ];
    // 旧后端未上报 total 时,退回最后一次调用值
    expect(getRealUsage(messages)).toEqual({
      input: 100,
      output: 30,
      totalInput: 100,
      totalOutput: 30,
    });
    expect(getContextUsage(messages)).toBe(130);
  });

  it('新后端上报 total_*(run 内全部调用累计)时透传', () => {
    const messages = [
      withFinish({
        input_tokens: 900,
        output_tokens: 50,
        total_input_tokens: 3000,
        total_output_tokens: 120,
      }),
    ];
    const u = getRealUsage(messages);
    expect(u).not.toBeNull();
    expect(u!.totalInput).toBe(3000);
    expect(u!.totalOutput).toBe(120);
    // 上下文占用仍取最后一次调用(input 含全部历史)
    expect(getContextUsage(messages)).toBe(950);
  });

  it('finish 无 usage 时退回估算', () => {
    const messages = [withFinish(undefined)];
    expect(getRealUsage(messages)).toBeNull();
    // "你好" = 2 token 估算
    expect(getContextUsage(messages)).toBe(estimateSessionTokens(messages));
  });

  it('无 finish part 时返回 null 并退回估算', () => {
    const messages = [msg({ role: 'user', parts: [{ type: 'text', data: { text: 'hi' } }] })];
    expect(getRealUsage(messages)).toBeNull();
    expect(getContextUsage(messages)).toBe(estimateTokens('hi'));
  });

  it('空会话用量为 0', () => {
    expect(getContextUsage([])).toBe(0);
  });

  it('DEFAULT_CONTEXT_WINDOW 兜底存在', () => {
    expect(DEFAULT_CONTEXT_WINDOW).toBeGreaterThan(0);
  });
});
