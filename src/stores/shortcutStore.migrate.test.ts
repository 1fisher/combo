import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * v2 迁移:automation 默认键 'a'(⌘A,与原生全选冲突)改为 '⇧a'。
 * 旧持久化里仍是旧默认 'a' 的自动迁移;用户显式自定义的键位保留。
 * persist rehydrate 是同步的,写入 localStorage 后动态 import 即可触发。
 */
describe('shortcutStore 持久化迁移(v1 → v2)', () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
  });

  it('v1 旧默认 ⌘A(a)自动迁移为 ⇧a', async () => {
    localStorage.setItem(
      'combo.shortcuts',
      JSON.stringify({ state: { bindings: { 'view:automation': 'a' } }, version: 1 }),
    );
    const { useShortcutStore } = await import('./shortcutStore');
    expect(useShortcutStore.getState().bindings['view:automation']).toBe('⇧a');
  });

  it('用户显式自定义的键位保留,不被迁移', async () => {
    localStorage.setItem(
      'combo.shortcuts',
      JSON.stringify({ state: { bindings: { 'view:automation': '⇧z' } }, version: 1 }),
    );
    const { useShortcutStore } = await import('./shortcutStore');
    expect(useShortcutStore.getState().bindings['view:automation']).toBe('⇧z');
  });

  it('v2 数据不再走迁移,禁用(null)保留', async () => {
    localStorage.setItem(
      'combo.shortcuts',
      JSON.stringify({ state: { bindings: { 'view:automation': null } }, version: 2 }),
    );
    const { useShortcutStore } = await import('./shortcutStore');
    expect(useShortcutStore.getState().bindings['view:automation']).toBeNull();
  });
});
