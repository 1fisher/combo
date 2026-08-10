import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MessageList, mergeToolResults } from './MessageList';
import type { MessageVM } from '../../stores/agentStore';

const msgs: MessageVM[] = [
  {
    id: 'm1',
    role: 'user',
    createdAt: 1,
    updatedAt: 1,
    streaming: false,
    parts: [{ type: 'text', data: { text: '帮我重构' } }],
  },
  {
    id: 'm2',
    role: 'assistant',
    createdAt: 2,
    updatedAt: 2,
    streaming: true,
    parts: [
      { type: 'reasoning', data: { thinking: '思考过程…', signature: '' } },
      { type: 'text', data: { text: '**好的**,开始。' } },
    ],
  },
];

describe('MessageList', () => {
  it('renders text parts and collapses reasoning', () => {
    render(<MessageList messages={msgs} />);
    expect(screen.getByText('帮我重构')).toBeTruthy();
    expect(screen.getByText('思考中…')).toBeTruthy();
    // react-markdown 渲染加粗(**好的** 拆成 strong + 文本节点);
    // 流式消息末尾会带 ▍ 光标
    expect(
      screen.getByText(
        (_, el) =>
          el?.tagName === 'P' && (el.textContent ?? '').includes('好的,开始。')
      )
    ).toBeTruthy();
  });
});

describe('mergeToolResults', () => {
  it('keeps messages untouched when there is nothing to merge', () => {
    expect(mergeToolResults(msgs)).toEqual(msgs);
  });

  it('merges tool_result-only user messages into the preceding assistant message', () => {
    const input: MessageVM[] = [
      {
        id: 'u1',
        role: 'user',
        createdAt: 1,
        updatedAt: 1,
        streaming: false,
        parts: [{ type: 'text', data: { text: '加个函数' } }],
      },
      {
        id: 'a1',
        role: 'assistant',
        createdAt: 2,
        updatedAt: 2,
        streaming: false,
        parts: [{ type: 'tool_call', data: { id: 'tc1', name: 'bash', input: '{}' } }],
      },
      {
        id: 't1',
        role: 'user',
        createdAt: 3,
        updatedAt: 3,
        streaming: false,
        parts: [{ type: 'tool_result', data: { tool_call_id: 'tc1', name: 'bash', content: 'ok' } }],
      },
      {
        id: 'a2',
        role: 'assistant',
        createdAt: 4,
        updatedAt: 4,
        streaming: false,
        parts: [{ type: 'text', data: { text: '完成' } }],
      },
    ];
    const result = mergeToolResults(input);
    expect(result).toHaveLength(3);
    expect(result[1].id).toBe('a1');
    expect(result[1].parts.map((p) => p.type)).toEqual([
      'tool_call',
      'tool_result',
    ]);
    expect((result[1].parts[1].data as { tool_call_id: string }).tool_call_id).toBe('tc1');
    expect(result[2].id).toBe('a2');
  });

  it('interleaves each result right after its matching tool_call', () => {
    const input: MessageVM[] = [
      {
        id: 'a1',
        role: 'assistant',
        createdAt: 2,
        updatedAt: 2,
        streaming: false,
        parts: [
          { type: 'tool_call', data: { id: 'tcA', name: 'bash', input: '{}' } },
          { type: 'tool_call', data: { id: 'tcB', name: 'bash', input: '{}' } },
        ],
      },
      {
        id: 't1',
        role: 'user',
        createdAt: 3,
        updatedAt: 3,
        streaming: false,
        parts: [{ type: 'tool_result', data: { tool_call_id: 'tcA', name: 'bash', content: 'A' } }],
      },
      {
        id: 't2',
        role: 'user',
        createdAt: 4,
        updatedAt: 4,
        streaming: false,
        parts: [{ type: 'tool_result', data: { tool_call_id: 'tcB', name: 'bash', content: 'B' } }],
      },
    ];
    const result = mergeToolResults(input);
    expect(result).toHaveLength(1);
    expect(
      result[0].parts.map((p) =>
        p.type === 'tool_result' ? (p.data as { tool_call_id: string }).tool_call_id : p.type
      )
    ).toEqual(['tool_call', 'tcA', 'tool_call', 'tcB']);
    expect((result[0].parts[1].data as { tool_call_id: string }).tool_call_id).toBe('tcA');
    expect((result[0].parts[3].data as { tool_call_id: string }).tool_call_id).toBe('tcB');
  });

  it('does not merge user messages that contain text', () => {
    const input: MessageVM[] = [
      {
        id: 'a1',
        role: 'assistant',
        createdAt: 2,
        updatedAt: 2,
        streaming: false,
        parts: [{ type: 'tool_call', data: { id: 'tc1', name: 'bash', input: '{}' } }],
      },
      {
        id: 't1',
        role: 'user',
        createdAt: 3,
        updatedAt: 3,
        streaming: false,
        parts: [
          { type: 'text', data: { text: '看一下' } },
          { type: 'tool_result', data: { tool_call_id: 'tc1', name: 'bash', content: 'ok' } },
        ],
      },
    ];
    const result = mergeToolResults(input);
    expect(result).toHaveLength(2);
    expect(result[1].id).toBe('t1');
  });
});
