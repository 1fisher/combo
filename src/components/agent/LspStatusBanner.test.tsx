import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LspStatusBanner } from './LspStatusBanner';
import type { LspIssue, LspReady } from '../../lib/lspStatus';

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
const READY: LspReady[] = [
  { lang: 'rust', label: 'Rust', files: 126, command: 'rust-analyzer' },
  { lang: 'typescript', label: 'TypeScript', files: 40, command: 'typescript-language-server' },
];

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

  it('无问题且就绪列表非空时显示正向「语言服务已就绪」', () => {
    render(<LspStatusBanner issues={[]} ready={READY} onOpenLsp={vi.fn()} onDismiss={vi.fn()} />);
    expect(screen.getByText('语言服务已就绪')).toBeTruthy();
    // 逐语言展示可用 server
    expect(screen.getByText('Rust')).toBeTruthy();
    expect(screen.getByText('TypeScript')).toBeTruthy();
    expect(screen.getByText('rust-analyzer')).toBeTruthy();
    expect(screen.getByText('typescript-language-server')).toBeTruthy();
    expect(screen.getByText(/代码诊断 \/ 跳转定义 \/ 引用查找 \/ 悬停信息工具已可用/)).toBeTruthy();
    // 正向模式用「详情」而非「去配置」
    expect(screen.queryByRole('button', { name: '去配置' })).toBeNull();
  });

  it('正向模式的「详情」与「忽略」回调生效', async () => {
    const user = userEvent.setup();
    const onOpenLsp = vi.fn();
    const onDismiss = vi.fn();
    render(<LspStatusBanner issues={[]} ready={READY} onOpenLsp={onOpenLsp} onDismiss={onDismiss} />);
    await user.click(screen.getByRole('button', { name: '详情' }));
    expect(onOpenLsp).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: '忽略本次提示' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
