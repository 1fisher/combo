import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WorkspaceSidebar } from './WorkspaceSidebar';
import { useAgentStore } from '../../stores/agentStore';
import { isTauri } from '../../lib/connection';
import { open } from '@tauri-apps/plugin-dialog';
import { changeWorkspacePath, createWorkspace } from '../../lib/api';

const workspaces: { id: string; path: string; name?: string }[] = [];

// 每个 workspace 的会话列表(徽章按项目求和 token 消耗;按 ws id 区分返回)
const sessionsByWs = new Map<string, unknown[]>();

vi.mock('../../lib/api', () => ({
  listWorkspaces: vi.fn(async () => [...workspaces]),
  listSessions: vi.fn(async (wsId: string) => [...(sessionsByWs.get(wsId) ?? [])]),
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
  changeWorkspacePath: vi.fn(async (id: string, path: string) => {
    const w = workspaces.find((x) => x.id === id);
    if (w) w.path = path;
    return w;
  }),
  listSkills: vi.fn(async () => []),
  getWorkspaceConfig: vi.fn(async () => ({ options: {} })),
  setConfigKey: vi.fn(async () => undefined),
  listMcpServers: vi.fn(async () => []),
  upsertMcpServer: vi.fn(async () => ({ ok: true, name: '' })),
  removeMcpServer: vi.fn(async () => ({ ok: true, name: '' })),
  testMcpServer: vi.fn(async () => ({ ok: true, tool_count: 0, tools: [] })),
  listHostDirs: vi.fn(async (path?: string) => ({
    path: path ?? '/proj',
    parent: path ? '/proj' : null,
    entries: [{ name: 'c', path: '/proj/c' }],
  })),
}));

vi.mock('../../lib/connection', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/connection')>();
  return { ...actual, isTauri: vi.fn() };
});

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
  sessionsByWs.clear();
});

function wrap() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <WorkspaceSidebar />
    </QueryClientProvider>
  );
}

/** 「项目」分区容器:项目行的文本查询都限定在此,避免与页卡旁的选中项目名混淆 */
function projSection() {
  return within(screen.getByRole('region', { name: '项目' }));
}

