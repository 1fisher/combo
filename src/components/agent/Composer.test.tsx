import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Composer } from './Composer';
import { useAgentStore } from '../../stores/agentStore';

// ⌘/Ctrl+I 快捷键测试用:捕获 dictation.toggle 调用(vi.mock 会被提升,需 hoisted)
const { dictationToggle } = vi.hoisted(() => ({ dictationToggle: vi.fn() }));

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

// 听写 hook 打桩:快捷键测试只关心 toggle 是否被触发
vi.mock('../../hooks/useDictation', () => ({
  useDictation: () => ({
    state: 'idle',
    seconds: 0,
    confirmedText: '',
    partialText: '',
    modelProgress: null,
    error: '',
    errorAction: null,
    toggle: dictationToggle,
    cancel: vi.fn(),
  }),
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

  it('可从最近使用中删除单个条目,不影响当前选中模型', async () => {
    useAgentStore.setState({
      recentModels: [
        { model: 'same-model', provider: 'opencode' },
        { model: 'same-model', provider: 'deepseek' },
      ],
    });
    const user = userEvent.setup();
    renderComposer();
    await user.click(screen.getByRole('button', { name: '切换模型' }));
    expect(screen.getByText('最近使用')).toBeTruthy();

    // 删除 opencode 条目:同名模型靠 provider 区分,deepseek 条目保留
    await user.click(
      screen.getByRole('button', { name: '从最近使用中移除 same-model(OpenCode Zen)' })
    );
    expect(useAgentStore.getState().recentModels).toEqual([
      { model: 'same-model', provider: 'deepseek' },
    ]);
    expect(screen.getByText('最近使用')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'same-model DeepSeek' })).toBeTruthy();

    // 删除最后一条:分区整体隐藏;菜单保持打开,分组列表不受影响
    await user.click(
      screen.getByRole('button', { name: '从最近使用中移除 same-model(DeepSeek)' })
    );
    expect(useAgentStore.getState().recentModels).toEqual([]);
    expect(screen.queryByText('最近使用')).toBeNull();
    expect(screen.getByText('DeepSeek')).toBeTruthy();

    // 删除操作不触发模型切换,选中态不变
    expect(useAgentStore.getState().modelSelections['ws-1']).toEqual({
      model: 'same-model',
      provider: 'deepseek',
    });
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

  it('移动端:模型菜单 fixed 定位并钳制在视口内,不向左溢出', async () => {
    // 模拟 375px 宽移动端视口;锚点按钮位于屏幕中间偏左(右边缘 194px),
    // 288px 宽菜单若沿用 right-0 会向左溢出到 -94px(显示不全)
    const mm = {
      matches: true,
      media: '(max-width: 767px)',
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    } as unknown as MediaQueryList;
    vi.spyOn(window, 'matchMedia').mockReturnValue(mm);
    const rect = {
      left: 162, right: 194, top: 600, bottom: 628, width: 32, height: 28, x: 162, y: 600,
      toJSON: () => ({}),
    } as DOMRect;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(rect);

    const user = userEvent.setup();
    renderComposer();
    await user.click(screen.getByRole('button', { name: '切换模型' }));

    const menu = screen.getByPlaceholderText('搜索模型').closest('.bg-popover') as HTMLElement;
    expect(menu).toBeTruthy();
    // 移动端改用 fixed,水平钳制到视口左缘 8px(而非溢出),垂直贴合锚点上方
    expect(menu.className).toContain('fixed');
    expect(menu.style.left).toBe('8px');
    expect(menu.style.bottom).toBe(`${window.innerHeight - 600 + 8}px`);
    // 菜单右缘仍在视口内(左侧 8 + 宽 288)
    expect(menu.getBoundingClientRect().right).toBeLessThanOrEqual(window.innerWidth - 8);
  });
});

describe('Composer 模式指示(仅「完全访问」)', () => {
  it('工具栏静态显示「完全访问」,不再提供模式切换菜单', () => {
    renderComposer();

    // 静态指示存在,且不是可点击按钮
    const indicator = screen.getByLabelText('模式:完全访问');
    expect(indicator.tagName).toBe('DIV');
    expect(screen.queryByRole('button', { name: '切换模式' })).toBeNull();

    // 已移除的模式不再出现
    expect(screen.queryByText('自动编辑')).toBeNull();
    expect(screen.queryByText('变更前确认')).toBeNull();
    expect(screen.queryByText('计划模式')).toBeNull();
    expect(screen.getByText('完全访问')).toBeTruthy();
  });
});

/** 在 window 上派发 ⌘(macOS)/Ctrl 组合键 */
function pressCombo(key: string, opts: KeyboardEventInit = {}) {
  const ev = new KeyboardEvent('keydown', {
    key,
    metaKey: true,
    bubbles: true,
    cancelable: true,
    ...opts,
  });
  window.dispatchEvent(ev);
  return ev;
}

describe('Composer 语音输入快捷键(⌘/Ctrl+I)', () => {
  beforeEach(() => {
    dictationToggle.mockClear();
  });

  it('⌘I / Ctrl+I 触发语音输入开关', () => {
    renderComposer();
    const ev = pressCombo('i');
    expect(ev.defaultPrevented).toBe(true);
    expect(dictationToggle).toHaveBeenCalledTimes(1);

    const ctrlEv = pressCombo('i', { metaKey: false, ctrlKey: true });
    expect(ctrlEv.defaultPrevented).toBe(true);
    expect(dictationToggle).toHaveBeenCalledTimes(2);
  });

  it('Shift/Alt 变体与无修饰键不触发(让位浏览器开发者工具 ⌘⇧I 等)', () => {
    renderComposer();
    expect(pressCombo('i', { shiftKey: true }).defaultPrevented).toBe(false);
    expect(pressCombo('i', { altKey: true }).defaultPrevented).toBe(false);
    expect(pressCombo('i', { metaKey: false }).defaultPrevented).toBe(false);
    expect(pressCombo('k').defaultPrevented).toBe(false);
    expect(dictationToggle).not.toHaveBeenCalled();
  });

  it('已被其他组件处理的按键(defaultPrevented)不重复触发', () => {
    renderComposer();
    // 先挂一个捕获阶段监听抢先 preventDefault,模拟编辑器等组件已处理
    const swallow = (e: KeyboardEvent) => e.preventDefault();
    window.addEventListener('keydown', swallow, { capture: true });
    const ev = pressCombo('i');
    window.removeEventListener('keydown', swallow, { capture: true });
    expect(ev.defaultPrevented).toBe(true);
    expect(dictationToggle).not.toHaveBeenCalled();
  });
});
