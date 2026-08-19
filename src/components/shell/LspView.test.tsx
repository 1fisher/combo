import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LspView } from './LspView';
import * as api from '../../lib/api';
import type { Api } from '../../lib/api/types';

/**
 * LSP 服务视图测试:列表渲染(可执行状态徽章)、空态 hero、
 * 表单校验(command 带参数拦截)与保存载荷(args/env 解析)。
 * 注:项目未启用 jest-dom 匹配器,统一用 truthy/文本断言。
 */

vi.mock('../../lib/confirm', () => ({
  confirmDialog: vi.fn(async () => true),
}));

const servers: Api.LspServer[] = [
  {
    name: 'rust',
    command: 'rust-analyzer',
    args: ['--preview'],
    env: { RUST_BACKTRACE: '1' },
    executable: true,
    path: '/usr/local/bin/rust-analyzer',
  },
  {
    name: 'python',
    command: 'pyright-langserver',
    args: ['--stdio'],
    executable: false,
    path: null,
  },
];

function renderView() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <LspView />
    </QueryClientProvider>,
  );
}

/** 表单输入(placeholder 定位,标签无 htmlFor 关联) */
const FIELD = {
  name: '如 rust、typescript(配置段名 [lsp.<语言>])',
  command: 'rust-analyzer',
  args: '--stdio',
  env: /RUST_BACKTRACE=1/,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(api, 'listLspServers').mockResolvedValue(servers);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('LspView 列表', () => {
  it('渲染 server 列表与可执行状态徽章', async () => {
    renderView();
    expect(await screen.findByText('rust')).toBeTruthy();
    expect(screen.getByText('已安装')).toBeTruthy();
    expect(screen.getByText('未找到')).toBeTruthy();
    expect(screen.getByText(/rust-analyzer --preview/)).toBeTruthy();
    expect(screen.getByText(/可执行文件:\/usr\/local\/bin\/rust-analyzer/)).toBeTruthy();
    expect(screen.getByText(/共 2 个 LSP server/)).toBeTruthy();
  });

  it('空列表显示 hero 模板卡片', async () => {
    vi.spyOn(api, 'listLspServers').mockResolvedValue([]);
    renderView();
    expect(await screen.findByText('Rust')).toBeTruthy();
    expect(screen.getByText('TypeScript')).toBeTruthy();
    expect(screen.getByText('Python')).toBeTruthy();
    expect(screen.getByText('Go')).toBeTruthy();
    expect(screen.getByText('自定义')).toBeTruthy();
  });

  it('「检测命令」调用 check 并展示路径', async () => {
    const check = vi
      .spyOn(api, 'checkLspCommand')
      .mockResolvedValue({ found: true, path: '/opt/homebrew/bin/pyright-langserver' });
    renderView();
    // 两行各有「检测命令」按钮,点 python 那一行(第二个)
    const buttons = await screen.findAllByRole('button', { name: /检测命令/ });
    fireEvent.click(buttons[1]);
    await waitFor(() => expect(check).toHaveBeenCalledWith('pyright-langserver'));
    expect(
      await screen.findByText(/\/opt\/homebrew\/bin\/pyright-langserver/),
    ).toBeTruthy();
  });
});

describe('LspView 表单', () => {
  async function openForm() {
    fireEvent.click(await screen.findByRole('button', { name: /添加 server/ }));
    await screen.findByPlaceholderText(FIELD.name);
  }

  it('空表单字段初始为空', async () => {
    renderView();
    await screen.findByText('rust');
    await openForm();
    expect((screen.getByPlaceholderText(FIELD.name) as HTMLInputElement).value).toBe('');
    expect((screen.getByPlaceholderText(FIELD.command) as HTMLInputElement).value).toBe('');
  });

  it('command 含参数时拦截保存', async () => {
    const upsert = vi.spyOn(api, 'upsertLspServer').mockResolvedValue({ ok: true, name: 'x' });
    renderView();
    await screen.findByText('rust');
    await openForm();
    fireEvent.change(screen.getByPlaceholderText(FIELD.name), { target: { value: 'go' } });
    fireEvent.change(screen.getByPlaceholderText(FIELD.command), {
      target: { value: 'gopls serve' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(await screen.findByText(/启动命令只能是可执行文件本身/)).toBeTruthy();
    expect(upsert).not.toHaveBeenCalled();
  });

  it('保存载荷含 args 与解析后的 env(注释行忽略)', async () => {
    const upsert = vi.spyOn(api, 'upsertLspServer').mockResolvedValue({ ok: true, name: 'rust' });
    renderView();
    await screen.findByText('rust');
    await openForm();
    fireEvent.change(screen.getByPlaceholderText(FIELD.name), { target: { value: 'rust' } });
    fireEvent.change(screen.getByPlaceholderText(FIELD.command), {
      target: { value: 'rust-analyzer' },
    });
    fireEvent.change(screen.getByPlaceholderText(FIELD.args), { target: { value: '--preview' } });
    fireEvent.change(screen.getByPlaceholderText(FIELD.env), {
      target: { value: '# 注释\nRUST_BACKTRACE=1' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(upsert).toHaveBeenCalled());
    // react-query 会给 mutationFn 附加第二个 context 参数,只断言业务载荷
    expect(upsert.mock.calls[0][0]).toEqual({
      name: 'rust',
      command: 'rust-analyzer',
      args: '--preview',
      env: { RUST_BACKTRACE: '1' },
    });
  });

  it('环境变量格式非法时拦截保存', async () => {
    const upsert = vi.spyOn(api, 'upsertLspServer').mockResolvedValue({ ok: true, name: 'rust' });
    renderView();
    await screen.findByText('rust');
    await openForm();
    fireEvent.change(screen.getByPlaceholderText(FIELD.name), { target: { value: 'rust' } });
    fireEvent.change(screen.getByPlaceholderText(FIELD.command), {
      target: { value: 'rust-analyzer' },
    });
    fireEvent.change(screen.getByPlaceholderText(FIELD.env), {
      target: { value: 'BAD LINE NO EQ' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(await screen.findByText(/环境变量格式应为 KEY=VALUE/)).toBeTruthy();
    expect(upsert).not.toHaveBeenCalled();
  });
});
