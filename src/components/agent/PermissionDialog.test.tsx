import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PermissionDialog } from './PermissionDialog';

describe('PermissionDialog', () => {
  it('resolves with allow', async () => {
    let action = '';
    render(
      <PermissionDialog
        permission={{
          id: 'p1',
          session_id: 's1',
          tool_call_id: 'tc1',
          tool_name: 'bash',
          description: '运行命令',
          action: 'bash',
          path: '/tmp',
        } as never}
        onResolve={(a) => (action = a)}
      />
    );
    expect(screen.getByText('运行命令')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: '允许' }));
    expect(action).toBe('allow');
  });
});
