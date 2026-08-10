import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SettingsDialog } from './SettingsDialog';
import {
  clearExternalUrl,
  clearProxyUrlOverride,
  getExternalUrl,
  getProxyUrlOverride,
} from '../../lib/connection';

const fetchModelsMutate = vi.fn();

vi.mock('../../hooks/useAgentModel', () => ({
  useProviders: () => ({
    data: [
      {
        id: 'opencode',
        name: 'OpenCode Zen',
        type: 'openai-compat',
        has_api_key: true,
        api_key_masked: 'sk-a****1234',
        models: [{ id: 'deepseek-v4-flash-free', name: 'deepseek-v4-flash-free' }],
      },
      { id: 'zhipu', name: 'Zhipu', type: 'openai', has_api_key: true, models: [] },
      { id: 'deepseek', name: 'DeepSeek', type: 'openai', has_api_key: false, models: [] },
    ],
  }),
  useFetchModels: () => ({ mutateAsync: fetchModelsMutate, isPending: false }),
  useSaveProviderKey: () => ({ mutateAsync: vi.fn().mockResolvedValue({ ok: true }), isPending: false }),
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

  it('disables fetch for provider without key and empty input', async () => {
    renderWithProviders(<SettingsDialog open onOpenChange={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /DeepSeek/ }));
    const fetchBtn = screen.getAllByRole('button', { name: '拉取模型' })[0] as HTMLButtonElement;
    expect(fetchBtn.disabled).toBe(true);
  });
});
