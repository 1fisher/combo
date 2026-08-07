import { isTauri } from './connection';

/**
 * 跨环境的确认对话框。
 * Tauri 模式下用 `@tauri-apps/plugin-dialog` 的 `ask`;
 * 浏览器模式用 `window.confirm`。
 */
export async function confirmDialog(message: string): Promise<boolean> {
  if (isTauri()) {
    try {
      const { ask } = await import('@tauri-apps/plugin-dialog');
      return await ask(message, {
        title: '确认',
        kind: 'warning',
        okLabel: '确定',
        cancelLabel: '取消',
      });
    } catch {
      return window.confirm(message);
    }
  }
  return window.confirm(message);
}
