import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { playNotifyAttention } from './sfx';
import { notifyPermissionRequest, notifyQuestionRequest } from './notify';
import { useUIPreferences } from '../stores/uiPreferencesStore';
import { useAgentStore } from '../stores/agentStore';

/**
 * Tauri 原生窗口焦点覆盖 WKWebView 假聚焦的回归测试:
 * macOS WKWebView 在应用切后台时 document.hasFocus() 仍返回 true,
 * 焦点判定必须以原生 onFocusChanged 为准,否则切走后的交互通知被吞。
 * (浏览器回退路径由 notify.test.ts 覆盖,isTauri=false 走 hasFocus)
 *
 * 注意:native mock 不用 vi.fn —— test-setup.ts 的全局 beforeEach 会
 * vi.restoreAllMocks(),把 vi.fn 的调用记录与实现一并抹掉,导致模块
 * 加载期订阅的回调取不到。普通对象手动存回调,天然免疫。
 */

const tauriMode = vi.hoisted(() => ({ current: true }));

/** 可控的原生窗口 mock:focus 供 isFocused 读取,cb 为订阅到的回调 */
const nativeWin = vi.hoisted(() => {
  const ctl = {
    focus: true,
    cb: null as null | ((e: { payload: boolean }) => void),
  };
  return {
    ctl,
    isFocused: async (): Promise<boolean> => ctl.focus,
    onFocusChanged: async (
      cb: (e: { payload: boolean }) => void,
    ): Promise<() => void> => {
      ctl.cb = cb;
      return () => {
        ctl.cb = null;
      };
    },
  };
});

/** 桌面通知插件 mock:记录 sendNotification 调用供断言 */
const desktopNotifications = vi.hoisted(
  () => [] as { title: string; body?: string }[],
);

vi.mock('./connection', () => ({ isTauri: () => tauriMode.current }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => nativeWin }));
vi.mock('@tauri-apps/plugin-notification', () => ({
  isPermissionGranted: async () => true,
  requestPermission: async () => 'granted',
  sendNotification: (n: { title: string; body?: string }) => {
    desktopNotifications.push(n);
  },
}));
vi.mock('./sfx', () => ({
  playNotifyDone: vi.fn(),
  playNotifyAttention: vi.fn(),
}));

/** 模拟原生窗口失焦/聚焦(同时驱动 isFocused 初值) */
function setNativeFocus(focused: boolean): void {
  const cb = nativeWin.ctl.cb;
  if (!cb) throw new Error('原生 onFocusChanged 未订阅');
  nativeWin.ctl.focus = focused;
  cb({ payload: focused });
}

/** 刷新微任务,让 fire-and-forget 的桌面通知发送完成 */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('notify(Tauri 原生焦点)', () => {
  beforeEach(async () => {
    desktopNotifications.length = 0;
    // 模拟 WKWebView quirk:应用已切后台,document.hasFocus() 却仍是 true
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    useUIPreferences.setState({
      notifyRunComplete: true,
      notifyInteraction: true,
      notifySoundEnabled: true,
    });
    useAgentStore.setState({ activeSessionId: 's1', bySession: {} });
    vi.mocked(playNotifyAttention).mockClear();
    // 等待模块加载时启动的异步原生订阅就绪(回调已存入 ctl.cb)
    await vi.waitFor(() => {
      if (!nativeWin.ctl.cb) throw new Error('原生订阅未就绪');
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('原生失焦时即使 hasFocus() 误报 true 也发送通知并播音(修复 WKWebView quirk)', async () => {
    setNativeFocus(false);
    notifyQuestionRequest({ session_id: 's1', questions: [{ question: '继续吗' }] });
    await vi.waitFor(() => expect(desktopNotifications).toHaveLength(1));
    expect(desktopNotifications[0].title).toBe('等待回答');
    expect(desktopNotifications[0].body).toContain('继续吗');
    expect(playNotifyAttention).toHaveBeenCalledTimes(1);
  });

  it('原生聚焦且正看当前会话时保持免打扰(hasFocus 误报无关紧要)', async () => {
    setNativeFocus(true);
    notifyQuestionRequest({ session_id: 's1', questions: [{ question: '继续吗' }] });
    await flush();
    expect(desktopNotifications).toHaveLength(0);
    expect(playNotifyAttention).not.toHaveBeenCalled();
  });

  it('原生聚焦但看的是其他会话时仍发送', async () => {
    setNativeFocus(true);
    notifyPermissionRequest({ session_id: 'other', tool_name: 'bash' });
    await vi.waitFor(() => expect(desktopNotifications).toHaveLength(1));
    expect(desktopNotifications[0].title).toBe('等待确认');
  });
});
