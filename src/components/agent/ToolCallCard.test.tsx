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
    // 完成时显示绿色对勾,而不是 done 文字
    expect(screen.queryByText('done')).toBeNull();
    expect(document.querySelector('svg.lucide-circle-check')).toBeTruthy();
    await userEvent.click(screen.getByText(/bash/));
    expect(screen.getByText('{"cmd":"ls"}')).toBeTruthy();
  });

  it('shows gear icon while pending', () => {
    render(
      <ToolCallCard
        call={{ id: 'tc2', name: 'bash', input: '{}', finished: false }}
      />
    );
    expect(screen.getByText('⚙')).toBeTruthy();
    expect(document.querySelector('svg.lucide-circle-check')).toBeNull();
  });
});
