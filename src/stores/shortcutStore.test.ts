import { beforeEach, describe, expect, it } from 'vitest';
import { defaultBindings } from '../lib/shortcuts';
import { useShortcutStore } from './shortcutStore';

beforeEach(() => {
  // 回到默认绑定(清持久化由 test-setup 的 localStorage 清空 + 手动重置共同保证)
  useShortcutStore.setState({ bindings: defaultBindings() });
});

describe('shortcutStore', () => {
  it('初始为默认绑定', () => {
    const { bindings } = useShortcutStore.getState();
    expect(bindings['view:search']).toBe('k');
    expect(bindings['view:skills']).toBe('⇧s');
    expect(bindings.dictation).toBe('i');
  });

  it('setBinding 更新单个动作(含禁用 null)', () => {
    useShortcutStore.getState().setBinding('view:search', '⇧p');
    expect(useShortcutStore.getState().bindings['view:search']).toBe('⇧p');
    useShortcutStore.getState().setBinding('view:search', null);
    expect(useShortcutStore.getState().bindings['view:search']).toBeNull();
    // 其他动作不受影响
    expect(useShortcutStore.getState().bindings['view:skills']).toBe('⇧s');
  });

  it('resetAll 恢复全部默认', () => {
    useShortcutStore.getState().setBinding('newTask', '⇧n');
    useShortcutStore.getState().setBinding('view:mcp', null);
    useShortcutStore.getState().resetAll();
    expect(useShortcutStore.getState().bindings).toEqual(defaultBindings());
  });
});
