import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  SHORTCUT_ACTIONS,
  defaultBindings,
  type ShortcutAction,
  type ShortcutBindings,
} from '../lib/shortcuts';

/**
 * 全局快捷键绑定:用户自定义组合键,持久化到 localStorage(`combo.shortcuts`)。
 * 值为 null 表示该动作快捷键被禁用。所有监听方(sidebar / Composer 等)
 * 订阅 bindings 后经 `resolveShortcut` 分派。
 */
interface ShortcutState {
  bindings: ShortcutBindings;
  setBinding: (id: ShortcutAction, combo: string | null) => void;
  resetAll: () => void;
}

export const useShortcutStore = create<ShortcutState>()(
  persist(
    (set) => ({
      bindings: defaultBindings(),
      setBinding: (id, combo) =>
        set((st) => ({ bindings: { ...st.bindings, [id]: combo } })),
      resetAll: () => set({ bindings: defaultBindings() }),
    }),
    {
      name: 'combo.shortcuts',
      version: 2,
      // v2:automation 默认键 'a'(⌘A 与全选冲突)改为 '⇧a'——旧持久化里仍是
      // 旧默认 'a' 的自动迁移;用户显式改过其他键(或禁用)的保留不动
      migrate: (persisted) => {
        const saved = (persisted as Partial<Pick<ShortcutState, 'bindings'>> | undefined)
          ?.bindings;
        if (saved && saved['view:automation'] === 'a') {
          saved['view:automation'] = '⇧a';
        }
        return persisted as ShortcutState;
      },
      // 新增动作时旧持久化数据缺键,合并默认值兜底
      merge: (persisted, current) => {
        const saved = (persisted as Partial<Pick<ShortcutState, 'bindings'>> | undefined)
          ?.bindings;
        return {
          ...current,
          bindings: { ...defaultBindings(), ...(saved ?? {}) },
        };
      },
    },
  ),
);

/** 兼容快捷选择器:已解析(含默认值合并)的绑定表 */
export function useShortcutBindings(): ShortcutBindings {
  return useShortcutStore((s) => s.bindings);
}

/** 供测试注入绑定(模拟用户自定义) */
export function __setBindingsForTest(b: Partial<ShortcutBindings>) {
  useShortcutStore.setState((st) => ({ bindings: { ...st.bindings, ...b } }));
}

/** 全部可配置动作 id(顺序与 SHORTCUT_ACTIONS 一致) */
export const ALL_SHORTCUT_IDS = SHORTCUT_ACTIONS.map((a) => a.id) as ShortcutAction[];
