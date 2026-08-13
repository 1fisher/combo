import { isTauri } from './connection';

/** 判断 URL 是否可安全地在外部浏览器打开(仅 http/https/mailto,拒绝 javascript: 等)。 */
export function isSafeExternalUrl(url: string): boolean {
  return /^(https?:|mailto:)/i.test(url.trim());
}

/**
 * 在系统默认浏览器中打开外部链接:
 * Tauri 模式调用 Rust `open_url` 命令,浏览器模式用 window.open 新标签页。
 * 供聊天/文档里的超链接在 cmd(Mac)/ctrl(Windows)+click 时调用。
 */
export async function openExternal(url: string): Promise<void> {
  const trimmed = url.trim();
  if (!isSafeExternalUrl(trimmed)) return;
  if (isTauri()) {
    const { invoke } = await import('@tauri-apps/api/core');
    try {
      await invoke('open_url', { url: trimmed });
      return;
    } catch {
      // 命令不存在(旧版本)时回退到 window.open
    }
  }
  window.open(trimmed, '_blank', 'noopener,noreferrer');
}
