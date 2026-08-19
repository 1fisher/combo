import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LspStatusBanner } from './LspStatusBanner';
import type { LspIssue } from '../../lib/lspStatus';

const NOT_FOUND: LspIssue = {
  lang: 'rust',
  label: 'Rust',
  files: 126,
  kind: 'not-found',
  command: 'rust-analyzer',
};
const MISSING: LspIssue = {
  lang: 'typescript',
  label: 'TypeScript',
  files: 40,
  kind: 'missing',
  command: 'typescript-language-server',
};

describe('LspStatusBanner', () => {
  it('可执行文件缺失时显示错误标题与命令细节', () => {
    render(<LspStatusBanner issues={[NOT_FOUND]} onOpenLsp={vi.fn()} onDismiss={vi.fn()} />);
    expect(screen.getByText('语言服务检测异常')).toBeTruthy();
    expect(screen.getByText('rust-analyzer', { exact: false })).toBeTruthy();
    expect(screen.getByText(/126 个源文件/)).toBeTruthy();
  });

  it('仅缺配置时显示警告标题与建议命令', () => {
    render(<LspStatusBanner issues={[MISSING]} onOpenLsp={vi.fn()} onDismiss={vi.fn()} />);
    expect(screen.getByText('语言服务未配置')).toBeTruthy();
    expect(screen.getByText(/未配置 LSP server/)).toBeTruthy();
    expect(screen.getByText('typescript-language-server', { exact: false })).toBeTruthy();
  });

  it('「去配置」与「忽略」回调生效', async () => {
    const user = userEvent.setup();
    const onOpenLsp = vi.fn();
    const onDismiss = vi.fn();
    render(<LspStatusBanner issues={[NOT_FOUND, MISSING]} onOpenLsp={onOpenLsp} onDismiss={onDismiss} />);
    await user.click(screen.getByRole('button', { name: '去配置' }));
    expect(onOpenLsp).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: '忽略本次提示' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    // 多条问题逐语言展示
    expect(screen.getByText('Rust')).toBeTruthy();
    expect(screen.getByText('TypeScript')).toBeTruthy();
  });
});
