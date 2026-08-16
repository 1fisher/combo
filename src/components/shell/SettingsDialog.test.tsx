import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SettingsDialog } from './SettingsDialog';
import { useAgentStore } from '../../stores/agentStore';
import { useUIPreferences } from '../../stores/uiPreferencesStore';
import {
  clearExternalUrl,
  clearProxyUrlOverride,
  getExternalUrl,
  getProxyUrlOverride,
} from '../../lib/connection';

const fetchModelsMutate = vi.fn();
const saveKeyMutate = vi.fn();
const addKeyMutate = vi.fn();
const activateKeyMutate = vi.fn();
const renameKeyMutate = vi.fn();
const removeKeyMutate = vi.fn();
const createProviderMutate = vi.fn();
const removeProviderMutate = vi.fn();

vi.mock('../../hooks/useAgentModel', () => ({
  useProviders: () => ({
    data: [
      {
        id: 'opencode',
        name: 'OpenCode Zen',
        type: 'openai-compat',
        has_api_key: true,
        api_key_masked: 'sk-a****1234',
        api_keys_masked: [
          { masked: 'sk-a****1234', name: '工作' },
          { masked: 'sk-b****5678', name: null },
        ],
        active_key_index: 0,
        models: [{ id: 'deepseek-v4-flash-free', name: 'deepseek-v4-flash-free' }],
      },
      { id: 'zhipu', name: 'Zhipu', type: 'openai', has_api_key: true, models: [] },
      {
        id: 'deepseek',
        name: 'DeepSeek',
        type: 'openai',
        has_api_key: false,
        models: [
          { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', context_window: 262144 },
          { id: 'deepseek-chat', name: 'DeepSeek Chat' },
        ],
      },
      {
        id: 'my-relay',
        name: '我的中转',
        type: 'openai-compat',
        custom: true,
        has_api_key: false,
        models: [],
      },
    ],
  }),
  useFetchModels: () => ({ mutateAsync: fetchModelsMutate, isPending: false }),
  useSaveProviderKey: () => ({ mutateAsync: saveKeyMutate, isPending: false }),
  useProviderKeys: () => ({
    add: { mutateAsync: addKeyMutate, isPending: false },
    activate: { mutateAsync: activateKeyMutate, isPending: false },
    rename: { mutateAsync: renameKeyMutate, isPending: false },
    remove: { mutateAsync: removeKeyMutate, isPending: false },
  }),
  useProviderCrud: () => ({
    create: { mutateAsync: createProviderMutate, isPending: false },
    remove: { mutateAsync: removeProviderMutate, isPending: false },
  }),
}));

function renderWithProviders(ui: React.ReactElement) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>{ui}</QueryClientProvider>,
  );
}

