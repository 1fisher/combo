import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SettingsDialog } from './SettingsDialog';
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
const attributionToggle = vi.fn();
const commitModelSave = vi.fn();
const contextWindowMutate = vi.fn();

// mock 内用真实 useState,保证开关点击后重渲染与真实 hook 行为一致
vi.mock('../../hooks/useCommitAttribution', async () => {
  const React = await import('react');
  return {
    useCommitAttribution: () => {
      const [enabled, setEnabled] = React.useState(true);
      return {
        enabled,
        isLoading: false,
        toggle: (v: boolean) => {
          setEnabled(v);
          attributionToggle(v);
        },
        isPending: false,
      };
    },
  };
});

// 同样用真实 useState:开启后重渲染出 provider/模型下拉,便于断言选择内容
vi.mock('../../hooks/useCommitModel', async () => {
  const React = await import('react');
  return {
    useCommitModel: () => {
      const [cfg, setCfg] = React.useState<{ enabled: boolean; provider: string | null; model: string | null }>({
        enabled: false,
        provider: null,
        model: null,
      });
      return {
        config: cfg,
        isLoading: false,
        save: (next: { enabled: boolean; provider: string | null; model: string | null }) => {
          setCfg(next);
          commitModelSave(next);
        },
        isPending: false,
        error: null,
      };
    },
  };
});

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
  useSetModelContextWindow: () => ({ mutate: contextWindowMutate, isPending: false }),
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
    contextWindowMutate.mockReset();
    contextWindowMutate.mockResolvedValue({ ok: true });
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
    attributionToggle.mockReset();
    commitModelSave.mockReset();
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

  it('toggles commit attribution switch off and on', async () => {
    renderWithProviders(<SettingsDialog open onOpenChange={vi.fn()} />);
    const sw = screen.getByRole('switch', { name: 'Git 提交署名' });
    expect(sw.getAttribute('aria-checked')).toBe('true');
    await userEvent.click(sw);
    expect(attributionToggle).toHaveBeenCalledWith(false);
    expect(sw.getAttribute('aria-checked')).toBe('false');
    await userEvent.click(sw);
    expect(attributionToggle).toHaveBeenCalledWith(true);
    expect(sw.getAttribute('aria-checked')).toBe('true');
  });

  it('enables global commit model and defaults to first provider model', async () => {
    renderWithProviders(<SettingsDialog open onOpenChange={vi.fn()} />);
    const sw = screen.getByRole('switch', { name: '生成提交信息使用全局模型' });
    expect(sw.getAttribute('aria-checked')).toBe('false');
    await userEvent.click(sw);
    // 开启时未选过 provider:自动选用第一个有模型的 provider 及其第一个模型
    expect(commitModelSave).toHaveBeenCalledWith({
      enabled: true,
      provider: 'opencode',
      model: 'deepseek-v4-flash-free',
    });
    // 开启后渲染 provider/模型下拉并带回所选值
    expect((screen.getByLabelText('提交信息全局模型 Provider') as HTMLSelectElement).value).toBe(
      'opencode',
    );
    expect((screen.getByLabelText('提交信息全局模型') as HTMLSelectElement).value).toBe(
      'deepseek-v4-flash-free',
    );
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
    // 仅切换不修改输入不应写入(保存走后端配置,不再本地存覆盖)
    await userEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(contextWindowMutate).not.toHaveBeenCalled();
    // 设置 1M 并保存:同步写入 combo-cli 配置(新 provider + 当前模型)
    await userEvent.click(screen.getByRole('button', { name: '1M' }));
    await userEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(contextWindowMutate).toHaveBeenCalledWith({
      providerId: 'deepseek',
      modelId: 'deepseek-v4-flash',
      contextWindow: 1_048_576,
    });
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

  it('关闭输入框火焰特效开关', async () => {
    useUIPreferences.setState({ flameEnabled: true });
    renderWithProviders(<SettingsDialog open onOpenChange={vi.fn()} />);
    await userEvent.click(screen.getByRole('switch', { name: '输入框火焰特效' }));
    expect(useUIPreferences.getState().flameEnabled).toBe(false);
    useUIPreferences.setState({ flameEnabled: true });
  });

  it('开启免打扰模式开关', async () => {
    useUIPreferences.setState({ dndEnabled: false });
    renderWithProviders(<SettingsDialog open onOpenChange={vi.fn()} />);
    await userEvent.click(screen.getByRole('switch', { name: '免打扰模式' }));
    expect(useUIPreferences.getState().dndEnabled).toBe(true);
    useUIPreferences.setState({ dndEnabled: false });
  });

  it('免打扰开启时四个通知开关被标记为不生效并禁用,关闭后恢复', async () => {
    useUIPreferences.setState({ dndEnabled: false });
    renderWithProviders(<SettingsDialog open onOpenChange={vi.fn()} />);
    await userEvent.click(screen.getByRole('switch', { name: '免打扰模式' }));
    // 四个子开关禁用,且每项都显示「不生效」标记
    const runSwitch = screen.getByRole('switch', { name: '任务结束通知' }) as HTMLButtonElement;
    const interactSwitch = screen.getByRole('switch', { name: '交互请求通知' }) as HTMLButtonElement;
    const soundSwitch = screen.getByRole('switch', { name: '通知音效' }) as HTMLButtonElement;
    const voiceSwitch = screen.getByRole('switch', { name: '通知语音播报' }) as HTMLButtonElement;
    expect(runSwitch.disabled).toBe(true);
    expect(interactSwitch.disabled).toBe(true);
    expect(soundSwitch.disabled).toBe(true);
    expect(voiceSwitch.disabled).toBe(true);
    expect(screen.getAllByText(/免打扰模式开启期间不生效/).length).toBe(4);
    // 关闭免打扰后恢复可操作,标记消失
    await userEvent.click(screen.getByRole('switch', { name: '免打扰模式' }));
    expect(runSwitch.disabled).toBe(false);
    expect(interactSwitch.disabled).toBe(false);
    expect(soundSwitch.disabled).toBe(false);
    expect(voiceSwitch.disabled).toBe(false);
    expect(screen.queryByText(/免打扰模式开启期间不生效/)).toBeNull();
    useUIPreferences.setState({ dndEnabled: false });
  });

  it('关闭通知语音播报开关(jsdom 无 AudioContext,试听为静默空操作)', async () => {
    useUIPreferences.setState({ notifyVoiceEnabled: true });
    renderWithProviders(<SettingsDialog open onOpenChange={vi.fn()} />);
    await userEvent.click(screen.getByRole('switch', { name: '通知语音播报' }));
    expect(useUIPreferences.getState().notifyVoiceEnabled).toBe(false);
    await userEvent.click(screen.getByRole('button', { name: '试听通知播报' }));
    useUIPreferences.setState({ notifyVoiceEnabled: true });
  });

  // --- 语音朗读(TTS)设置区 ---
  // 注意:与 useSpeechOutput.test.tsx 相同,实现必须走 vi.fn(impl) 构造器传入,
  // 测试基建的 vi.restoreAllMocks() 不会清掉构造器传入的实现。

  it('TTS 无本地模型时直接显示「立即下载」按钮,点击触发模型准备', async () => {
    const speechFetch = vi.fn(async (url: string) => {
      if (url.includes('/v1/speech/status')) {
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              enabled: true,
              ready: false,
              phase: 'not_ready',
              model: 'piper-zh-xiaoya',
              speed: 1,
            }),
        };
      }
      if (url.includes('/v1/speech/prepare')) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) };
      }
      throw new Error(`unexpected url ${url}`);
    });
    vi.stubGlobal('fetch', speechFetch);
    renderWithProviders(<SettingsDialog open onOpenChange={vi.fn()} />);
    const btn = (await screen.findByRole('button', { name: '立即下载' })) as HTMLButtonElement;
    await userEvent.click(btn);
    expect(speechFetch).toHaveBeenCalledWith(
      expect.stringContaining('/v1/speech/prepare'),
      expect.anything()
    );
    vi.unstubAllGlobals();
  });

  it('TTS 模型下载失败时显示错误与「重新下载」按钮,点击可重试', async () => {
    const speechFetch = vi.fn(async (url: string) => {
      if (url.includes('/v1/speech/status')) {
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              enabled: true,
              ready: false,
              phase: 'failed',
              error: '网络超时',
              model: 'piper-zh-xiaoya',
              speed: 1,
            }),
        };
      }
      if (url.includes('/v1/speech/prepare')) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) };
      }
      throw new Error(`unexpected url ${url}`);
    });
    vi.stubGlobal('fetch', speechFetch);
    renderWithProviders(<SettingsDialog open onOpenChange={vi.fn()} />);
    expect(await screen.findByText(/模型下载失败:网络超时/)).toBeTruthy();
    const btn = screen.getByRole('button', { name: '重新下载' }) as HTMLButtonElement;
    await userEvent.click(btn);
    expect(speechFetch).toHaveBeenCalledWith(
      expect.stringContaining('/v1/speech/prepare'),
      expect.anything()
    );
    vi.unstubAllGlobals();
  });

  it('TTS 模型就绪后点击「试听」经 /v1/speech/stream 流式合成并播放', async () => {
    const ndjson = new TextEncoder().encode(
      [
        '{"type":"chunk","seq":1,"hard":true,"sample_rate":22050,"pcm":"' +
          btoa(String.fromCharCode(0, 0, 0x40, 0xc0)) +
          '"}',
        '{"type":"done"}',
      ].join('\n') + '\n',
    );
    const speechFetch = vi.fn(async (url: string) => {
      if (url.includes('/v1/speech/status')) {
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              enabled: true,
              ready: true,
              phase: 'ready',
              model: 'piper-zh-xiaoya',
              speed: 1,
            }),
        };
      }
      if (url.includes('/v1/speech/stream')) {
        let sent = false;
        return {
          ok: true,
          status: 200,
          body: {
            getReader: () => ({
              read: async () => {
                if (sent) return { done: true, value: undefined };
                sent = true;
                return { done: false, value: ndjson };
              },
              cancel: async () => {},
            }),
          },
        };
      }
      throw new Error(`unexpected url ${url}`);
    });
    // jsdom 无 AudioContext:桩实现,createBuffer 供 PCM 解码,
    // start() 后异步触发 onended 完成播放
    class FakeAudioContext {
      state = 'running';
      destination = {};
      currentTime = 50;
      createBuffer(_ch: number, length: number, sampleRate: number) {
        return {
          duration: length / sampleRate,
          length,
          numberOfChannels: 1,
          sampleRate,
          getChannelData: () => new Float32Array(length),
        } as unknown as AudioBuffer;
      }
      createBufferSource() {
        const src: {
          buffer: AudioBuffer | null;
          connect: ReturnType<typeof vi.fn>;
          start: (at?: number) => void;
          onended: (() => void) | null;
        } = {
          buffer: null,
          connect: vi.fn(),
          start: (_at?: number) => {
            setTimeout(() => src.onended?.(), 0);
          },
          onended: null,
        };
        return src;
      }
      resume() {
        return Promise.resolve();
      }
      close() {
        return Promise.resolve();
      }
    }
    vi.stubGlobal('fetch', speechFetch);
    vi.stubGlobal('AudioContext', FakeAudioContext);
    renderWithProviders(<SettingsDialog open onOpenChange={vi.fn()} />);
    await userEvent.click(await screen.findByRole('button', { name: '试听模型音色' }));
    await waitFor(() =>
      expect(speechFetch).toHaveBeenCalledWith(
        expect.stringContaining('/v1/speech/stream'),
        expect.anything()
      )
    );
    vi.unstubAllGlobals();
  });

  it('TTS 切换到未下载模型时刷新状态,「立即下载」按钮出现', async () => {
    let statusCalls = 0;
    const speechFetch = vi.fn(async (url: string) => {
      if (url.includes('/v1/speech/status')) {
        statusCalls += 1;
        // 首次查询为旧模型就绪;切换模型后返回新模型未就绪
        const ready = statusCalls <= 1;
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              enabled: true,
              ready,
              phase: ready ? 'ready' : 'not_ready',
              model: ready ? 'piper-zh-xiaoya' : 'piper-zh-chaowen',
              speed: 1,
            }),
        };
      }
      if (url.includes('/v1/speech/model')) {
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({ ok: true, model: 'piper-zh-chaowen', phase: 'not_ready' }),
        };
      }
      throw new Error(`unexpected url ${url}`);
    });
    vi.stubGlobal('fetch', speechFetch);
    renderWithProviders(<SettingsDialog open onOpenChange={vi.fn()} />);
    await screen.findByLabelText('选择语音朗读模型');
    // 旧模型已就绪 → 不显示下载按钮
    expect(screen.queryByRole('button', { name: '立即下载' })).toBeNull();
    // 切换到未下载的新模型 → 状态刷新后出现下载按钮
    await userEvent.selectOptions(screen.getByLabelText('选择语音朗读模型'), 'piper-zh-chaowen');
    expect(await screen.findByRole('button', { name: '立即下载' })).toBeTruthy();
    vi.unstubAllGlobals();
  });
});

