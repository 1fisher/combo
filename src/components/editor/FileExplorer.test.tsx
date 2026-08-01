import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FileExplorer } from './FileExplorer';

vi.mock('../../lib/api', () => ({
  listFiles: vi.fn(async (_w: string, path: string) =>
    path === ''
      ? [
          { name: 'src', path: 'src', type: 'dir', size: 0 },
          { name: 'README.md', path: 'README.md', type: 'file', size: 10 },
        ]
      : [{ name: 'main.ts', path: 'src/main.ts', type: 'file', size: 5 }]
  ),
}));

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
});
