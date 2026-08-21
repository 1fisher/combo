import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MessageList, decideScrollBehavior, mergeToolResults } from './MessageList';
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

  it('渲染用户消息里的图片附件(blob 预览与后端相对路径)', () => {
    const withImages: MessageVM[] = [
      {
        id: 'img1',
        role: 'user',
        createdAt: 1,
        updatedAt: 1,
        streaming: false,
        parts: [
          { type: 'text', data: { text: '看这两张图' } },
          // 乐观消息:本地 blob 预览
          { type: 'image_url', data: { url: 'blob:mock-1' } },
          // 服务端落库消息:相对 API 路径(渲染时拼 proxy base 与鉴权参数)
          {
            type: 'image_url',
            data: { url: '/v1/workspaces/ws-9/files/raw?path=a%20b.png' },
          },
        ],
      },
    ];
    render(<MessageList messages={withImages} />);
    const imgs = screen.getAllByAltText('图片附件') as HTMLImageElement[];
    expect(imgs).toHaveLength(2);
    expect(imgs[0].getAttribute('src')).toBe('blob:mock-1');
    // 相对路径被解析为完整地址并附加 client_id(远程访问时还含 token)
    const src2 = imgs[1].getAttribute('src') ?? '';
    expect(src2).toContain('/v1/workspaces/ws-9/files/raw?path=a%20b.png');
    expect(src2).toContain('client_id=');
  });
});

describe('decideScrollBehavior', () => {
  const base = {
    len: 5,
    firstChanged: false,
    pinned: true,
    now: 1000,
    smoothUntil: 0,
  };
  const assistantMsg: MessageVM = {
    id: 'a1',
    role: 'assistant',
    createdAt: 2,
    updatedAt: 2,
    streaming: true,
    parts: [{ type: 'text', data: { text: 'hi' } }],
  };
  const userMsg: MessageVM = {
    id: 'u1',
    role: 'user',
    createdAt: 1,
    updatedAt: 1,
    streaming: false,
    parts: [{ type: 'text', data: { text: '你好' } }],
  };
  const toolCarrier: MessageVM = {
    id: 't1',
    role: 'user',
    createdAt: 3,
    updatedAt: 3,
    streaming: false,
    parts: [{ type: 'tool_result', data: { tool_call_id: 'tc1', name: 'bash', content: 'ok' } }],
  };

  it('ignores empty lists', () => {
    expect(decideScrollBehavior({ ...base, len: 0, last: undefined })).toBeNull();
  });

  it('smooth-scrolls on user send', () => {
    expect(decideScrollBehavior({ ...base, last: userMsg })).toEqual({
      behavior: 'smooth',
      reason: 'send',
    });
  });

  it('does not treat tool_result carriers as sends', () => {
    expect(decideScrollBehavior({ ...base, last: toolCarrier })).toEqual({
      behavior: 'auto',
    });
  });

  it('jumps to the end on session switch when idle', () => {
    expect(
      decideScrollBehavior({ ...base, firstChanged: true, pinned: false, last: assistantMsg }),
    ).toEqual({ behavior: 'auto' });
  });

  it('keeps gliding when a session switch lands inside the smooth window', () => {
    expect(
      decideScrollBehavior({
        ...base,
        firstChanged: true,
        smoothUntil: 2000,
        last: assistantMsg,
      }),
    ).toEqual({ behavior: 'smooth', reason: 'stream' });
  });

  it('keeps smooth-following appends inside the window', () => {
    expect(
      decideScrollBehavior({ ...base, smoothUntil: 2000, last: assistantMsg }),
    ).toEqual({ behavior: 'smooth', reason: 'stream' });
  });

  it('follows pinned content updates instantly', () => {
    expect(decideScrollBehavior({ ...base, last: assistantMsg })).toEqual({
      behavior: 'auto',
    });
  });

  it('leaves the reader alone when not pinned', () => {
    expect(
      decideScrollBehavior({ ...base, pinned: false, last: assistantMsg }),
    ).toBeNull();
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
