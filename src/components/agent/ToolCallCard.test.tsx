import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToolCallCard } from './ToolCallCard';

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

  it('非 bash 工具:完成态仍显示扳手图标 + JsonView', () => {
    render(
      <ToolCallCard
        call={{
          id: 'tc3',
          name: 'write',
          input: '{"path":"a.ts","content":"x"}',
          finished: true,
        }}
      />
    );
    expect(document.querySelector('svg.lucide-wrench')).toBeTruthy();
    expect(document.querySelector('code.language-bash')).toBeNull();
  });

  it('shows gear icon while pending', () => {
    render(
      <ToolCallCard
        call={{ id: 'tc2', name: 'bash', input: '{}', finished: false }}
      />
    );
    expect(screen.getByText('⚙')).toBeTruthy();
    expect(document.querySelector('svg.lucide-wrench')).toBeNull();
  });
});
