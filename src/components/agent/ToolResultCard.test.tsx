import { afterEach, describe, expect, it } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { useAgentStore } from '../../stores/agentStore';
import { ToolResultCard } from './ToolResultCard';

function seedToolCall(id: string, name: string, input: string) {
  act(() => {
    useAgentStore.setState({
      activeSessionId: 's1',
      bySession: {
        s1: {
          messages: [
            {
              id: 'm1',
              role: 'assistant',
              createdAt: 1,
              updatedAt: 1,
              streaming: false,
              parts: [{ type: 'tool_call', data: { id, name, input } }],
            },
          ],
          run: null,
          queued: false,
        },
      },
    });
  });
}

const RUST_READ = [
  '文件: src/main.rs(3 行)',
  '显示第 1-3 行:',
  '    1 │ fn main() {',
  '    2 │     println!("hi");',
  '    3 │ }',
].join('\n');

afterEach(() => {
  useAgentStore.setState({ activeSessionId: null, bySession: {} });
});

describe('ToolResultCard · read 结果语法高亮', () => {
  it('read 返回代码:标题显示路径,按扩展名以对应语言高亮并带行号', () => {
    seedToolCall('tc1', 'read', '{"path":"src/main.rs"}');
    render(
      <ToolResultCard result={{ tool_call_id: 'tc1', name: 'read', content: RUST_READ }} />,
    );
    expect(document.querySelector('summary')?.textContent).toContain('读取 src/main.rs');
    // rust 语法高亮生效(fn → hljs-keyword),行号列渲染
    expect(document.querySelector('code.language-rust .hljs-keyword')).toBeTruthy();
    const pres = document.querySelectorAll('pre');
    expect(pres[0].textContent).toBe('1\n2\n3');
    // 行号前缀已剥离,正文不再出现 │ 分隔符
    expect(document.querySelector('code.language-rust')?.textContent).not.toContain('│');
  });

  it('语言展示名与行范围显示在标签栏', () => {
    seedToolCall('tc2', 'read', '{"path":"app.py"}');
    const pyContent = [
      '文件: app.py(2 行)',
      '显示第 1-2 行:',
      '    1 │ def run():',
      '    2 │     pass',
    ].join('\n');
    render(
      <ToolResultCard result={{ tool_call_id: 'tc2', name: 'read', content: pyContent }} />,
    );
    expect(screen.getByText('Python')).toBeTruthy();
    expect(screen.getByText('第 1-2 行 / 共 2 行')).toBeTruthy();
  });

  it('翻页提示 footer 展示在代码块下方', () => {
    seedToolCall('tc3', 'read', '{"path":"a.go"}');
    const goContent = [
      '文件: a.go(200 行)',
      '显示第 1-2 行:',
      '    1 │ package main',
      '    2 │ ',
      '',
      '(共 200 行,使用 offset=2 继续读取)',
    ].join('\n');
    render(
      <ToolResultCard result={{ tool_call_id: 'tc3', name: 'read', content: goContent }} />,
    );
    expect(screen.getByText(/使用 offset=2 继续读取/)).toBeTruthy();
    expect(document.querySelector('code.language-go .hljs-keyword')).toBeTruthy();
  });

  it('未知扩展名:仍解析行号但不做语法高亮(纯文本 code)', () => {
    seedToolCall('tc4', 'read', '{"path":"data.unknownext"}');
    render(
      <ToolResultCard result={{ tool_call_id: 'tc4', name: 'read', content: RUST_READ }} />,
    );
    expect(document.querySelector('code.language-rust')).toBeNull();
    expect(document.querySelector('code.hljs')?.textContent).toContain('fn main()');
  });

  it('read 错误输出(非分页格式)回退纯文本渲染', () => {
    seedToolCall('tc5', 'read', '{"path":"missing.rs"}');
    render(
      <ToolResultCard
        result={{ tool_call_id: 'tc5', name: 'read', content: '文件不存在: missing.rs' }}
      />,
    );
    expect(screen.getByText(/文件不存在: missing\.rs/)).toBeTruthy();
    expect(document.querySelector('code.language-rust')).toBeNull();
  });

  it('JSON 内容(非 read 工具)仍走 JsonView', () => {
    seedToolCall('tc6', 'search', '{"q":"x"}');
    render(
      <ToolResultCard
        result={{ tool_call_id: 'tc6', name: 'search', content: '{"ok":true}' }}
      />,
    );
    expect(screen.getByText(/ok/)).toBeTruthy();
  });
});
