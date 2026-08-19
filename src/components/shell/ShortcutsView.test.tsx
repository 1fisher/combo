import { beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ShortcutsView } from './ShortcutsView';
import { defaultBindings } from '../../lib/shortcuts';
import { useShortcutStore } from '../../stores/shortcutStore';

/** 在 window 上派发 keydown(录制监听挂在 window 捕获阶段;act 内派发以同步刷新 React) */
function press(key: string, init: KeyboardEventInit = {}) {
  const ev = new KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  act(() => {
    window.dispatchEvent(ev);
  });
  return ev;
}

beforeEach(() => {
  cleanup();
  useShortcutStore.setState({ bindings: defaultBindings() });
});

describe('ShortcutsView', () => {
  it('渲染全部可配置动作与默认键位', () => {
    render(<ShortcutsView />);
    expect(screen.getByText('新建任务')).toBeTruthy();
    expect(screen.getByText('知识图谱')).toBeTruthy();
    expect(screen.getByText('语音输入')).toBeTruthy();
    // 默认绑定展示(automation = ⌘ A)
    const btn = screen.getByTestId('shortcut-binding-view:automation');
    expect(btn.textContent).toContain('⌘');
    expect(btn.textContent).toContain('A');
  });

  it('点击键位进入录制,按下新组合后保存并展示', () => {
    render(<ShortcutsView />);
    const btn = screen.getByTestId('shortcut-binding-view:search');
    fireEvent.click(btn);
    expect(btn.textContent).toContain('按下新组合');
    press('P', { metaKey: true, shiftKey: true });
    expect(useShortcutStore.getState().bindings['view:search']).toBe('⇧p');
    expect(btn.textContent).toContain('⌘');
    expect(btn.textContent).toContain('⇧');
    expect(btn.textContent).toContain('P');
  });

  it('录制与已占用组合冲突时拒绝保存并提示', () => {
    render(<ShortcutsView />);
    const btn = screen.getByTestId('shortcut-binding-view:search');
    fireEvent.click(btn);
    press('A', { metaKey: true }); // ⌘A 已被「自动化」占用
    expect(useShortcutStore.getState().bindings['view:search']).toBe('k');
    const conflict = screen.getByTestId('shortcut-conflict');
    expect(conflict.textContent).toContain('自动化');
  });

  it('录制时 Backspace 清除绑定(禁用),Escape 取消', () => {
    render(<ShortcutsView />);
    const btn = screen.getByTestId('shortcut-binding-newTask');
    fireEvent.click(btn);
    press('Backspace');
    expect(useShortcutStore.getState().bindings.newTask).toBeNull();
    expect(btn.textContent).toContain('已禁用');

    // Escape 取消:不改变绑定
    fireEvent.click(btn); // 再次进入录制
    expect(btn.textContent).toContain('按下新组合');
    press('Escape');
    expect(btn.textContent).not.toContain('按下新组合');
    expect(useShortcutStore.getState().bindings.newTask).toBeNull();
  });

  it('无 ⌘/Ctrl 的组合提示不支持', () => {
    render(<ShortcutsView />);
    fireEvent.click(screen.getByTestId('shortcut-binding-view:graph'));
    press('z');
    expect(useShortcutStore.getState().bindings['view:graph']).toBe('⇧g');
    expect(screen.getByTestId('shortcut-conflict').textContent).toContain('⌘/Ctrl');
  });

  it('「恢复默认」重置全部自定义', () => {
    render(<ShortcutsView />);
    // 经 UI 录制一个自定义(⇧X),使「恢复默认」可用
    fireEvent.click(screen.getByTestId('shortcut-binding-view:mcp'));
    press('X', { metaKey: true, shiftKey: true });
    expect(useShortcutStore.getState().bindings['view:mcp']).toBe('⇧x');
    fireEvent.click(screen.getByRole('button', { name: '恢复默认' }));
    expect(useShortcutStore.getState().bindings).toEqual(defaultBindings());
  });
});
