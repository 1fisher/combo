import { isTauri } from './connection';
import { useUIPreferences } from '../stores/uiPreferencesStore';
import { useAgentStore } from '../stores/agentStore';
import { playNotifyAttention, playNotifyDone } from './sfx';

/**
 * 系统通知:任务结束 / 需要用户交互(确认、提问)时提醒用户。
 * 桌面模式走 tauri-plugin-notification,浏览器模式走 Web Notification API。
 *
 * - 任务结束:agent 处理完成(run 收尾)即发送,窗口聚焦也通知 —
 *   任务完成是用户等待的确定性事件;不想被打扰可在设置中关闭。
 * - 交互请求(确认/提问):保持免打扰 — 窗口聚焦且正看着该会话时不弹
 *   (弹窗就在眼前,通知反而多余),切走/看别的会话时才提醒。
 * - 「通知音效」开启时同时播放提示音(音效独立于系统通知权限,
 *   权限被拒也能听到)。
 */

function truncate(text: string, max = 120): string {
  const clean = text.trim().replace(/\s+/g, ' ');
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

/** 当前是否值得为该会话发交互通知:窗口未聚焦,或看的不是这个会话 */
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

/**
 * 预请求通知权限:浏览器只在用户手势内才允许弹权限框,所以在用户点击
 * 「发送」时调用(doSend 内 fire-and-forget)。设置里两个通知开关都关
 * 时不打扰用户;requestNotifyPermission 自身幂等(granted/denied 后
 * 不会再弹窗),无需缓存。
 */
export function ensureNotifyPermission(): Promise<boolean> {
  const prefs = useUIPreferences.getState();
  if (!prefs.notifyRunComplete && !prefs.notifyInteraction) return Promise.resolve(false);
  return requestNotifyPermission();
}

/**
 * 提取会话最后一条 assistant 消息的首个非空文本行,作为完成通知的精简摘要。
 * 必须在 markRun 之前调用:非当前会话的 run 结束时其运行态(含消息)会被就地回收。
 */
export function runCompleteSummary(sessionId?: string | null): string {
  if (!sessionId) return '';
  const rt = useAgentStore.getState().bySession[sessionId];
  if (!rt) return '';
  for (let i = rt.messages.length - 1; i >= 0; i--) {
    const m = rt.messages[i];
    if (m.role !== 'assistant') continue;
    const text = m.parts
      .filter((pt) => pt.type === 'text')
      .map((pt) => pt.data.text)
      .join('\n');
    const firstLine = text
      .split('\n')
      .map((line) => line.trim().replace(/^#+\s*/, ''))
      .find((line) => line.length > 0);
    if (firstLine) return firstLine;
  }
  return '';
}

/** 任务结束(run 收尾)通知;error 非空表示运行出错,summary 为任务的精简完成情况 */
export function notifyRunComplete(
  _sessionId?: string | null,
  error?: string,
  summary?: string
): void {
  if (!useUIPreferences.getState().notifyRunComplete) return;
  // 任务完成总是通知:即使窗口聚焦且正在查看该会话 — 用户在等这个结果。
  // (交互类通知仍做免打扰判断,见 notifyPermissionRequest/notifyQuestionRequest)
  const title = error ? '任务出错' : '任务已完成';
  const body = error
    ? truncate(error)
    : truncate(summary || '会话任务已结束,点击返回查看结果');
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