describe('SettingsDialog 分组 Tab', () => {
  it('六个分组 tab 均渲染,默认激活「模型」,点击切换激活态', async () => {
    renderWithProviders(<SettingsDialog open onOpenChange={vi.fn()} />);
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual([
      '模型',
      '语音',
      '通知',
      'Git',
      '连接',
      '通用',
    ]);
    expect(screen.getByRole('tab', { name: '模型' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: '语音' }).getAttribute('aria-selected')).toBe('false');
    await userEvent.click(screen.getByRole('tab', { name: '语音' }));
    expect(screen.getByRole('tab', { name: '语音' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: '模型' }).getAttribute('aria-selected')).toBe('false');
  });

  it('非激活分组仅 CSS 隐藏、内容常驻挂载:未切 tab 也能查到其他分组内容', () => {
    renderWithProviders(<SettingsDialog open onOpenChange={vi.fn()} />);
    // 默认 tab 为「模型」,其余分组经 forceMount 常驻(切 tab 不丢状态、保存始终可提交)
    expect(screen.getAllByRole('tabpanel')).toHaveLength(6);
    expect(screen.getByRole('tabpanel', { name: '模型' }).dataset.state).toBe('active');
    expect(screen.getByRole('tabpanel', { name: '连接' }).dataset.state).toBe('inactive');
    // 连接(代理地址)/ 通知(免打扰)/ Git(署名)分组内容仍可直接查询
    expect(screen.getByPlaceholderText('http://127.0.0.1:18236')).toBeTruthy();
    expect(screen.getByRole('switch', { name: '免打扰模式' })).toBeTruthy();
    expect(screen.getByRole('switch', { name: 'Git 提交署名' })).toBeTruthy();
  });
});
