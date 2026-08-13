import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SettingsDialog } from './SettingsDialog';
import { useAgentStore } from '../../stores/agentStore';
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
const removeKeyMutate = vi.fn();

vi.mock('../../hooks/useAgentModel', () => ({
  useProviders: () => ({
    data: [
      {
        id: 'opencode',
        name: 'OpenCode Zen',
        type: 'openai-compat',
        has_api_key: true,
        api_key_masked: 'sk-a****1234',
        api_keys_masked: ['sk-a****1234', 'sk-b****5678'],
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
    ],
  }),
  useFetchModels: () => ({ mutateAsync: fetchModelsMutate, isPending: false }),
  useSaveProviderKey: () => ({ mutateAsync: saveKeyMutate, isPending: false }),
  useProviderKeys: () => ({
    add: { mutateAsync: addKeyMutate, isPending: false },
    activate: { mutateAsync: activateKeyMutate, isPending: false },
    remove: { mutateAsync: removeKeyMutate, isPending: false },
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
    removeKeyMutate.mockReset();
    removeKeyMutate.mockResolvedValue({ ok: true });
    // confirmDialog 在浏览器模式走 window.confirm
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });

  it('saves the proxy url override to localStorage', async () => {
    renderWithProviders(<SettingsDialog open onOpenChange={vi.fn()} />);
    const input = screen.getByPlaceholderText('http://127.0.0.1:18234');
    await userEvent.clear(input);
    await userEvent.type(input, 'http://10.0.0.5:18234');
    await userEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(getProxyUrlOverride()).toBe('http://10.0.0.5:18234');
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

  it('disables fetch for provider without key and empty input', async () => {
    renderWithProviders(<SettingsDialog open onOpenChange={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /DeepSeek/ }));
    const fetchBtn = screen.getAllByRole('button', { name: '拉取模型' })[0] as HTMLButtonElement;
    expect(fetchBtn.disabled).toBe(true);
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
});