describe('WorkspaceSidebar', () => {
  it('renders project names, not full paths', async () => {
    wrap();
    expect(await projSection().findByText('项目A')).toBeTruthy();
    expect(projSection().getByText('项目B')).toBeTruthy();
    expect(screen.queryByText('/proj/a')).toBeNull();
  });

  it('shows the active project name beside the view tabs, following selection', async () => {
    wrap();
    // 默认自动选中第一个项目(w1=项目A):页卡右侧显示其项目名
    expect((await screen.findByTestId('active-project-name')).textContent).toBe('项目A');
    // 点击项目B 行切换选中,名字跟随变化
    await userEvent.click(projSection().getByText('项目B').closest('div')!);
    expect((await screen.findByTestId('active-project-name')).textContent).toBe('项目B');
  });

  it('shows token usage badge on each project row, summed from its sessions', async () => {
    sessionsByWs.set('w1', [
      { id: 's1', title: '任务1', prompt_tokens: 1200, completion_tokens: 300, cost: 0.012, created_at: 1 },
      { id: 's2', title: '任务2', prompt_tokens: 400, completion_tokens: 100, cost: 0.004, created_at: 2 },
    ]);
    // w2 无任何消耗 → 不渲染徽章
    wrap();
    // 项目A 徽章:1200+300+400+100 = 2000 → 2.0K,且在项目A 行内
    const badges = await screen.findAllByText('2.0K');
    expect(badges).toHaveLength(1);
    const rowA = projSection().getByText('项目A').closest('div')!;
    expect(rowA.contains(badges[0])).toBe(true);
    const rowB = projSection().getByText('项目B').closest('div')!;
    expect(rowB.textContent).not.toContain('2.0K');
  });

  it('hides project token badge when the project has no token usage', async () => {
    sessionsByWs.set('w1', [{ id: 's1', title: '空会话', prompt_tokens: 0, completion_tokens: 0, cost: 0, created_at: 1 }]);
    wrap();
    await projSection().findByText('项目A');
    const rowA = projSection().getByText('项目A').closest('div')!;
    expect(rowA.textContent).not.toMatch(/\d+(\.\d+)?[KM]/);
  });

  it('falls back to directory basename when name is missing', async () => {
    workspaces.length = 0;
    workspaces.push({ id: 'w9', path: '/tmp/my-repo' });
    wrap();
    expect(await projSection().findByText('my-repo')).toBeTruthy();
  });

  it('renames a project inline', async () => {
    wrap();
    const row = (await projSection().findByText('项目A')).closest('div')!;
    await userEvent.click(within(row).getByTitle('重命名项目'));
    const input = await screen.findByDisplayValue('项目A');
    await userEvent.clear(input);
    await userEvent.type(input, '新名字');
    await userEvent.keyboard('{Enter}');
    expect(await projSection().findByText('新名字')).toBeTruthy();
  });

  it('creates a workspace from the picked directory (Tauri)', async () => {
    vi.mocked(isTauri).mockReturnValue(true);
    vi.mocked(open).mockResolvedValue('/proj/c');
    wrap();
    await userEvent.click(await screen.findByRole('button', { name: '添加项目' }));
    expect(await screen.findByText('c')).toBeTruthy();
    expect(open).toHaveBeenCalledWith({ directory: true, multiple: false });
  });

  it('adds a project via the server directory picker in browser mode', async () => {
    vi.mocked(isTauri).mockReturnValue(false);
    wrap();
    await userEvent.click(await screen.findByRole('button', { name: '添加项目' }));
    // 目录选择器默认进入服务器浏览起点,点选子目录后确认
    await userEvent.click(await screen.findByText('c'));
    await userEvent.click(screen.getByRole('button', { name: '选择此目录' }));
    expect(createWorkspace).toHaveBeenCalledWith('/proj/c');
    expect((await screen.findAllByText('c')).length).toBeGreaterThan(0);
    expect(open).not.toHaveBeenCalled();
  });

  it('does nothing when the dialog is cancelled', async () => {
    vi.mocked(isTauri).mockReturnValue(true);
    vi.mocked(open).mockResolvedValue(null);
    wrap();
    await userEvent.click(await screen.findByRole('button', { name: '添加项目' }));
    expect(screen.queryByText('/proj/c')).toBeNull();
  });

  it('changes workspace path via context menu', async () => {
    vi.mocked(isTauri).mockReturnValue(false);
    wrap();
    // 右键项目A 打开上下文菜单
    const row = (await projSection().findByText('项目A')).closest('div')!;
    await userEvent.pointer({
      keys: '[MouseRight]',
      target: row,
    });
    await screen.findByText('更换目录');
    await userEvent.click(screen.getByText('更换目录'));
    // 弹窗里输入新路径
    const input = await screen.findByPlaceholderText('/path/to/new/project');
    await userEvent.clear(input);
    await userEvent.type(input, '/proj/new-a');
    await userEvent.click(screen.getByRole('button', { name: '更换' }));
    // 等 mutation 完成(workspaces 刷新)
    await projSection().findByText('项目A');
    expect(changeWorkspacePath).toHaveBeenCalledWith('w1', '/proj/new-a');
  });

  it('project tab shows projects only, without the task list', async () => {
    sessionsByWs.set('w1', [
      { id: 's1', title: 'A的任务', prompt_tokens: 0, completion_tokens: 0, cost: 0, created_at: 1 },
    ]);
    wrap();
    await projSection().findByText('项目A');
    expect(projSection().getByText('项目B')).toBeTruthy();
    // 「项目」视图下不再展示任务列表
    expect(screen.queryByText('A的任务')).toBeNull();
  });

  it('tasks tab shows only the active project sessions', async () => {
    sessionsByWs.set('w1', [
      { id: 's1', title: 'A的任务', prompt_tokens: 0, completion_tokens: 0, cost: 0, created_at: 1 },
    ]);
    sessionsByWs.set('w2', [
      { id: 's2', title: 'B的任务', prompt_tokens: 0, completion_tokens: 0, cost: 0, created_at: 1 },
    ]);
    wrap();
    await userEvent.click(await screen.findByRole('tab', { name: '任务' }));
    // 默认自动选中第一个项目(w1=项目A):分区标题显示项目名,只列出该项目的任务
    expect(await screen.findByRole('button', { name: '项目A' })).toBeTruthy();
    expect(await screen.findByText('A的任务')).toBeTruthy();
    expect(screen.queryByText('B的任务')).toBeNull();
  });

  it('shows a running indicator on project rows with a busy session', async () => {
    // 项目A 有任务在跑(is_busy),项目B 全空闲 → 仅项目A 行点亮标记
    sessionsByWs.set('w1', [
      { id: 's1', title: 'A的任务', prompt_tokens: 0, completion_tokens: 0, cost: 0, created_at: 1, is_busy: true },
    ]);
    sessionsByWs.set('w2', [
      { id: 's2', title: 'B的任务', prompt_tokens: 0, completion_tokens: 0, cost: 0, created_at: 1, is_busy: false },
    ]);
    useAgentStore.setState({ bySession: {} });
    wrap();
    const rowA = (await projSection().findByText('项目A')).closest('div')!;
    // 徽章数据来自 sessions 查询(异步),等标记出现
    await waitFor(() =>
      expect(rowA.querySelector('[aria-label="该项目有任务正在处理中"]')).not.toBeNull(),
    );
    const rowB = projSection().getByText('项目B').closest('div')!;
    expect(rowB.querySelector('[aria-label="该项目有任务正在处理中"]')).toBeNull();
  });
});
