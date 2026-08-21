import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ProviderPicker } from './ProviderPicker';

const PROVIDERS = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    type: 'openai',
    has_api_key: true,
    models: [{ id: 'deepseek-chat' }],
  },
  {
    id: 'opencode',
    name: 'OpenCode Zen',
    type: 'openai-compat',
    has_api_key: false,
    models: [{ id: 'glm-5.2' }],
  },
] as never[];

describe('ProviderPicker 表单形态', () => {
  it('未选中时显示占位,搜索过滤后可选中并回显', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(
      <ProviderPicker providers={PROVIDERS} value="" onChange={onChange} />,
    );

    // 未选中:触发器显示占位文案
    const trigger = screen.getByRole('button', { name: '选择 Provider' });
    expect(trigger.textContent).toContain('选择 Provider');

    // 打开弹层,搜索过滤后只剩 DeepSeek
    await user.click(trigger);
    await user.type(screen.getByPlaceholderText('搜索 Provider'), 'deep');
    expect(screen.queryByText('OpenCode Zen')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'DeepSeek' }));
    expect(onChange).toHaveBeenCalledWith('deepseek');

    // 选中后触发器回显 provider 名称
    rerender(<ProviderPicker providers={PROVIDERS} value="deepseek" onChange={onChange} />);
    expect(screen.getByRole('button', { name: '选择 Provider' }).textContent).toContain('DeepSeek');
  });

  it('未配置 Key 的 provider 显示提示标记', async () => {
    const user = userEvent.setup();
    render(<ProviderPicker providers={PROVIDERS} value="" onChange={() => {}} />);
    await user.click(screen.getByRole('button', { name: '选择 Provider' }));
    expect(screen.getByText('未配置 Key')).toBeTruthy();
  });
});
