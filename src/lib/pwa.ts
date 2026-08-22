/**
 * PWA 工具:Service Worker 注册与安装态/移动端判定。
 *
 * 移动端「可直接安装」依赖:
 *  - manifest(名称/图标/主题色)+ Service Worker(App Shell 离线壳);
 *  - iOS 无 beforeinstallprompt,靠「分享 → 添加到主屏幕」;独立模式(standalone)
 *    走 `display-mode`/`navigator.standalone`,用于在应用内给出连接/安装引导。
 */
import { isTauri } from './connection';

/** 仅在浏览器生产模式、非 Tauri(桌面套壳用 tauri://localhost,无需 SW)注册。 */
export function registerServiceWorker(): void {
  if (typeof window === 'undefined') return;
  if (!import.meta.env.PROD) return; // 开发模式不注册,避免缓存干扰
  if (isTauri()) return; // 桌面套壳不走 web SW
  if (!('serviceWorker' in navigator)) return;
  // 等待 load 后再注册,避免抢首屏
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      /* SW 注册失败不影响正常使用(仅影响离线/安装) */
    });
  });
}

/** 是否运行在「已安装到主屏幕」的独立模式(iOS 用 navigator.standalone)。 */
export function isStandalonePwa(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    if (window.matchMedia('(display-mode: standalone)').matches) return true;
  } catch {
    /* ignore */
  }
  const nav = navigator as unknown as { standalone?: boolean };
  return nav.standalone === true;
}

/** 移动端视口(<768px)判定,供启动逻辑决定是否展示「连接设置屏」。 */
export function isMobileViewport(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.matchMedia('(max-width: 767px)').matches;
  } catch {
    return false;
  }
}
