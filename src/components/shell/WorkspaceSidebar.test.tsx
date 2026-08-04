import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WorkspaceSidebar } from './WorkspaceSidebar';
import { isTauri } from '../../lib/connection';
import { open } from '@tauri-apps/plugin-dialog';

const workspaces: { id: string; path: string; name?: string }[] = [];

vi.mock('../../lib/api', () => ({
  listWorkspaces: vi.fn(async () => [...workspaces]),
  createWorkspace: vi.fn(async (path: string) => {
    const w = { id: `w${workspaces.length + 1}`, path };
    workspaces.push(w);
    return w;
  }),
  renameWorkspace: vi.fn(async (id: string, name: string) => {
    const w = workspaces.find((x) => x.id === id);
    if (w) w.name = name;
    return w;
  }),
  listSkills: vi.fn(async () => []),
  getWorkspaceConfig: vi.fn(async () => ({ options: {} })),
  setConfigKey: vi.fn(async () => undefined),
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
  workspaces.push(
    { id: 'w1', path: '/proj/a', name: '项目A' },
    { id: 'w2', path: '/proj/b', name: '项目B' }
  );
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
  it('renders project names, not full paths', async () => {
    wrap();
    expect(await screen.findByText('项目A')).toBeTruthy();
    expect(screen.getByText('项目B')).toBeTruthy();
    expect(screen.queryByText('/proj/a')).toBeNull();
  });

  it('falls back to directory basename when name is missing', async () => {
    workspaces.length = 0;
    workspaces.push({ id: 'w9', path: '/tmp/my-repo' });
    wrap();
    expect(await screen.findByText('my-repo')).toBeTruthy();
  });

  it('renames a project inline', async () => {
    wrap();
    const row = (await screen.findByText('项目A')).closest('div')!;
    await userEvent.click(within(row).getByTitle('重命名项目'));
    const input = await screen.findByDisplayValue('项目A');
    await userEvent.clear(input);
    await userEvent.type(input, '新名字');
    await userEvent.keyboard('{Enter}');
    expect(await screen.findByText('新名字')).toBeTruthy();
  });

  it('creates a workspace from the picked directory (Tauri)', async () => {
    vi.mocked(isTauri).mockReturnValue(true);
    vi.mocked(open).mockResolvedValue('/proj/c');
    wrap();
    await userEvent.click(await screen.findByRole('button', { name: '添加项目' }));
    expect(await screen.findByText('c')).toBeTruthy();
    expect(open).toHaveBeenCalledWith({ directory: true, multiple: false });
  });

  it('adds a project via inline path input in browser mode', async () => {
    vi.mocked(isTauri).mockReturnValue(false);
    wrap();
    await userEvent.click(await screen.findByRole('button', { name: '添加项目' }));
    const input = screen.getByPlaceholderText('/path/to/project');
    await userEvent.type(input, '/proj/c');
    await userEvent.click(screen.getByRole('button', { name: '添加' }));
    expect(await screen.findByText('c')).toBeTruthy();
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
