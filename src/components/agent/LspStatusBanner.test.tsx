import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LspStatusBanner, LspReadyIndicator } from './LspStatusBanner';
import type { Api } from '../../lib/api/types';
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
});

describe('LspReadyIndicator', () => {
  it('渲染为小 icon(非横幅),点击跳 LSP 视图', async () => {
    const user = userEvent.setup();
    const onOpenLsp = vi.fn();
    const { container } = render(<LspReadyIndicator ready={READY} onOpenLsp={onOpenLsp} />);
    // 非问题横幅形态(仅一枚 icon 按钮)
    expect(container.querySelector('[data-testid="lsp-status-banner"]')).toBeNull();
    const btn = screen.getByTestId('lsp-ready-indicator');
    await user.click(btn);
    expect(onOpenLsp).toHaveBeenCalledTimes(1);
  });

  it('悬停显示就绪详情 tooltip(语言 + server + 工具说明)', async () => {
    const user = userEvent.setup();
    render(<LspReadyIndicator ready={READY} onOpenLsp={vi.fn()} />);
    await user.hover(screen.getByTestId('lsp-ready-indicator'));
    expect(await screen.findByText('语言服务已就绪')).toBeTruthy();
    expect(screen.getByText('rust-analyzer', { exact: false })).toBeTruthy();
    expect(screen.getByText('typescript-language-server', { exact: false })).toBeTruthy();
    expect(screen.getByText(/代码诊断 \/ 跳转定义 \/ 引用查找 \/ 悬停信息工具已可用/)).toBeTruthy();
    // 就绪列表不再展示源文件计数(噪音信息)
    expect(screen.queryByText(/个源文件/)).toBeNull();
  });

  it('tooltip 按相对路径分组列出错误行与消息,点击跳转到对应行', async () => {
    const user = userEvent.setup();
    const onOpenFileAtLine = vi.fn();
    const entries: Api.LspDiagEntry[] = [
      { path: 'src/App.tsx', line: 2, character: 8, endLine: 2, endCharacter: 12, severity: 1, message: "Type 'string' is not assignable to type 'number'", source: 'typescript' },
      { path: 'src/App.tsx', line: 5, character: 0, endLine: 5, endCharacter: 3, severity: 2, message: 'unused variable', source: 'typescript' },
      { path: 'src/lib.rs', line: 0, character: 0, endLine: 0, endCharacter: 1, severity: 1, message: 'borrow of moved value', source: 'rust-analyzer' },
    ];
    render(
      <LspReadyIndicator
        ready={READY}
        onOpenLsp={vi.fn()}
        entries={entries}
        onOpenFileAtLine={onOpenFileAtLine}
      />,
    );
    const btn = screen.getByTestId('lsp-ready-indicator');
    expect(btn.dataset.state).toBe('error');
    await user.hover(btn);
    // 相对项目目录的文件名分组 + 总数(跨文件聚合,无「当前文件:」前缀)
    expect(await screen.findByText('src/App.tsx')).toBeTruthy();
    expect(screen.getByText('src/lib.rs')).toBeTruthy();
    expect(screen.getByText(/2 个错误 \/ 1 个警告/)).toBeTruthy();
    // 行号 1-based + 简短错误消息
    expect(screen.getByText('3')).toBeTruthy();
    expect(screen.getByText(/Type 'string' is not assignable/)).toBeTruthy();
    // 点击某条 → 跳转回调携带文件与 1-based 行号(radix tooltip 经 Portal 渲染,查 document)
    const items = Array.from(document.querySelectorAll('[data-lsp-diag-item]'));
    expect(items).toHaveLength(3);
    await user.click(items[0] as HTMLElement);
    expect(onOpenFileAtLine).toHaveBeenCalledWith('src/App.tsx', 3);
    // 底部提示切换为「点击跳转」语义
    expect(screen.getByText(/点击条目跳转到对应行/)).toBeTruthy();
  });

  it('entries 为空数组时按已就绪展示(不渲染错误列表)', async () => {
    const user = userEvent.setup();
    render(<LspReadyIndicator ready={READY} onOpenLsp={vi.fn()} entries={[]} />);
    const btn = screen.getByTestId('lsp-ready-indicator');
    expect(btn.dataset.state).toBe('ready');
    await user.hover(btn);
    expect(await screen.findByText('语言服务已就绪')).toBeTruthy();
    expect(document.querySelectorAll('[data-lsp-diag-item]')).toHaveLength(0);
  });

  it('tooltip 内容带状态颜色标记(标题绿勾 + 每语言状态点)', async () => {
    const user = userEvent.setup();
    render(<LspReadyIndicator ready={READY} onOpenLsp={vi.fn()} />);
    await user.hover(screen.getByTestId('lsp-ready-indicator'));
    await screen.findByText('语言服务已就绪');
    // 标题行带绿色勾图标,每语言一行各带一个绿色状态点(radix tooltip 经 Portal
    // 渲染到 document.body,须查 document 而非 render 的 container)
    const title = screen.getByText('语言服务已就绪').closest('span')!;
    expect(title.querySelector('.text-emerald-600, .text-emerald-400')).toBeTruthy();
    const dots = document.querySelectorAll('[data-lsp-ready-lang] > span[aria-hidden]');
    expect(dots).toHaveLength(READY.length);
    dots.forEach((d) => expect(d.className).toContain('bg-emerald-500'));
  });

  it('当前文件有错误时指示器变红,tooltip 报错误数', async () => {
    const user = userEvent.setup();
    render(<LspReadyIndicator ready={READY} onOpenLsp={vi.fn()} fileDiags={{ errors: 2, warnings: 1 }} />);
    const btn = screen.getByTestId('lsp-ready-indicator');
    expect(btn.dataset.state).toBe('error');
    expect(btn.className).toContain('text-destructive');
    await user.hover(btn);
    expect(await screen.findByText(/当前文件:2 个错误 \/ 1 个警告/)).toBeTruthy();
    expect(screen.getByText(/编辑器内以波浪线标注具体位置/)).toBeTruthy();
  });

  it('当前文件仅警告时指示器为琥珀色', async () => {
    const user = userEvent.setup();
    render(<LspReadyIndicator ready={READY} onOpenLsp={vi.fn()} fileDiags={{ errors: 0, warnings: 3 }} />);
    const btn = screen.getByTestId('lsp-ready-indicator');
    expect(btn.dataset.state).toBe('warning');
    expect(btn.className).toContain('text-amber-500');
    await user.hover(btn);
    expect(await screen.findByText(/当前文件:3 个警告/)).toBeTruthy();
  });
});
