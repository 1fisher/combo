import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ModelPicker } from './ModelPicker';
import { useAgentStore } from '../../stores/agentStore';

const PROVIDERS = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    type: 'openai',
    has_api_key: true,
    models: [
      { id: 'deepseek-chat', name: 'DeepSeek Chat' },
      { id: 'deepseek-reasoner', name: 'DeepSeek R1' },
    ],
  },
  {
    id: 'opencode',
    name: 'OpenCode Zen',
    type: 'openai-compat',
    has_api_key: true,
    models: [{ id: 'glm-5.2', name: 'GLM-5.2' }],
  },
];

describe('ModelPicker 表单形态(variant="form")', () => {
  beforeEach(() => {
    useAgentStore.setState({ recentModels: [] });
  });

  it('未选中时触发器显示「跟随项目默认」,菜单顶部清除项为选中态', async () => {
    const user = userEvent.setup();
    render(
      <ModelPicker
        variant="form"
        providers={PROVIDERS}
        selected={null}
        onSelect={() => {}}
        onClear={() => {}}
      />
    );

    // form 触发器带 aria-label「切换模型」,内容含「跟随项目默认」
    expect(screen.getByRole('button', { name: '切换模型' }).textContent).toContain(
      '跟随项目默认'
    );
    await user.click(screen.getByRole('button', { name: '切换模型' }));

    // 清除项在列表顶部且带选中(Check)标记
    const clearBtn = screen.getByRole('button', { name: '跟随项目默认' });
    expect(clearBtn.querySelector('svg')).toBeTruthy();
    // 分组照常渲染
    expect(screen.getByText('DeepSeek')).toBeTruthy();
    expect(screen.getByText('OpenCode Zen')).toBeTruthy();
  });

  it('选中模型后触发器显示模型名 + provider,并写入最近使用', async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(
      <ModelPicker
        variant="form"
        providers={PROVIDERS}
        selected={null}
        onSelect={onSelect}
        onClear={() => {}}
      />
    );
    await user.click(screen.getByRole('button', { name: '切换模型' }));
    await user.click(screen.getByRole('button', { name: 'GLM-5.2' }));

    expect(onSelect).toHaveBeenCalledWith('opencode', 'glm-5.2');
    // 选中写入全局最近使用(与 Composer 行为一致)
    expect(useAgentStore.getState().recentModels).toEqual([
      { model: 'glm-5.2', provider: 'opencode' },
    ]);
    // 菜单关闭
    expect(screen.queryByPlaceholderText('搜索模型')).toBeNull();

    // 受控场景:父组件把选中回填后,触发器显示模型名与 provider 名
    rerender(
      <ModelPicker
        variant="form"
        providers={PROVIDERS}
        selected={{ provider: 'opencode', model: 'glm-5.2' }}
        onSelect={onSelect}
        onClear={() => {}}
      />
    );
    expect(screen.getByRole('button', { name: '切换模型' }).textContent).toContain('GLM-5.2');
    expect(screen.getByRole('button', { name: '切换模型' }).textContent).toContain(
      'OpenCode Zen'
    );
  });

  it('点击「跟随项目默认」清除已选模型并关闭菜单', async () => {
    const onClear = vi.fn();
    const user = userEvent.setup();
    render(
      <ModelPicker
        variant="form"
        providers={PROVIDERS}
        selected={{ provider: 'deepseek', model: 'deepseek-chat' }}
        onSelect={() => {}}
        onClear={onClear}
      />
    );
    await user.click(screen.getByRole('button', { name: '切换模型' }));
    await user.click(screen.getByRole('button', { name: '跟随项目默认' }));

    expect(onClear).toHaveBeenCalledTimes(1);
    expect(screen.queryByPlaceholderText('搜索模型')).toBeNull();
  });

  it('搜索过滤分组与最近使用,无匹配提示未找到', async () => {
    useAgentStore.setState({
      recentModels: [{ model: 'glm-5.2', provider: 'opencode' }],
    });
    const user = userEvent.setup();
    render(
      <ModelPicker
        variant="form"
        providers={PROVIDERS}
        selected={null}
        onSelect={() => {}}
        onClear={() => {}}
      />
    );
    await user.click(screen.getByRole('button', { name: '切换模型' }));
    expect(screen.getByText('最近使用')).toBeTruthy();

    // 命中:分组与最近使用都保留(「OpenCode Zen」出现在分组头与最近使用条目两处)
    await user.type(screen.getByPlaceholderText('搜索模型'), 'glm');
    expect(screen.getByText('最近使用')).toBeTruthy();
    expect(screen.getAllByText('OpenCode Zen').length).toBeGreaterThan(0);
    expect(screen.queryByText('DeepSeek Chat')).toBeNull();

    // 无匹配:整体提示
    await user.clear(screen.getByPlaceholderText('搜索模型'));
    await user.type(screen.getByPlaceholderText('搜索模型'), 'zzz');
    expect(screen.queryByText('最近使用')).toBeNull();
    expect(screen.getByText('未找到匹配的模型。')).toBeTruthy();
  });

  it('已保存模型不在当前 provider 列表时,触发器仍显示原始 id 便于察觉更换', () => {
    render(
      <ModelPicker
        variant="form"
        providers={PROVIDERS}
        selected={{ provider: 'gone-provider', model: 'gone-model' }}
        onSelect={() => {}}
        onClear={() => {}}
      />
    );
    const label = screen.getByRole('button', { name: '切换模型' }).textContent ?? '';
    expect(label).toContain('gone-model');
    expect(label).toContain('gone-provider');
  });

  it('providerFilter 只列出该 provider 的模型(与独立 Provider 选择器搭配)', async () => {
    const user = userEvent.setup();
    render(
      <ModelPicker
        variant="form"
        providers={PROVIDERS}
        providerFilter="deepseek"
        selected={{ provider: 'deepseek', model: 'deepseek-chat' }}
        onSelect={() => {}}
      />
    );
    await user.click(screen.getByRole('button', { name: '切换模型' }));
    // 菜单列表内只有 DeepSeek 分组;其它 provider 的分组与模型被过滤掉
    const menu = screen.getByTestId('model-menu-list');
    expect(within(menu).getByText('DeepSeek')).toBeTruthy();
    expect(within(menu).queryByText('OpenCode Zen')).toBeNull();
    expect(within(menu).queryByRole('button', { name: 'GLM-5.2' })).toBeNull();
  });

  it('composer 形态:未选中显示「默认模型」,选中显示模型 id', () => {
    const { rerender } = render(
      <ModelPicker providers={PROVIDERS} selected={null} onSelect={() => {}} />
    );
    expect(screen.getByRole('button', { name: '切换模型' }).textContent).toContain('默认模型');

    rerender(
      <ModelPicker
        providers={PROVIDERS}
        selected={{ provider: 'deepseek', model: 'deepseek-chat' }}
        onSelect={() => {}}
      />
    );
    expect(screen.getByRole('button', { name: '切换模型' }).textContent).toContain(
      'deepseek-chat'
    );
  });
});
