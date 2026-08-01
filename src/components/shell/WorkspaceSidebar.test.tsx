import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WorkspaceSidebar } from './WorkspaceSidebar';
import { isTauri } from '../../lib/connection';
import { open } from '@tauri-apps/plugin-dialog';

const workspaces: { id: string; path: string }[] = [];

vi.mock('../../lib/api', () => ({
  listWorkspaces: vi.fn(async () => [...workspaces]),
  createWorkspace: vi.fn(async (path: string) => {
    const w = { id: `w${workspaces.length + 1}`, path };
    workspaces.push(w);
    return w;
  }),
}));

vi.mock('../../lib/connection', () => ({
  isTauri: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  workspaces.length = 0;
  workspaces.push({ id: 'w1', path: '/proj/a' }, { id: 'w2', path: '/proj/b' });
});

function wrap() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <WorkspaceSidebar />
    </QueryClientProvider>
  );
}

describe('WorkspaceSidebar', () => {
  it('renders workspaces from API', async () => {
    wrap();
    expect(await screen.findByText('/proj/a')).toBeTruthy();
    expect(screen.getByText('/proj/b')).toBeTruthy();
  });

  it('creates a workspace from the picked directory (Tauri)', async () => {
    vi.mocked(isTauri).mockReturnValue(true);
    vi.mocked(open).mockResolvedValue('/proj/c');
    wrap();
    await userEvent.click(await screen.findByRole('button', { name: '添加项目' }));
    expect(await screen.findByText('/proj/c')).toBeTruthy();
    expect(open).toHaveBeenCalledWith({ directory: true, multiple: false });
  });

  it('shows a hint in browser mode', async () => {
    vi.mocked(isTauri).mockReturnValue(false);
    wrap();
    await userEvent.click(await screen.findByRole('button', { name: '添加项目' }));
    expect(await screen.findByText('请在桌面版中选择项目目录')).toBeTruthy();
    expect(open).not.toHaveBeenCalled();
  });

  it('does nothing when the dialog is cancelled', async () => {
    vi.mocked(isTauri).mockReturnValue(true);
    vi.mocked(open).mockResolvedValue(null);
    wrap();
    await userEvent.click(await screen.findByRole('button', { name: '添加项目' }));
    expect(screen.queryByText('/proj/c')).toBeNull();
  });
});
