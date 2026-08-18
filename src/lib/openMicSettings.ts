import { isTauri } from './connection';

/**
 * 打开系统「麦克风」隐私设置页(录音权限被拒时的引导):
 * Tauri 模式调用 Rust `open_privacy_settings` 命令(macOS 系统设置深链 /
 * Windows ms-settings);浏览器模式无法跳转,返回 false 由调用方降级提示。
 */
export async function openMicSettings(): Promise<boolean> {
  if (!isTauri()) return false;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('open_privacy_settings', { settings: 'microphone' });
    return true;
  } catch {
    // 命令不存在(旧版本)时静默,调用方保留文案提示
    return false;
  }
}
