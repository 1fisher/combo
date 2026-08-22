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

// jsdom 25 未实现 window.matchMedia(useIsMobile 等断点检测依赖),
// stub 固定 matches=false(桌面视口行为),change 事件静默忽略
if (typeof window.matchMedia !== 'function') {
  window.matchMedia = ((query: string): MediaQueryList =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList) as typeof window.matchMedia;
}

// jsdom 未实现 AnimationEvent:React 在模块加载时会探测 `AnimationEvent in window`,
// 缺失时把 onAnimationEnd/animationend 注册到 webkit 前缀事件上,测试里派发的
// animationend 事件到不了 React 合成事件(如 ComboOverlay 的动画结束回调)。
// 这里在 react-dom 加载前补一个最小实现,保证按标准事件名注册。
if (typeof globalThis.AnimationEvent === 'undefined') {
  class AnimationEventPolyfill extends Event {
    animationName: string;
    elapsedTime: number;
    pseudoElement: string;
    constructor(type: string, init: AnimationEventInit = {}) {
      super(type, init);
      this.animationName = init.animationName ?? '';
      this.elapsedTime = init.elapsedTime ?? 0;
      this.pseudoElement = init.pseudoElement ?? '';
    }
  }
  Object.defineProperty(globalThis, 'AnimationEvent', {
    configurable: true,
    writable: true,
    value: AnimationEventPolyfill,
  });
}
