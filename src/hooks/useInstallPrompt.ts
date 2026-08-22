import { useCallback, useEffect, useState } from 'react';
import { isStandalonePwa } from '../lib/pwa';

/** `beforeinstallprompt` 事件(仅 Android/Chrome/Edge 提供;iOS Safari 不触发)。 */
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

/**
 * PWA 安装提示:捕获 `beforeinstallprompt`,返回「是否可安装」与触发安装的方法。
 * iOS 无该事件,页面内改用「分享 → 添加到主屏幕」文案引导(isStandalone 判定覆盖)。
 */
export function useInstallPrompt() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState<boolean>(() => isStandalonePwa());

  useEffect(() => {
    const onPrompt = (e: Event) => {
      e.preventDefault(); // 阻止默认迷你安装条,改为用户点击按钮触发
      setDeferred(e as unknown as BeforeInstallPromptEvent);
    };
    const onInstalled = () => {
      setInstalled(true);
      setDeferred(null);
    };
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  const install = useCallback(async () => {
    if (!deferred) return false;
    try {
      await deferred.prompt();
      const choice = await deferred.userChoice;
      setDeferred(null);
      return choice.outcome === 'accepted';
    } catch {
      setDeferred(null);
      return false;
    }
  }, [deferred]);

  return {
    /** 当前浏览器支持主动安装(Android/Chrome 等非 iOS) */
    canInstall: !!deferred,
    /** 是否已运行在独立模式(已安装到主屏幕) */
    isStandalone: installed || isStandalonePwa(),
    install,
  };
}
