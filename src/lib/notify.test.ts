import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ensureNotifyPermission,
  notifyPermissionRequest,
  notifyQuestionRequest,
  notifyRunComplete,
  runCompleteSummary,
} from './notify';
import { playNotifyAttention, playNotifyDone } from './sfx';
import { speakNotifyVoice } from './notifyVoice';
import { useUIPreferences } from '../stores/uiPreferencesStore';
import { useAgentStore } from '../stores/agentStore';

vi.mock('./connection', () => ({ isTauri: () => false }));
vi.mock('./sfx', () => ({
  playNotifyDone: vi.fn(),
  playNotifyAttention: vi.fn(),
}));
vi.mock('./notifyVoice', () => ({
  speakNotifyVoice: vi.fn(),
  pickVoicePhrase: (pool: string[]) => pool[0] ?? '',
  VOICE_RUN_DONE: ['任务完成啦,快回来看看结果吧。'],
  VOICE_RUN_ERROR: ['哎呀,任务出错了,快回来看看。'],
  VOICE_AWAIT_CONFIRM: ['有个操作在等你确认,别让我等太久。'],
  VOICE_AWAIT_ANSWER: ['有个问题在等你回答,快来吧。'],
}));

class NotificationStub {
  static permission: NotificationPermission = 'granted';
  static requestPermission: () => Promise<NotificationPermission> = vi.fn();
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
    NotificationStub.permission = 'granted';
    vi.stubGlobal('Notification', NotificationStub);
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    useUIPreferences.setState({
      notifyRunComplete: true,
      notifyInteraction: true,
      notifySoundEnabled: true,
      notifyVoiceEnabled: false,
      dndEnabled: false,
    });
    useAgentStore.setState({ activeSessionId: null, bySession: {} });
    vi.mocked(playNotifyDone).mockClear();
    vi.mocked(playNotifyAttention).mockClear();
    vi.mocked(speakNotifyVoice).mockClear();
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

  it('完成通知正文优先使用任务完成情况摘要,无摘要时回退默认文案', () => {
    notifyRunComplete('s1', undefined, '已修复登录校验并补齐单测');
    expect(created[0].options.body).toBe('已修复登录校验并补齐单测');
    notifyRunComplete('s1');
    expect(created[1].options.body).toBe('会话任务已结束,点击返回查看结果');
  });

  it('runCompleteSummary 取最后一条 assistant 消息的首个非空文本行', () => {
    useAgentStore.setState({
      bySession: {
        s1: {
          messages: [
            {
              id: 'm1',
              role: 'assistant',
              parts: [{ type: 'text', data: { text: '旧一轮的回复' } }],
              createdAt: 1,
              updatedAt: 1,
              streaming: false,
            },
            {
              id: 'm2',
              role: 'assistant',
              parts: [
                { type: 'reasoning', data: { thinking: '思考过程', signature: '' } },
                { type: 'text', data: { text: '\n## 修复完成\n登录校验已修复,单测已补齐。' } },
                { type: 'finish', data: { reason: 'stop' } },
              ],
              createdAt: 2,
              updatedAt: 3,
              streaming: false,
            },
          ],
          run: null,
          queued: false,
        },
      },
    });
    expect(runCompleteSummary('s1')).toBe('修复完成');
    expect(runCompleteSummary('missing')).toBe('');
    expect(runCompleteSummary(undefined)).toBe('');
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

  it('窗口聚焦且正在看该会话时:任务结束仍通知,交互请求不打扰', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    useAgentStore.setState({ activeSessionId: 's1' });
    notifyRunComplete('s1');
    notifyPermissionRequest({ session_id: 's1', tool_name: 'bash' });
    notifyQuestionRequest({ session_id: 's1', questions: [{ question: '继续吗' }] });
    // 任务完成是用户等待的确定性事件 → 总是通知
    expect(created).toHaveLength(1);
    expect(created[0].title).toBe('任务已完成');
  });

  it('聚焦但看的是其他会话时仍发送', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    useAgentStore.setState({ activeSessionId: 'other' });
    notifyRunComplete('s1');
    expect(created).toHaveLength(1);
  });

