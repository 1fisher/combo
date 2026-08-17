import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DirPermissionDialog } from './DirPermissionDialog';

describe('DirPermissionDialog', () => {
  it('path 为 null 时不渲染内容', () => {
    render(
      <DirPermissionDialog path={null} busy={false} onResolve={vi.fn()} />
    );
    expect(screen.queryByText('允许访问该目录?')).toBeNull();
  });

  it('展示待授权路径,取消/允许分别回调 false/true', async () => {
    const onResolve = vi.fn();
    render(
      <DirPermissionDialog
        path="/Volumes/Backup"
        busy={false}
        onResolve={onResolve}
      />
    );
    expect(screen.getByText('/Volumes/Backup')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(onResolve).toHaveBeenCalledWith(false);
    await userEvent.click(screen.getByRole('button', { name: '允许' }));
    expect(onResolve).toHaveBeenCalledWith(true);
  });

  it('busy 时按钮禁用', () => {
    render(
      <DirPermissionDialog path="/Volumes/Backup" busy={true} onResolve={vi.fn()} />
    );
    expect(
      (screen.getByRole('button', { name: '授权中…' }) as HTMLButtonElement).disabled
    ).toBe(true);
  });
});
