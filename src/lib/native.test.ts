import { describe, it, expect } from 'vitest';
import { isNativeApp, nativePlatform } from './native';

/** 向 window 注入/清除 Capacitor 全局桥对象。 */
function setCapacitor(value: unknown) {
  if (value === undefined) {
    delete (window as unknown as Record<string, unknown>).Capacitor;
  } else {
    (window as unknown as Record<string, unknown>).Capacitor = value;
  }
}

describe('native', () => {
  it('无 Capacitor 全局时不是原生环境', () => {
    setCapacitor(undefined);
    expect(isNativeApp()).toBe(false);
    expect(nativePlatform()).toBeNull();
  });

  it('isNativePlatform()=false(纯浏览器 SDK 调试)不算原生', () => {
    setCapacitor({ isNativePlatform: () => false, getPlatform: () => 'web' });
    expect(isNativeApp()).toBe(false);
    expect(nativePlatform()).toBeNull();
  });

  it('Android 原生环境判定为 android', () => {
    setCapacitor({ isNativePlatform: () => true, getPlatform: () => 'android' });
    expect(isNativeApp()).toBe(true);
    expect(nativePlatform()).toBe('android');
  });

  it('iOS 原生环境判定为 ios', () => {
    setCapacitor({ isNativePlatform: () => true, getPlatform: () => 'ios' });
    expect(nativePlatform()).toBe('ios');
  });

  it('未知平台标识返回 null 但仍是原生环境', () => {
    setCapacitor({ isNativePlatform: () => true });
    expect(isNativeApp()).toBe(true);
    expect(nativePlatform()).toBeNull();
  });
});
