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
    expect(screen.getByText('done')).toBeTruthy();
    await userEvent.click(screen.getByText(/bash/));
    expect(screen.getByText('{"cmd":"ls"}')).toBeTruthy();
  });
});
