import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { GraphView } from './GraphView';
import * as api from '../../lib/api';
import type { Api } from '../../lib/api/types';

/** 构造一个小型图谱 fixture。 */
function fixture(): Api.WorkspaceGraph {
  return {
    nodes: [
      {
        id: 'src/a.ts',
        name: 'a.ts',
        dir: 'src',
        lang: 'ts',
        defs: 2,
        loc: 30,
        out: 2,
        in: 0,
        external: ['react'],
      },
      {
        id: 'src/b.ts',
        name: 'b.ts',
        dir: 'src',
        lang: 'ts',
        defs: 1,
        loc: 10,
        out: 0,
        in: 1,
        external: [],
      },
      {
        id: 'lib/c.py',
        name: 'c.py',
        dir: 'lib',
        lang: 'py',
        defs: 1,
        loc: 5,
        out: 0,
        in: 1,
        external: [],
      },
    ],
    edges: [
      { source: 'src/a.ts', target: 'src/b.ts' },
      { source: 'src/a.ts', target: 'lib/c.py' },
    ],
    stats: {
      files: 3,
      edges: 2,
      total_loc: 45,
      langs: { ts: 2, py: 1 },
      external: [{ name: 'react', count: 1 }],
      truncated: false,
    },
    generated_at: 1_700_000_000,
  };
}

vi.mock('../../lib/api', () => ({
  getWorkspaceGraph: vi.fn(),
  getFileContent: vi.fn(),
}));

function withQuery(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

describe('GraphView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it('未选择项目时显示空态提示', () => {
    withQuery(<GraphView workspaceId={null} />);
    expect(screen.getByText('先选择一个项目')).toBeTruthy();
    expect(screen.getByText('知识图谱')).toBeTruthy();
    // 不应触发扫描
    expect(api.getWorkspaceGraph).not.toHaveBeenCalled();
  });

  it('有数据时展示统计、目录过滤与外部依赖', async () => {
    vi.mocked(api.getWorkspaceGraph).mockResolvedValue(fixture());
    withQuery(<GraphView workspaceId="ws-1" />);
    // 页头
    expect(await screen.findByText('知识图谱')).toBeTruthy();
    // 统计
    expect(await screen.findByText('3 个文件')).toBeTruthy();
    expect(screen.getByText('2 条依赖')).toBeTruthy();
    // 目录过滤 chips
    expect(screen.getByRole('button', { name: /全部目录/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /src/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /lib/ })).toBeTruthy();
    // 语言图例
    expect(screen.getByText(/TypeScript 2/)).toBeTruthy();
    expect(screen.getByText(/Python 1/)).toBeTruthy();
    // 外部依赖
    expect(screen.getByText('外部依赖 Top 1')).toBeTruthy();
    expect(api.getWorkspaceGraph).toHaveBeenCalledWith('ws-1');
  });

  it('空图谱时显示未发现代码文件空态', async () => {
    vi.mocked(api.getWorkspaceGraph).mockResolvedValue({
      nodes: [],
      edges: [],
      stats: {
        files: 0,
        edges: 0,
        total_loc: 0,
        langs: {},
        external: [],
        truncated: false,
      },
      generated_at: 1_700_000_000,
    });
    withQuery(<GraphView workspaceId="ws-1" />);
    expect(await screen.findByText('未发现代码文件')).toBeTruthy();
  });
});
