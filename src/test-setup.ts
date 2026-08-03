// vitest + jsdom 25 + Node 26 下 window.localStorage getter 返回 undefined,
// 导致 zustand persist / clientId 等依赖 localStorage 的测试全部失败。
// 这里在测试环境里补一个内存版 localStorage。
import { vi } from 'vitest';

if (typeof globalThis.localStorage === 'undefined') {
  const store = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (k) => store.get(String(k)) ?? null,
    key: (i) => [...store.keys()][i] ?? null,
    removeItem: (k) => void store.delete(String(k)),
    setItem: (k, v) => void store.set(String(k), String(v)),
  };
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: storage,
  });
  Object.defineProperty(globalThis.window, 'localStorage', {
    configurable: true,
    value: storage,
  });
}

// 每个测试之间清空持久化状态,避免 store 间互相污染
beforeEach(() => {
  globalThis.localStorage.clear();
  vi.restoreAllMocks();
});

// jsdom 没有 ResizeObserver,radix ScrollArea 挂载时依赖它
if (typeof globalThis.ResizeObserver === 'undefined') {
  class MockResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalThis.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;
}
