import type { MessageVM } from '../stores/agentStore';

/** 兜底上下文窗口上限(模型信息缺失时使用,单位 token):默认 256k。 */
export const DEFAULT_CONTEXT_WINDOW = 262_144;

/**
 * 估算一段文本的 token 数:CJK 按 1 token/字,其余按 4 字符/token,
 * 非 ASCII 字符按 2 字符折算。仅在后端未上报真实 usage 时用作兜底。
 */
export function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp >= 0x4e00 && cp <= 0x9fff) {
      cjk += 1;
    } else if (cp < 0x80) {
      other += 1;
    } else {
      other += 2;
    }
  }
  return Math.ceil(other / 4) + cjk;
}

/** 估算整个会话的上下文 token 消耗(文本 + 思考 + 工具调用/结果)。 */
export function estimateSessionTokens(messages: MessageVM[]): number {
  let total = 0;
  for (const m of messages) {
    for (const p of m.parts) {
      switch (p.type) {
        case 'text':
          total += estimateTokens(p.data.text);
          break;
        case 'reasoning':
          total += estimateTokens(p.data.thinking);
          break;
        case 'tool_call':
          total += estimateTokens(p.data.input);
          break;
        case 'tool_result':
          total += estimateTokens(p.data.content);
          break;
        default:
          break;
      }
    }
  }
  return total;
}

/** 从最后一条 assistant 消息的 finish part 提取真实 usage(无则返回 null)。 */
export function getRealUsage(messages: MessageVM[]): {
  input: number;
  output: number;
  totalInput: number;
  totalOutput: number;
} | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'assistant') continue;
    for (let j = m.parts.length - 1; j >= 0; j--) {
      const p = m.parts[j];
      if (p.type === 'finish' && p.data.usage) {
        const u = p.data.usage;
        return {
          input: u.input_tokens,
          output: u.output_tokens,
          // 旧后端未上报 total 时退回最后一次调用值
          totalInput: u.total_input_tokens ?? u.input_tokens,
          totalOutput: u.total_output_tokens ?? u.output_tokens,
        };
      }
    }
  }
  return null;
}

/** 会话当前上下文消耗:优先真实 usage(每次 run 的 input 都含全部历史),
 * provider 未上报时退回本地估算。 */
export function getContextUsage(messages: MessageVM[]): number {
  const real = getRealUsage(messages);
  if (real && (real.input > 0 || real.output > 0)) {
    return real.input + real.output;
  }
  return estimateSessionTokens(messages);
}

/** 格式化 token 数:128000 → "128k",131072 → "131k",1500 → "1.5k"。 */
export function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}m`;
  if (n >= 100_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return String(Math.round(n));
}
