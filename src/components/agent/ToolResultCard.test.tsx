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

describe('ToolResultCard · bash 结果去重', () => {
  it('配对 tool_call 的 bash 结果:剥离内容中的 `$ 命令` 回显,标题不再重复命令', () => {
    seedToolCall('tb1', 'bash', '{"command":"cargo test"}');
    render(
      <ToolResultCard
        result={{
          tool_call_id: 'tb1',
          name: 'bash',
          content: '$ cargo test\nrunning 1 test\n✅ 命令执行成功',
        }}
      />,
    );
    expect(document.querySelector('summary')?.textContent).toContain('终端输出');
    expect(document.querySelector('summary')?.textContent).not.toContain('$ cargo test');
    const pre = document.querySelector('pre');
    expect(pre?.textContent).toContain('running 1 test');
    expect(pre?.textContent).not.toContain('$ cargo test');
  });

  it('bash 成功:状态标记在卡片摘要上(成功),不拼进输出内容', () => {
    seedToolCall('tb2', 'bash', '{"command":"echo hi"}');
    render(
      <ToolResultCard
        result={{
          tool_call_id: 'tb2',
          name: 'bash',
          content: 'hi',
          metadata: JSON.stringify({ exit_code: 0, timed_out: false, duration_ms: 5 }),
        }}
      />,
    );
    const summary = document.querySelector('summary')?.textContent ?? '';
    expect(summary).toContain('成功');
    const pre = document.querySelector('pre');
    expect(pre?.textContent).toBe('hi');
    expect(pre?.textContent).not.toContain('命令执行成功');
  });

  it('bash 失败:摘要标记失败与退出码,is_error 置红', () => {
    seedToolCall('tb3', 'bash', '{"command":"exit 7"}');
    render(
      <ToolResultCard
        result={{
          tool_call_id: 'tb3',
          name: 'bash',
          content: '',
          is_error: true,
          metadata: JSON.stringify({ exit_code: 7, timed_out: false, duration_ms: 3 }),
        }}
      />,
    );
    const summary = document.querySelector('summary')?.textContent ?? '';
    expect(summary).toContain('失败(7)');
    expect(document.querySelector('.text-red-500')).toBeTruthy();
  });

  it('bash 超时:摘要标记超时,内容不含超时文案', () => {
    seedToolCall('tb4', 'bash', '{"command":"sleep 30"}');
    render(
      <ToolResultCard
        result={{
          tool_call_id: 'tb4',
          name: 'bash',
          content: 'partial output',
          is_error: true,
          metadata: JSON.stringify({ exit_code: null, timed_out: true, duration_ms: 1000 }),
        }}
      />,
    );
    const summary = document.querySelector('summary')?.textContent ?? '';
    expect(summary).toContain('超时');
    const pre = document.querySelector('pre');
    expect(pre?.textContent).toBe('partial output');
    expect(pre?.textContent).not.toContain('命令执行超时');
  });

  it('bash 空输出但成功:仍渲染卡片展示状态', () => {
    seedToolCall('tb5', 'bash', '{"command":"true"}');
    render(
      <ToolResultCard
        result={{
          tool_call_id: 'tb5',
          name: 'bash',
          content: '',
          metadata: JSON.stringify({ exit_code: 0, timed_out: false, duration_ms: 1 }),
        }}
      />,
    );
    const summary = document.querySelector('summary')?.textContent ?? '';
    expect(summary).toContain('成功');
    expect(document.querySelector('details')).toBeTruthy();
  });

  it('独立 shell_command(command 显式传入):保留命令摘要与命令体,输出剥离回显', () => {
    render(
      <ToolResultCard
        command="ls -la"
        result={{ tool_call_id: 'shell-0', name: 'bash', content: '$ ls -la\nfile.ts' }}
      />,
    );
    expect(document.querySelector('summary')?.textContent).toContain('$ ls -la');
    const outputPre = Array.from(document.querySelectorAll('pre')).find((p) =>
      p.textContent?.includes('file.ts'),
    );
    expect(outputPre?.textContent).toContain('file.ts');
    expect(outputPre?.textContent).not.toContain('$ ls -la');
  });
});
