import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { notifyPermissionRequest, notifyQuestionRequest, notifyRunComplete } from './notify';
import { playNotifyAttention, playNotifyDone } from './sfx';
import { useUIPreferences } from '../stores/uiPreferencesStore';
import { useAgentStore } from '../stores/agentStore';

vi.mock('./connection', () => ({ isTauri: () => false }));
vi.mock('./sfx', () => ({
  playNotifyDone: vi.fn(),
  playNotifyAttention: vi.fn(),
}));

class NotificationStub {
  static permission: NotificationPermission = 'granted';
  title: string;
  options: NotificationOptions;
  onclick: ((this: Notification, ev: Event) => unknown) | null = null;
  close = vi.fn();
  constructor(title: string, options: NotificationOptions = {}) {
    this.title = title;
    this.options = options;
    created.push(this);
  }
}

const created: NotificationStub[] = [];

describe('notify', () => {
  beforeEach(() => {
    created.length = 0;
    vi.stubGlobal('Notification', NotificationStub);
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    useUIPreferences.setState({
      notifyRunComplete: true,
      notifyInteraction: true,
      notifySoundEnabled: true,
    });
    useAgentStore.setState({ activeSessionId: null });
    vi.mocked(playNotifyDone).mockClear();
    vi.mocked(playNotifyAttention).mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('任务结束时发送通知', () => {
    notifyRunComplete('s1');
    expect(created).toHaveLength(1);
    expect(created[0].title).toBe('任务已完成');
  });

  it('任务出错时以错误标题与内容发送', () => {
    notifyRunComplete('s1', 'provider 429');
    expect(created).toHaveLength(1);
    expect(created[0].title).toBe('任务出错');
    expect(created[0].options.body).toBe('provider 429');
  });

  it('偏好关闭时不发送', () => {
    useUIPreferences.setState({ notifyRunComplete: false, notifyInteraction: false });
    notifyRunComplete('s1');
    notifyPermissionRequest({ session_id: 's1', tool_name: 'bash' });
    notifyQuestionRequest({ session_id: 's1', questions: [{ question: '继续吗' }] });
    expect(created).toHaveLength(0);
  });

  it('窗口聚焦且正在看该会话时不打扰', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    useAgentStore.setState({ activeSessionId: 's1' });
    notifyRunComplete('s1');
    notifyPermissionRequest({ session_id: 's1', tool_name: 'bash' });
    notifyQuestionRequest({ session_id: 's1', questions: [{ question: '继续吗' }] });
    expect(created).toHaveLength(0);
  });

  it('聚焦但看的是其他会话时仍发送', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    useAgentStore.setState({ activeSessionId: 'other' });
    notifyRunComplete('s1');
    expect(created).toHaveLength(1);
  });

  it('权限确认与提问通知包含工具名/问题文本', () => {
    notifyPermissionRequest({ session_id: 's1', tool_name: 'edit_file' });
    notifyQuestionRequest({ session_id: 's1', questions: [{ question: '使用哪个分支?' }] });
    expect(created).toHaveLength(2);
    expect(created[0].title).toBe('等待确认');
    expect(created[0].options.body).toContain('edit_file');
    expect(created[1].title).toBe('等待回答');
    expect(created[1].options.body).toContain('使用哪个分支?');
  });

  it('发送通知时按音色播放提示音:完成/交互各用对应音效', () => {
    notifyRunComplete('s1');
    expect(playNotifyDone).toHaveBeenCalledTimes(1);
    notifyPermissionRequest({ session_id: 's1', tool_name: 'bash' });
    notifyQuestionRequest({ session_id: 's1', questions: [{ question: '继续吗' }] });
    expect(playNotifyAttention).toHaveBeenCalledTimes(2);
  });

  it('关闭通知音效后只发系统通知不播音', () => {
    useUIPreferences.setState({ notifySoundEnabled: false });
    notifyRunComplete('s1');
    notifyPermissionRequest({ session_id: 's1', tool_name: 'bash' });
    expect(created).toHaveLength(2);
    expect(playNotifyDone).not.toHaveBeenCalled();
    expect(playNotifyAttention).not.toHaveBeenCalled();
  });

  it('窗口聚焦且查看该会话(不打扰场景)音效同样不播放', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    useAgentStore.setState({ activeSessionId: 's1' });
    notifyRunComplete('s1');
    expect(playNotifyDone).not.toHaveBeenCalled();
  });
});
