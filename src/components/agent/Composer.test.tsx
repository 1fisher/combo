import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Composer } from './Composer';
import { useAgentStore } from '../../stores/agentStore';

// 与模型菜单渲染无关的 hooks 全部打桩,专注验证「不同 provider 同名模型」的选中态
vi.mock('../../hooks/useMention', () => ({
  useMention: () => ({
    mention: null,
    activeIndex: -1,
    setActiveIndex: () => {},
    select: () => undefined,
    handleKey: () => false,
  }),
}));

vi.mock('../../hooks/useFileIndex', () => ({
  useFileIndex: () => ({ files: [] }),
}));

vi.mock('../../hooks/useSkills', () => ({
  useSkills: () => ({ data: [] }),
  useWorkspaceDisabledSkills: () => ({ disabledSkills: [] }),
}));

vi.mock('../../hooks/useSessions', () => ({
  useSessions: () => ({ sessions: [], create: vi.fn() }),
}));

vi.mock('../../hooks/useAgentModel', () => ({
  useAgentInfo: () => ({ data: null }),
  // deepseek 与 opencode 下各有一个 id 完全相同的模型
  useProviders: () => ({
    data: [
      {
        id: 'deepseek',
        name: 'DeepSeek',
        type: 'openai',
        has_api_key: true,
        models: [{ id: 'same-model', name: 'same-model' }],
      },
      {
        id: 'opencode',
        name: 'OpenCode Zen',
        type: 'openai-compat',
        has_api_key: true,
        models: [{ id: 'same-model', name: 'same-model' }],
      },
    ],
  }),
  useWorkspaceConfig: () => ({ data: null }),
  useSetModel: () => ({ mutate: vi.fn(), isPending: false }),
}));

function renderComposer() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <Composer workspaceId="ws-1" value="" onChange={() => {}} onSend={() => {}} />
    </QueryClientProvider>
  );
}

describe('Composer 模型选择', () => {
  beforeEach(() => {
    useAgentStore.setState({
      modelSelections: {
        'ws-1': { model: 'same-model', provider: 'deepseek' },
      },
      recentModels: [],
    });
  });

  it('不同 provider 存在同名模型时,只高亮当前 provider 对应的模型', async () => {
    const user = userEvent.setup();
    renderComposer();
    await user.click(screen.getByRole('button', { name: '切换模型' }));

    // 两个 provider 下各有一个 same-model
    const modelButtons = screen.getAllByRole('button', { name: 'same-model' });
    expect(modelButtons).toHaveLength(2);

    // 只有选中的 provider(deepseek)那一项带 Check 图标,opencode 的同名模型不应显示为选中
    const withCheck = modelButtons.filter((b) => b.querySelector('svg'));
    expect(withCheck).toHaveLength(1);
    expect(withCheck[0].textContent).toContain('same-model');
  });

  it('点击另一个 provider 的同名模型后,选中态只跟随新的 provider', async () => {
    const user = userEvent.setup();
    renderComposer();
    await user.click(screen.getByRole('button', { name: '切换模型' }));

    const modelButtons = screen.getAllByRole('button', { name: 'same-model' });
    // 初始 deepseek 组选中
    expect(modelButtons.filter((b) => b.querySelector('svg'))).toHaveLength(1);

    // 切换到 opencode 组的同名模型
    await user.click(modelButtons[1]);
    await user.click(screen.getByRole('button', { name: '切换模型' }));

    const sel = useAgentStore.getState().modelSelections['ws-1'];
    expect(sel).toEqual({ model: 'same-model', provider: 'opencode' });

    const after = screen.getAllByRole('button', { name: 'same-model' });
    expect(after.filter((b) => b.querySelector('svg'))).toHaveLength(1);
  });

  it('搜索框固定在弹层顶部,不随模型列表滚动', async () => {
    const user = userEvent.setup();
    renderComposer();
    await user.click(screen.getByRole('button', { name: '切换模型' }));

    // 模型列表为独立滚动容器,搜索框位于其外(滚动列表时搜索框保持可见)
    const list = screen.getByTestId('model-menu-list');
    expect(list.className).toContain('overflow-y-auto');
    const search = screen.getByPlaceholderText('搜索模型');
    expect(list.contains(search)).toBe(false);
  });

  it('切换模型后,「最近使用」分区置顶展示最新选择', async () => {
    const user = userEvent.setup();
    renderComposer();
    await user.click(screen.getByRole('button', { name: '切换模型' }));
    // 初始没有最近使用记录,不显示该分区
    expect(screen.queryByText('最近使用')).toBeNull();

    // 切换到 opencode 的同名模型
    await user.click(screen.getAllByRole('button', { name: 'same-model' })[1]);
    expect(useAgentStore.getState().recentModels).toEqual([
      { model: 'same-model', provider: 'opencode' },
    ]);

    // 重新打开:顶部出现「最近使用」,条目带 provider 名便于区分同名模型
    await user.click(screen.getByRole('button', { name: '切换模型' }));
    expect(screen.getByText('最近使用')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'same-model OpenCode Zen' })).toBeTruthy();
  });

  it('点击「最近使用」中的模型可直接切换', async () => {
    useAgentStore.setState({
      recentModels: [{ model: 'same-model', provider: 'opencode' }],
    });
    const user = userEvent.setup();
    renderComposer();
    await user.click(screen.getByRole('button', { name: '切换模型' }));

    await user.click(screen.getByRole('button', { name: 'same-model OpenCode Zen' }));
    const sel = useAgentStore.getState().modelSelections['ws-1'];
    expect(sel).toEqual({ model: 'same-model', provider: 'opencode' });
  });

  it('搜索时「最近使用」分区随关键词过滤,无匹配则整体隐藏', async () => {
    useAgentStore.setState({
      recentModels: [{ model: 'same-model', provider: 'opencode' }],
    });
    const user = userEvent.setup();
    renderComposer();
    await user.click(screen.getByRole('button', { name: '切换模型' }));
    expect(screen.getByText('最近使用')).toBeTruthy();

    // 命中模型名:分区保留
    await user.type(screen.getByPlaceholderText('搜索模型'), 'same');
    expect(screen.getByText('最近使用')).toBeTruthy();

    // 无匹配:分区隐藏并提示未找到
    await user.clear(screen.getByPlaceholderText('搜索模型'));
    await user.type(screen.getByPlaceholderText('搜索模型'), 'zzz');
    expect(screen.queryByText('最近使用')).toBeNull();
    expect(screen.getByText('未找到匹配的模型。')).toBeTruthy();
  });
});
