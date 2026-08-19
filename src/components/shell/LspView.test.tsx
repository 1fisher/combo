import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LspView } from './LspView';
import * as api from '../../lib/api';
import type { Api } from '../../lib/api/types';

/**
 * LSP 服务视图测试:列表渲染(可执行状态徽章 + 一键安装按钮)、
 * 空态 hero 一键安装 / 无方案回退表单、安装横幅(运行中/失败)、
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

const plans: Api.LspInstallPlan[] = [
  {
    name: 'rust',
    command: 'rust-analyzer',
    args: null,
    install_command: 'rustup component add rust-analyzer',
  },
  {
    name: 'python',
    command: 'pyright-langserver',
    args: ['--stdio'],
    install_command: null,
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
  vi.spyOn(api, 'listLspPlans').mockResolvedValue(plans);
  vi.spyOn(api, 'getLspInstallStatus').mockResolvedValue({ running: false });
  vi.spyOn(api, 'installLspServer').mockResolvedValue({
    ok: true,
    name: 'rust',
    command: 'rustup component add rust-analyzer',
  });
  vi.spyOn(api, 'cancelLspInstall').mockResolvedValue({ ok: true });
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

  it('未找到且有一键方案时显示「安装」按钮,点击触发安装', async () => {
    const install = vi.spyOn(api, 'installLspServer').mockResolvedValue({ ok: true, name: 'python' });
    // python 方案本机可解析(pipx 可用)→ 列表行出现安装按钮
    vi.spyOn(api, 'listLspPlans').mockResolvedValue([
      plans[0],
      { ...plans[1], install_command: 'pipx install pyright' },
    ]);
    renderView();
    const btn = await screen.findByRole('button', { name: /安装$/ });
    expect(btn.textContent).toContain('安装');
    fireEvent.click(btn);
    await waitFor(() => expect(install.mock.calls[0]?.[0]).toBe('python'));
  });

  it('空列表显示 hero 模板卡片与安装命令', async () => {
    vi.spyOn(api, 'listLspServers').mockResolvedValue([]);
    renderView();
    expect(await screen.findByText('Rust')).toBeTruthy();
    expect(screen.getByText('TypeScript')).toBeTruthy();
    expect(screen.getByText('Python')).toBeTruthy();
    expect(screen.getByText('Go')).toBeTruthy();
    expect(screen.getByText('自定义')).toBeTruthy();
    // rust 卡片 footer 显示解析后的安装命令
    expect(screen.getByText(/rustup component add rust-analyzer/)).toBeTruthy();
  });

  it('hero 卡片一键安装:确认后调 install,无方案回退表单', async () => {
    vi.spyOn(api, 'listLspServers').mockResolvedValue([]);
    const install = vi.spyOn(api, 'installLspServer');
    renderView();
    // Rust 卡片(有 install_command)→ 直接安装
    fireEvent.click(await screen.findByRole('button', { name: /^Rust/ }));
    await waitFor(() => expect(install.mock.calls[0]?.[0]).toBe('rust'));
    // Python 卡片(本机无包管理器,install_command=null)→ 回退表单预填
    fireEvent.click(screen.getByRole('button', { name: /^Python/ }));
    const nameInput = await screen.findByPlaceholderText(FIELD.name);
    expect((nameInput as HTMLInputElement).value).toBe('python');
    expect((screen.getByPlaceholderText(FIELD.command) as HTMLInputElement).value).toBe(
      'pyright-langserver',
    );
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

describe('LspView 安装横幅', () => {
  it('运行中展示进度与取消按钮', async () => {
    vi.spyOn(api, 'getLspInstallStatus').mockResolvedValue({
      running: true,
      name: 'rust',
      command: 'rustup component add rust-analyzer',
      status: 'running',
      message: '',
      log: ['downloading 42%'],
    });
    renderView();
    expect(await screen.findByText('正在安装 rust')).toBeTruthy();
    expect(screen.getByText(/downloading 42%/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /取消/ }));
    await waitFor(() => expect(api.cancelLspInstall).toHaveBeenCalled());
  });

  it('失败展示原因与重试按钮', async () => {
    const install = vi.spyOn(api, 'installLspServer');
    vi.spyOn(api, 'getLspInstallStatus').mockResolvedValue({
      running: false,
      name: 'rust',
      command: 'rustup component add rust-analyzer',
      status: 'failed',
      message: '安装命令退出码 1',
      log: ['error: no toolchain'],
    });
    renderView();
    expect(await screen.findByText('安装失败:rust')).toBeTruthy();
    expect(screen.getByText(/安装命令退出码 1/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /重试/ }));
    await waitFor(() => expect(install.mock.calls[0]?.[0]).toBe('rust'));
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
