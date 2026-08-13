import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FileExplorer } from './FileExplorer';

vi.mock('../../lib/api', () => {
  const allEntries = [
    { name: 'src', path: 'src', type: 'dir' as const, size: 0 },
    { name: 'README.md', path: 'README.md', type: 'file' as const, size: 10 },
    { name: 'main.ts', path: 'src/main.ts', type: 'file' as const, size: 5 },
  ];
  return {
    listFiles: vi.fn(async (_w: string, path: string) =>
      path === ''
        ? [
            { name: 'src', path: 'src', type: 'dir' as const, size: 0 },
            { name: 'README.md', path: 'README.md', type: 'file' as const, size: 10 },
          ]
        : [{ name: 'main.ts', path: 'src/main.ts', type: 'file' as const, size: 5 }]
    ),
    searchFiles: vi.fn(async (_w: string, params: { q: string }) => {
      if (params.q === '.') return allEntries;
      const q = params.q.toLowerCase();
      return allEntries.filter((f) => f.name.toLowerCase().includes(q));
    }),
  };
});

describe('FileExplorer', () => {
  it('renders root entries, expands dirs lazily, and opens files', async () => {
    const onOpen = vi.fn();
    render(<FileExplorer workspaceId="w1" onOpenFile={onOpen} onError={vi.fn()} />);

    expect(await screen.findByText('README.md')).toBeTruthy();

    // 展开目录时才加载子项
    await userEvent.click(screen.getByText('src'));
    expect(await screen.findByText('main.ts')).toBeTruthy();

    // 点击文件回调路径与名称
    await userEvent.click(screen.getByText('main.ts'));
    expect(onOpen).toHaveBeenCalledWith('src/main.ts', 'main.ts');
  });

  it('filters files by name search', async () => {
    const onOpen = vi.fn();
    render(<FileExplorer workspaceId="w1" onOpenFile={onOpen} onError={vi.fn()} />);

    const input = screen.getByPlaceholderText('搜索文件名…');
    await userEvent.type(input, 'readme');

    // 等待搜索完成:src 目录名不匹配,应从结果中消失
    await waitFor(() => {
      expect(screen.queryByText('src')).toBeNull();
    });
    // README.md 匹配,应出现在结果中
    expect(screen.getByText('README.md')).toBeTruthy();
  });

  it('filters files by extension', async () => {
    const onOpen = vi.fn();
    render(<FileExplorer workspaceId="w1" onOpenFile={onOpen} onError={vi.fn()} />);

    const extInput = screen.getByPlaceholderText('ts,tsx');
    await userEvent.type(extInput, 'ts');

    // 等待搜索完成:README.md 不是 .ts 文件,应消失
    await waitFor(() => {
      expect(screen.queryByText('README.md')).toBeNull();
    });
    // main.ts 在 src 子目录中,应出现在结果中
    expect(screen.getByText('main.ts')).toBeTruthy();
  });
});
