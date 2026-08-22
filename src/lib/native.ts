/**
 * 原生壳(Capacitor)运行环境检测。
 *
 * 不直接 import @capacitor/core:纯 Web/桌面环境无需引入该运行时,
 * 原生桥接会向 WebView 注入全局 `Capacitor` 对象,据此判定即可。
 */

interface CapacitorGlobal {
  isNativePlatform?: () => boolean;
  getPlatform?: () => string;
}

function capacitorGlobal(): CapacitorGlobal | null {
  if (typeof window === 'undefined') return null;
  return (window as unknown as { Capacitor?: CapacitorGlobal }).Capacitor ?? null;
}

/** 是否运行在原生壳(Android/iOS)内。 */
export function isNativeApp(): boolean {
  const cap = capacitorGlobal();
  return typeof cap?.isNativePlatform === 'function' && cap.isNativePlatform();
}

/** 原生平台标识('android' | 'ios'),非原生环境返回 null。 */
export function nativePlatform(): 'android' | 'ios' | null {
  if (!isNativeApp()) return null;
  const p = capacitorGlobal()?.getPlatform?.();
  return p === 'android' || p === 'ios' ? p : null;
}
