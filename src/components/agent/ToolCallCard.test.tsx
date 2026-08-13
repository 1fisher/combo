import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToolCallCard } from './ToolCallCard';

describe('ToolCallCard', () => {
  it('renders name, status, and collapsible input', async () => {
    render(
      <ToolCallCard
        call={{ id: 'tc1', name: 'bash', input: '{"cmd":"ls"}', finished: true }}
      />
    );
    expect(screen.getByText(/bash/)).toBeTruthy();
    // 完成时显示工具图标(替代绿色对勾),而不是 done 文字
    expect(screen.queryByText('done')).toBeNull();
    expect(document.querySelector('svg.lucide-wrench')).toBeTruthy();
    // JSON 输入解析为结构化展示,不显示原始 JSON
    await userEvent.click(screen.getByText(/bash/));
    expect(screen.queryByText('{"cmd":"ls"}')).toBeNull();
    expect(screen.getByText('cmd')).toBeTruthy();
    expect(screen.getByText('ls')).toBeTruthy();
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
