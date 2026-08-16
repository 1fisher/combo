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
    expect(document.querySelector('svg.lucide-wrench')).toBeTruthy();
    expect(document.querySelector('code.language-bash')).toBeNull();
    // write 的文件内容按 .ts → typescript 高亮
    expect(document.querySelector('code.language-typescript .hljs-keyword')).toBeTruthy();
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
    expect(document.querySelector('svg.lucide-wrench')).toBeNull();
  });
});
