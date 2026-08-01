import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MessageList } from './MessageList';
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
    // react-markdown 渲染加粗(**好的** 拆成 strong + 文本节点)
    expect(
      screen.getByText(
        (_, el) => el?.tagName === 'P' && el.textContent === '好的,开始。'
      )
    ).toBeTruthy();
  });
});
