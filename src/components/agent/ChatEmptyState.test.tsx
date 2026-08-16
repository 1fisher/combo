import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ChatEmptyState } from './ChatEmptyState';

describe('ChatEmptyState 订阅横幅', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('无会话时默认显示横幅,有会话时不显示', () => {
    const { rerender } = render(<ChatEmptyState hasSession={false} onPickTemplate={vi.fn()} />);
    expect(screen.getByText(/开源免费的 Agent IDE/)).toBeTruthy();
    rerender(<ChatEmptyState hasSession onPickTemplate={vi.fn()} />);
    expect(screen.queryByText(/开源免费的 Agent IDE/)).toBeNull();
  });

  it('点击右上角关闭按钮后横幅消失并持久化,重新挂载不再出现', async () => {
    const user = userEvent.setup();
    const { unmount } = render(<ChatEmptyState hasSession={false} onPickTemplate={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: '关闭' }));
    expect(screen.queryByText(/开源免费的 Agent IDE/)).toBeNull();
    expect(localStorage.getItem('combo.bannerDismissed')).toBe('1');

    // 重新挂载(模拟切换会话回来)仍保持关闭
    unmount();
    render(<ChatEmptyState hasSession={false} onPickTemplate={vi.fn()} />);
    expect(screen.queryByText(/开源免费的 Agent IDE/)).toBeNull();
  });

  it('已关闭状态下模板卡片仍可用', async () => {
    localStorage.setItem('combo.bannerDismissed', '1');
    const onPickTemplate = vi.fn();
    const user = userEvent.setup();
    render(<ChatEmptyState hasSession={false} onPickTemplate={onPickTemplate} />);
    await user.click(screen.getByRole('button', { name: /Git 站会摘要/ }));
    expect(onPickTemplate).toHaveBeenCalledWith(
      '请查看这个项目最近的 Git 提交记录,生成一份本周的站会摘要。',
    );
  });
});
