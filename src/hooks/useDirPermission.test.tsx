import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useDirPermission } from './useDirPermission';
import { ApiError } from '../lib/api';

const grantDirAccessMock = vi.fn();

vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>();
  return {
    ...actual,
    grantDirAccess: (path: string) => grantDirAccessMock(path),
  };
});

function dirPermError(path: string) {
  return new ApiError(403, '需要允许后才能访问', 'dir_permission_required', path);
}

describe('useDirPermission', () => {
  beforeEach(() => {
    grantDirAccessMock.mockReset();
    grantDirAccessMock.mockResolvedValue({ ok: true, path: '' });
  });

  it('敏感目录被拦时弹窗;允许后记住授权并自动重试一次', async () => {
    const onError = vi.fn();
    const { result } = renderHook(() => useDirPermission(onError));
    const fn = vi.fn(async () => {
      if (fn.mock.calls.length === 1) throw dirPermError('/Volumes/Backup');
    });

    await act(async () => {
      await result.current.run(fn);
    });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();

    render(result.current.dialog);
    expect(screen.getByText('/Volumes/Backup')).toBeTruthy();

    await act(async () => {
      await userEvent.click(screen.getByRole('button', { name: '允许' }));
    });
    await waitFor(() => expect(fn).toHaveBeenCalledTimes(2));
    expect(grantDirAccessMock).toHaveBeenCalledWith('/Volumes/Backup');
    expect(onError).not.toHaveBeenCalled();
  });

  it('取消时不记住授权、不重试', async () => {
    const onError = vi.fn();
    const { result } = renderHook(() => useDirPermission(onError));
    const fn = vi.fn(async () => {
      throw dirPermError('/Volumes/Backup');
    });

    await act(async () => {
      await result.current.run(fn);
    });
    render(result.current.dialog);
    await act(async () => {
      await userEvent.click(screen.getByRole('button', { name: '取消' }));
    });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(grantDirAccessMock).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it('重试后仍被拦不再二次弹窗,直接报错', async () => {
    const onError = vi.fn();
    const { result } = renderHook(() => useDirPermission(onError));
    const fn = vi.fn(async () => {
      throw dirPermError('/Volumes/Backup');
    });

    await act(async () => {
      await result.current.run(fn);
    });
    render(result.current.dialog);
    await act(async () => {
      await userEvent.click(screen.getByRole('button', { name: '允许' }));
    });
    await waitFor(() => expect(fn).toHaveBeenCalledTimes(2));
    // 第二次失败不再弹窗(避免循环),走 onError
    await waitFor(() => expect(onError).toHaveBeenCalled());
  });

  it('非授权类错误直接走 onError,不弹窗', async () => {
    const onError = vi.fn();
    const { result } = renderHook(() => useDirPermission(onError));
    const fn = vi.fn(async () => {
      throw new ApiError(400, '目录不存在');
    });

    await act(async () => {
      await result.current.run(fn);
    });
    expect(onError).toHaveBeenCalledWith('目录不存在');
    const { container } = render(result.current.dialog);
    expect(container.textContent).toBe('');
  });
});
