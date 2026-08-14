import { isTauri } from './connection';
import { useUIPreferences } from '../stores/uiPreferencesStore';
import { useAgentStore } from '../stores/agentStore';
import { playNotifyAttention, playNotifyDone } from './sfx';

/**
 * 系统通知:任务结束 / 需要用户交互(确认、提问)时提醒用户。
 * 桌面模式走 tauri-plugin-notification,浏览器模式走 Web Notification API。
 * 窗口聚焦且正在查看对应会话时不打扰,其余情况(切走、最小化、
 * 看着别的会话)才发送;「通知音效」开启时同时播放提示音
 * (音效独立于系统通知权限,权限被拒也能听到)。
 */

function truncate(text: string, max = 120): string {
  const clean = text.trim().replace(/\s+/g, ' ');
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

/** 当前是否值得为该会话发通知:窗口未聚焦,或看的不是这个会话 */
function sessionNeedsNotification(sessionId?: string | null): boolean {
  if (typeof document !== 'undefined' && !document.hasFocus()) return true;
  if (sessionId && sessionId !== useAgentStore.getState().activeSessionId) return true;
  return false;
}

/** 请求通知权限(开启开关时调用),返回是否已授权 */
export async function requestNotifyPermission(): Promise<boolean> {
  if (isTauri()) {
    try {
      const mod = await import('@tauri-apps/plugin-notification');
      if (await mod.isPermissionGranted()) return true;
      return (await mod.requestPermission()) === 'granted';
    } catch (err) {
      console.warn('[notify] 桌面通知权限请求失败:', err);
      return false;
    }
  }
  if (typeof Notification === 'undefined') return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  try {
    return (await Notification.requestPermission()) === 'granted';
  } catch {
    return false;
  }
}

async function sendNotification(title: string, body: string): Promise<void> {
  if (isTauri()) {
    try {
      const mod = await import('@tauri-apps/plugin-notification');
      if (!(await mod.isPermissionGranted())) return;
      mod.sendNotification({ title, body });
    } catch (err) {
      console.warn('[notify] 桌面通知发送失败:', err);
    }
    return;
  }
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  try {
    const n = new Notification(title, { body });
    n.onclick = () => {
      window.focus();
      n.close();
    };
  } catch (err) {
    console.warn('[notify] 浏览器通知发送失败:', err);
  }
}

/** 任务结束(run 收尾)通知;error 非空表示运行出错 */
export function notifyRunComplete(sessionId?: string | null, error?: string): void {
  if (!useUIPreferences.getState().notifyRunComplete) return;
  if (!sessionNeedsNotification(sessionId)) return;
  const title = error ? '任务出错' : '任务已完成';
  const body = error ? truncate(error) : '会话任务已结束,点击返回查看结果';
  if (useUIPreferences.getState().notifySoundEnabled) playNotifyDone();
  void sendNotification(title, body);
}

/** 工具权限确认弹窗通知 */
export function notifyPermissionRequest(p: {
  session_id: string;
  tool_name: string;
}): void {
  if (!useUIPreferences.getState().notifyInteraction) return;
  if (!sessionNeedsNotification(p.session_id)) return;
  if (useUIPreferences.getState().notifySoundEnabled) playNotifyAttention();
  void sendNotification('等待确认', `Agent 请求执行 ${p.tool_name},需要你的批准`);
}

/** 提问弹窗通知 */
export function notifyQuestionRequest(p: {
  session_id: string;
  questions?: { question?: string }[];
}): void {
  if (!useUIPreferences.getState().notifyInteraction) return;
  if (!sessionNeedsNotification(p.session_id)) return;
  if (useUIPreferences.getState().notifySoundEnabled) playNotifyAttention();
  const first = p.questions?.[0]?.question;
  void sendNotification('等待回答', first ? truncate(first, 80) : 'Agent 提出了问题,需要你的输入');
}