describe('SettingsDialog', () => {
  beforeEach(() => {
    fetchModelsMutate.mockReset();
    fetchModelsMutate.mockResolvedValue({ provider: 'opencode', models: [{ id: 'm1', name: 'M1' }] });
    saveKeyMutate.mockReset();
    saveKeyMutate.mockResolvedValue({ ok: true });
    addKeyMutate.mockReset();
    addKeyMutate.mockResolvedValue({ ok: true });
    activateKeyMutate.mockReset();
    activateKeyMutate.mockResolvedValue({ ok: true });
    renameKeyMutate.mockReset();
    renameKeyMutate.mockResolvedValue({ ok: true });
    removeKeyMutate.mockReset();
    removeKeyMutate.mockResolvedValue({ ok: true });
    createProviderMutate.mockReset();
    createProviderMutate.mockResolvedValue({ ok: true });
    removeProviderMutate.mockReset();
    removeProviderMutate.mockResolvedValue({ ok: true });
    // confirmDialog 在浏览器模式走 window.confirm
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });

  it('saves the proxy url override to localStorage', async () => {
    renderWithProviders(<SettingsDialog open onOpenChange={vi.fn()} />);
    const input = screen.getByPlaceholderText('http://127.0.0.1:18236');
    await userEvent.clear(input);
    await userEvent.type(input, 'http://10.0.0.5:18236');
    await userEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(getProxyUrlOverride()).toBe('http://10.0.0.5:18236');
    clearProxyUrlOverride();
  });

  it('saves the external domain to localStorage', async () => {
    renderWithProviders(<SettingsDialog open onOpenChange={vi.fn()} />);
    const input = screen.getByPlaceholderText('https://proxy.apesoft.cn');
    await userEvent.type(input, 'https://combo.example.com');
    await userEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(getExternalUrl()).toBe('https://combo.example.com');
    clearExternalUrl();
  });

  it('clears external domain via 清除域名配置', async () => {
    const { clearExternalUrl: clear } = await import('../../lib/connection');
    clear();
    const { setExternalUrl } = await import('../../lib/connection');
    setExternalUrl('https://combo.example.com');
    renderWithProviders(<SettingsDialog open onOpenChange={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: '清除域名配置' }));
    expect(getExternalUrl()).toBeNull();
  });

  it('shows masked api key when provider has one configured', async () => {
    renderWithProviders(<SettingsDialog open onOpenChange={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /OpenCode Zen/ }));
    // 第一个 key 带名称:显示名称 + 脱敏 key
    expect(screen.getByText('工作')).toBeTruthy();
    expect(screen.getByText('sk-a****1234')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: /Zhipu/ }));
    expect(screen.getByText('已配置 Key')).toBeTruthy();
  });

  it('fetches models with saved key when no key typed', async () => {
    renderWithProviders(<SettingsDialog open onOpenChange={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /OpenCode Zen/ }));
    const fetchBtn = screen.getAllByRole('button', { name: '拉取模型' })[0] as HTMLButtonElement;
    expect(fetchBtn.disabled).toBe(false);
    await userEvent.click(fetchBtn);
    expect(fetchModelsMutate).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: 'opencode', apiKey: undefined })
    );
    expect(await screen.findByText('已拉取到 1 个模型(使用已保存的 Key)')).toBeTruthy();
  });

  it('removes api key via 删除 button', async () => {
    renderWithProviders(<SettingsDialog open onOpenChange={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /OpenCode Zen/ }));
    await userEvent.click(screen.getAllByRole('button', { name: '删除' })[0]);
    expect(removeKeyMutate).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: 'opencode', keyIndex: 0 })
    );
    expect(await screen.findByText('已删除 API Key')).toBeTruthy();
  });

  it('switches active api key via 使用 button', async () => {
    renderWithProviders(<SettingsDialog open onOpenChange={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /OpenCode Zen/ }));
    const useBtn = screen.getAllByRole('button', { name: '使用' })[0] as HTMLButtonElement;
    expect(useBtn).toBeTruthy();
    await userEvent.click(useBtn);
    expect(activateKeyMutate).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: 'opencode', keyIndex: 1 })
    );
    expect(await screen.findByText('已切换激活 Key')).toBeTruthy();
  });

  it('adds api key with optional name', async () => {
    renderWithProviders(<SettingsDialog open onOpenChange={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /OpenCode Zen/ }));
    await userEvent.type(screen.getByPlaceholderText(/Key 名称/), '测试环境');
    await userEvent.type(
      screen.getByPlaceholderText(/输入新 API Key/),
      'sk-test-xyz'
    );
    await userEvent.click(screen.getAllByRole('button', { name: '添加' })[0]);
    expect(addKeyMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: 'opencode',
        apiKey: 'sk-test-xyz',
        name: '测试环境',
      })
    );
    expect(await screen.findByText('已添加 Key')).toBeTruthy();
  });

  it('renames an api key via pencil button', async () => {
    renderWithProviders(<SettingsDialog open onOpenChange={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /OpenCode Zen/ }));
    // 第二个 key(sk-b****5678)没有名字,铅笔按钮 title 为「添加名称」
    await userEvent.click(screen.getByTitle('添加名称'));
    const input = screen.getByPlaceholderText('Key 名称(留空清除)');
    await userEvent.clear(input);
    await userEvent.type(input, '备用');
    await userEvent.keyboard('{Enter}');
    expect(renameKeyMutate).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: 'opencode', keyIndex: 1, name: '备用' })
    );
    expect(await screen.findByText('已更新 Key 名称')).toBeTruthy();
  });

  it('disables fetch for provider without key and empty input', async () => {
    renderWithProviders(<SettingsDialog open onOpenChange={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /DeepSeek/ }));
    const fetchBtn = screen.getAllByRole('button', { name: '拉取模型' })[0] as HTMLButtonElement;
    expect(fetchBtn.disabled).toBe(true);
  });

  it('places key name and key inputs on the same row', async () => {
    renderWithProviders(<SettingsDialog open onOpenChange={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /OpenCode Zen/ }));
    const nameInput = screen.getByPlaceholderText(/Key 名称/);
    const keyInput = screen.getByPlaceholderText(/输入新 API Key/);
    // 两个输入框同为同一个 flex 行的子元素
    expect(nameInput.parentElement).toBe(keyInput.parentElement);
  });

  it('shows custom badge only for custom providers', () => {
    renderWithProviders(<SettingsDialog open onOpenChange={vi.fn()} />);
    // 只有 my-relay 是自定义 provider,显示「自定义」标记
    expect(screen.getAllByText('自定义').length).toBe(1);
    // 删除 Provider 按钮只出现在自定义 provider 上(内置 3 个没有)
    expect(screen.getAllByTitle(/删除该自定义 Provider/).length).toBe(1);
  });

  it('deletes a custom provider via 删除 Provider button', async () => {
    renderWithProviders(<SettingsDialog open onOpenChange={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: '删除 Provider' }));
    expect(removeProviderMutate).toHaveBeenCalledWith({ providerId: 'my-relay' });
  });

  it('creates a provider via the 添加 Provider form', async () => {
    renderWithProviders(<SettingsDialog open onOpenChange={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: '添加 Provider' }));
    await userEvent.type(screen.getByPlaceholderText(/^ID/), 'relay2');
    await userEvent.type(screen.getByPlaceholderText(/^显示名称/), '二号中转');
    await userEvent.type(screen.getByPlaceholderText(/^Base URL/), 'https://x.example.com/v1');
    await userEvent.type(screen.getByPlaceholderText(/^API Key/), 'sk-new-1');
    await userEvent.click(screen.getByRole('button', { name: '创建' }));
    expect(createProviderMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'relay2',
        name: '二号中转',
        providerType: 'openai-compat',
        baseUrl: 'https://x.example.com/v1',
        apiKey: 'sk-new-1',
      }),
    );
    expect(await screen.findByText(/已创建/)).toBeTruthy();
  });

  it('disables create button until id is filled', async () => {
    renderWithProviders(<SettingsDialog open onOpenChange={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: '添加 Provider' }));
    const btn = screen.getByRole('button', { name: '创建' }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    await userEvent.type(screen.getByPlaceholderText(/^ID/), 'relay3');
    expect((screen.getByRole('button', { name: '创建' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it('切换 Provider 后上下文窗口保存到新 provider 的模型,不残留旧模型', async () => {
    renderWithProviders(<SettingsDialog open onOpenChange={vi.fn()} />);
    // 默认选中第一个 provider(opencode)的模型
    const providerSel = screen.getByLabelText('选择 Provider');
    const modelSel = screen.getByLabelText('选择模型');
    expect((providerSel as HTMLSelectElement).value).toBe('opencode');
    expect((modelSel as HTMLSelectElement).value).toBe('deepseek-v4-flash-free');
    // 切到 DeepSeek:模型应联动为新 provider 的默认/首个模型
    await userEvent.selectOptions(providerSel, 'deepseek');
    expect((modelSel as HTMLSelectElement).value).toBe('deepseek-v4-flash');
    // 设置 1M 并保存
    await userEvent.click(screen.getByRole('button', { name: '1M' }));
    await userEvent.click(screen.getByRole('button', { name: '保存' }));
    // 只写入当前模型,旧模型(deepseek-v4-flash-free)不受影响
    expect(useAgentStore.getState().contextOverrides).toEqual({
      'deepseek-v4-flash': 1_048_576,
    });
    useAgentStore.getState().clearContextOverride('deepseek-v4-flash');
  });

  it('关闭任务结束通知与交互请求通知开关', async () => {
    useUIPreferences.setState({ notifyRunComplete: true, notifyInteraction: true });
    renderWithProviders(<SettingsDialog open onOpenChange={vi.fn()} />);
    await userEvent.click(screen.getByRole('switch', { name: '任务结束通知' }));
    await userEvent.click(screen.getByRole('switch', { name: '交互请求通知' }));
    expect(useUIPreferences.getState().notifyRunComplete).toBe(false);
    expect(useUIPreferences.getState().notifyInteraction).toBe(false);
    useUIPreferences.setState({ notifyRunComplete: true, notifyInteraction: true });
  });

  it('关闭 Combo 特效音效与通知音效开关', async () => {
    useUIPreferences.setState({ comboSoundEnabled: true, notifySoundEnabled: true });
    renderWithProviders(<SettingsDialog open onOpenChange={vi.fn()} />);
    await userEvent.click(screen.getByRole('switch', { name: 'Combo 特效音效' }));
    await userEvent.click(screen.getByRole('switch', { name: '通知音效' }));
    expect(useUIPreferences.getState().comboSoundEnabled).toBe(false);
    expect(useUIPreferences.getState().notifySoundEnabled).toBe(false);
    useUIPreferences.setState({ comboSoundEnabled: true, notifySoundEnabled: true });
  });

  it('开启免打扰模式开关', async () => {
    useUIPreferences.setState({ dndEnabled: false });
    renderWithProviders(<SettingsDialog open onOpenChange={vi.fn()} />);
    await userEvent.click(screen.getByRole('switch', { name: '免打扰模式' }));
    expect(useUIPreferences.getState().dndEnabled).toBe(true);
    useUIPreferences.setState({ dndEnabled: false });
  });

  it('免打扰开启时三个通知开关被标记为不生效并禁用,关闭后恢复', async () => {
    useUIPreferences.setState({ dndEnabled: false });
    renderWithProviders(<SettingsDialog open onOpenChange={vi.fn()} />);
    await userEvent.click(screen.getByRole('switch', { name: '免打扰模式' }));
    // 三个子开关禁用,且每项都显示「不生效」标记
    const runSwitch = screen.getByRole('switch', { name: '任务结束通知' }) as HTMLButtonElement;
    const interactSwitch = screen.getByRole('switch', { name: '交互请求通知' }) as HTMLButtonElement;
    const soundSwitch = screen.getByRole('switch', { name: '通知音效' }) as HTMLButtonElement;
    expect(runSwitch.disabled).toBe(true);
    expect(interactSwitch.disabled).toBe(true);
    expect(soundSwitch.disabled).toBe(true);
    expect(screen.getAllByText(/免打扰模式开启期间不生效/).length).toBe(3);
    // 关闭免打扰后恢复可操作,标记消失
    await userEvent.click(screen.getByRole('switch', { name: '免打扰模式' }));
    expect(runSwitch.disabled).toBe(false);
    expect(interactSwitch.disabled).toBe(false);
    expect(soundSwitch.disabled).toBe(false);
    expect(screen.queryByText(/免打扰模式开启期间不生效/)).toBeNull();
    useUIPreferences.setState({ dndEnabled: false });
  });
});
