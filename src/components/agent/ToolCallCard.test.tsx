import { describe, expect, it } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToolCallCard } from './ToolCallCard';
import { useAgentStore } from '../../stores/agentStore';

/** 向 store 注入一条含 tool_call 的消息,供 ToolResultBody 按 id 配对输入 */
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

afterEach(() => {
  useAgentStore.setState({ activeSessionId: null, bySession: {} });
});

describe('ToolCallCard', () => {
  it('bash 工具:命令摘要直接可见,展开以 bash 高亮渲染', async () => {
    render(
      <ToolCallCard
        call={{ id: 'tc1', name: 'bash', input: '{"cmd":"ls"}', finished: true }}
      />
    );
    expect(screen.getByText(/bash/)).toBeTruthy();
    // 完成时 bash 类工具显示终端图标,而不是 done 文字
    expect(screen.queryByText('done')).toBeNull();
    expect(document.querySelector('svg.lucide-terminal')).toBeTruthy();
    // 折叠态 summary 直接展示命令摘要($ <命令>)
    expect(document.querySelector('summary')?.textContent).toContain('$ ls');
    // 展开后以 bash 语法高亮渲染命令(BashCode),不显示原始 JSON
    await userEvent.click(screen.getByText(/bash/));
    expect(screen.queryByText('{"cmd":"ls"}')).toBeNull();
    // BashCode 完成高亮:ls 被 hljs 识别为 built_in
    expect(document.querySelector('code.language-bash .hljs-built_in')).toBeTruthy();
  });

  it('write 工具:content 按目标文件类型语法高亮展示', () => {
    render(
      <ToolCallCard
        call={{
          id: 'tc3',
          name: 'write',
          input: '{"path":"a.ts","content":"const x: number = 1;"}',
          finished: true,
        }}
      />
    );
    expect(document.querySelector('svg.lucide-file-pen-line')).toBeTruthy();
    expect(document.querySelector('code.language-bash')).toBeNull();
    // write 的文件内容按 .ts → typescript 高亮
    expect(document.querySelector('code.language-typescript .hljs-keyword')).toBeTruthy();
  });

  it('不同工具显示不同图标(read/grep/search/write 各有专属,未知回退扳手)', () => {
    const cases: Array<[string, string]> = [
      ['read', 'lucide-file-text'],
      ['write', 'lucide-file-pen-line'],
      ['replace', 'lucide-replace'],
      ['search', 'lucide-search'],
      ['grep', 'lucide-text-search'],
      ['web_search', 'lucide-globe'],
      ['current_datetime', 'lucide-clock-3'],
      ['question', 'lucide-circle-question-mark'],
      ['todo_write', 'lucide-list-todo'],
      ['compact', 'lucide-archive'],
      ['agent', 'lucide-bot'],
      ['diagnostics', 'lucide-stethoscope'],
      ['definition', 'lucide-locate-fixed'],
      ['references', 'lucide-link-2'],
      ['hover', 'lucide-message-square-text'],
      ['mcp_unknown_tool', 'lucide-wrench'],
    ];
    for (const [name, cls] of cases) {
      const { unmount } = render(
        <ToolCallCard call={{ id: 'tc-i', name, input: '{}', finished: true }} />
      );
      expect(document.querySelector(`svg.${cls}`), `${name} 应显示 ${cls}`).toBeTruthy();
      unmount();
    }
  });

  it('write 输入无 content 字段时回退 JsonView', () => {
    render(
      <ToolCallCard
        call={{
          id: 'tc4',
          name: 'write',
          input: '{"path":"a.ts"}',
          finished: true,
        }}
      />
    );
    expect(document.querySelector('code.language-typescript')).toBeNull();
    // JsonView 渲染输入 JSON 的键
    expect(screen.getByText('path')).toBeTruthy();
  });

  it('shows gear icon while pending', () => {
    render(
      <ToolCallCard
        call={{ id: 'tc2', name: 'bash', input: '{}', finished: false }}
      />
    );
    expect(screen.getByText('⚙')).toBeTruthy();
    // 运行中不显示任何工具图标(状态未知,专属图标仅在完成后展示)
    expect(document.querySelector('summary svg.lucide-terminal')).toBeNull();
  });

  it('配对 bash 结果:命令与输出合并进同一折叠卡片,状态/耗时标在摘要上', async () => {
    render(
      <ToolCallCard
        call={{ id: 'tc5', name: 'bash', input: '{"command":"echo hi"}', finished: true }}
        result={{
          tool_call_id: 'tc5',
          name: 'bash',
          content: 'hi',
          metadata: JSON.stringify({ exit_code: 0, timed_out: false, duration_ms: 15752 }),
        }}
      />
    );
    // 摘要:命令 + 人类可读耗时,对勾图标标记成功,无「终端输出」标题、无「成功」文字
    const summary = document.querySelector('summary')?.textContent ?? '';
    expect(summary).toContain('$ echo hi');
    expect(summary).toContain('15.8s');
    expect(summary).not.toContain('成功');
    expect(document.querySelector('summary .text-green-500')).toBeTruthy();
    // 展开:命令高亮 + 输出在同一卡片内
    await userEvent.click(screen.getByText(/bash/));
    expect(document.querySelector('code.language-bash')).toBeTruthy();
    // 「hi」同时出现在命令高亮与输出里(都在同一卡片内)
    expect(screen.getAllByText('hi').length).toBeGreaterThan(0);
  });

  it('配对 bash 失败:自动展开,摘要标记退出码', () => {
    render(
      <ToolCallCard
        call={{ id: 'tc6', name: 'bash', input: '{"command":"exit 7"}', finished: true }}
        result={{
          tool_call_id: 'tc6',
          name: 'bash',
          content: '',
          is_error: true,
          metadata: JSON.stringify({ exit_code: 7, timed_out: false, duration_ms: 3 }),
        }}
      />
    );
    expect(document.querySelector('details')?.getAttribute('open')).not.toBeNull();
    const summary = document.querySelector('summary')?.textContent ?? '';
    expect(summary).toContain('失败(7)');
    expect(document.querySelector('summary .text-red-500')).toBeTruthy();
  });

  it('配对 bash 超时:摘要标记超时', () => {
    render(
      <ToolCallCard
        call={{ id: 'tc7', name: 'bash', input: '{"command":"sleep 30"}', finished: true }}
        result={{
          tool_call_id: 'tc7',
          name: 'bash',
          content: '',
          is_error: true,
          metadata: JSON.stringify({ timed_out: true, duration_ms: 1000 }),
        }}
      />
    );
    const summary = document.querySelector('summary')?.textContent ?? '';
    expect(summary).toContain('超时');
    expect(document.querySelector('summary .text-amber-500')).toBeTruthy();
  });

  it('配对 write 结果:单一代码展示区(diff),不再渲染输入 JSON,摘要带成功对勾', async () => {
    seedToolCall('tw1', 'write', '{"path":"a.ts","content":"const x = 1;"}');
    render(
      <ToolCallCard
        call={{ id: 'tw1', name: 'write', input: '{"path":"a.ts","content":"const x = 1;"}', finished: true }}
        result={{ tool_call_id: 'tw1', name: 'write', content: '文件已写入' }}
      />
    );
    const summary = document.querySelector('summary')?.textContent ?? '';
    expect(summary).toContain('write');
    expect(summary).not.toContain('成功');
    expect(document.querySelector('summary .text-green-500')).toBeTruthy();
    // 展开:仅一个 diff 代码区,不再单独展示输入 JSON
    await userEvent.click(screen.getByText(/write/));
    expect(document.querySelectorAll('[class*="bg-green-500"]').length).toBeGreaterThan(0);
    expect(document.querySelector('code.language-typescript')).toBeNull();
  });

  it('配对 read 结果:文件内容按语言高亮合并进同一卡片', async () => {
    seedToolCall('tr1', 'read', '{"path":"src/main.rs"}');
    render(
      <ToolCallCard
        call={{ id: 'tr1', name: 'read', input: '{"path":"src/main.rs"}', finished: true }}
        result={{
          tool_call_id: 'tr1',
          name: 'read',
          content: ['文件: src/main.rs(1 行)', '显示第 1-1 行:', '    1 │ fn main() {}'].join('\n'),
        }}
      />
    );
    // 摘要显示读取路径,无「read 返回」结果卡标题
    const summary = document.querySelector('summary')?.textContent ?? '';
    expect(summary).toContain('src/main.rs');
    await userEvent.click(screen.getByText(/read/));
    expect(document.querySelector('code.language-rust')).toBeTruthy();
  });
});