  it('免打扰模式开启时全部通知静音(优先级最高,失焦也不提醒)', () => {
    useUIPreferences.setState({ dndEnabled: true, notifyVoiceEnabled: true });
    notifyRunComplete('s1', undefined, '已完成');
    notifyPermissionRequest({ session_id: 's1', tool_name: 'bash' });
    notifyQuestionRequest({ session_id: 's1', questions: [{ question: '继续吗' }] });
    expect(created).toHaveLength(0);
    expect(playNotifyDone).not.toHaveBeenCalled();
    expect(playNotifyAttention).not.toHaveBeenCalled();
    expect(speakNotifyVoice).not.toHaveBeenCalled();
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

  // --- 通知语音播报(随机提示语经 pickVoicePhrase mock 固定取池内第一句) ---

  it('语音播报开启时:任务完成/出错与确认/提问各播报对应随机提示语', () => {
    useUIPreferences.setState({ notifyVoiceEnabled: true });
    notifyRunComplete('s1');
    expect(speakNotifyVoice).toHaveBeenLastCalledWith('任务完成啦,快回来看看结果吧。');
    notifyRunComplete('s1', 'provider 429');
    expect(speakNotifyVoice).toHaveBeenLastCalledWith('哎呀,任务出错了,快回来看看。');
    notifyPermissionRequest({ session_id: 's1', tool_name: 'bash' });
    expect(speakNotifyVoice).toHaveBeenLastCalledWith('有个操作在等你确认,别让我等太久。');
    notifyQuestionRequest({ session_id: 's1', questions: [{ question: '继续吗' }] });
    expect(speakNotifyVoice).toHaveBeenLastCalledWith('有个问题在等你回答,快来吧。');
    expect(speakNotifyVoice).toHaveBeenCalledTimes(4);
  });

  it('语音播报关闭时不播报(通知本体不受影响)', () => {
    useUIPreferences.setState({ notifyVoiceEnabled: false });
    notifyRunComplete('s1');
    notifyPermissionRequest({ session_id: 's1', tool_name: 'bash' });
    notifyQuestionRequest({ session_id: 's1', questions: [{ question: '继续吗' }] });
    expect(created).toHaveLength(3);
    expect(speakNotifyVoice).not.toHaveBeenCalled();
  });

  it('语音播报跟随对应通知开关:任务结束通知关闭则完成不播报,交互通知关闭则确认/提问不播报', () => {
    useUIPreferences.setState({ notifyVoiceEnabled: true, notifyRunComplete: false });
    notifyRunComplete('s1');
    expect(speakNotifyVoice).not.toHaveBeenCalled();
    // 交互开关仍开 → 确认请求照常播报
    notifyPermissionRequest({ session_id: 's1', tool_name: 'bash' });
    expect(speakNotifyVoice).toHaveBeenCalledTimes(1);
    useUIPreferences.setState({ notifyRunComplete: true, notifyInteraction: false });
    notifyRunComplete('s1');
    notifyPermissionRequest({ session_id: 's1', tool_name: 'bash' });
    notifyQuestionRequest({ session_id: 's1', questions: [{ question: '继续吗' }] });
    // 完成开关恢复 → 完成播报;交互开关关闭 → 确认/提问不再播报
    expect(speakNotifyVoice).toHaveBeenCalledTimes(2);
  });

  it('交互语音播报与交互通知同规则:聚焦且正看该会话时不播报,任务完成播报不受焦点影响', () => {
    useUIPreferences.setState({ notifyVoiceEnabled: true });
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    useAgentStore.setState({ activeSessionId: 's1' });
    notifyRunComplete('s1');
    notifyPermissionRequest({ session_id: 's1', tool_name: 'bash' });
    notifyQuestionRequest({ session_id: 's1', questions: [{ question: '继续吗' }] });
    expect(speakNotifyVoice).toHaveBeenCalledTimes(1);
    expect(speakNotifyVoice).toHaveBeenCalledWith('任务完成啦,快回来看看结果吧。');
  });

  it('窗口聚焦且查看该会话:任务完成音效仍播放,交互音效不播放', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    useAgentStore.setState({ activeSessionId: 's1' });
    notifyRunComplete('s1');
    notifyPermissionRequest({ session_id: 's1', tool_name: 'bash' });
    expect(playNotifyDone).toHaveBeenCalledTimes(1);
    expect(playNotifyAttention).not.toHaveBeenCalled();
  });

  it('ensureNotifyPermission:两个通知开关都关时不请求权限', async () => {
    NotificationStub.permission = 'default';
    const req = vi
      .spyOn(NotificationStub, 'requestPermission')
      .mockResolvedValue('granted');
    useUIPreferences.setState({ notifyRunComplete: false, notifyInteraction: false });
    await expect(ensureNotifyPermission()).resolves.toBe(false);
    expect(req).not.toHaveBeenCalled();
  });

  it('ensureNotifyPermission:开关开启且权限未定时请求一次', async () => {
    NotificationStub.permission = 'default';
    const req = vi
      .spyOn(NotificationStub, 'requestPermission')
      .mockResolvedValue('granted');
    await expect(ensureNotifyPermission()).resolves.toBe(true);
    expect(req).toHaveBeenCalledTimes(1);
  });

  it('ensureNotifyPermission:权限已授予时不再弹请求', async () => {
    const req = vi
      .spyOn(NotificationStub, 'requestPermission')
      .mockResolvedValue('granted');
    await expect(ensureNotifyPermission()).resolves.toBe(true);
    expect(req).not.toHaveBeenCalled();
  });
});
