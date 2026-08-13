import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FileExplorer } from './FileExplorer';

vi.mock('../../lib/api', () => {
  const rootEntries = [
    { name: 'src', path: 'src', type: 'dir' as const, size: 0 },
    { name: 'README.md', path: 'README.md', type: 'file' as const, size: 10 },
  ];
  const srcEntries = [
    { name: 'main.ts', path: 'src/main.ts', type: 'file' as const, size: 5 },
  ];
  return {
    listFiles: vi.fn(async (_w: string, path: string) =>
      path === '' ? rootEntries : srcEntries
    ),
    searchFiles: vi.fn(async () => [
      { path: 'README.md', name: 'README.md', line: 1, content: '# combo Project' },
      { path: 'src/main.ts', name: 'main.ts', line: 3, content: 'const x = readme();' },
    ]),
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

  it('searches file contents and shows matching lines', async () => {
    const onOpen = vi.fn();
    render(<FileExplorer workspaceId="w1" onOpenFile={onOpen} onError={vi.fn()} />);

    const input = screen.getByPlaceholderText('搜索文件内容…');
    await userEvent.type(input, 'readme');

    // 等待搜索完成:应显示匹配的内容行
    await waitFor(() => {
      expect(screen.getByText('main.ts')).toBeTruthy();
    });
    // 匹配行内容应出现(高亮后文本被拆分,用函数匹配)
    await waitFor(() => {
      const els = screen.getAllByText((_content, el) =>
        el?.tagName === 'CODE' && !!el.textContent?.includes('const x = readme();'),
      );
      expect(els.length).toBeGreaterThan(0);
    });
  });
});
