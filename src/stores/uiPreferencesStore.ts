import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface UIPreferencesState {
  /** Liquid 流体特效开关(默认开启) */
  liquidEnabled: boolean;
  setLiquidEnabled: (enabled: boolean) => void;
  /** Combo 连击特效音效(默认开启):连击弹出/增长时播放气泡音 */
  comboSoundEnabled: boolean;
  setComboSoundEnabled: (enabled: boolean) => void;
  /** 免打扰模式(默认关闭):开启后暂停任务结束/交互请求的全部通知、提示音与语音播报 */
  dndEnabled: boolean;
  setDndEnabled: (enabled: boolean) => void;
  /** 任务结束通知(默认开启) */
  notifyRunComplete: boolean;
  setNotifyRunComplete: (enabled: boolean) => void;
  /** 交互请求通知:确认/提问弹窗时提醒(默认开启) */
  notifyInteraction: boolean;
  setNotifyInteraction: (enabled: boolean) => void;
  /** 通知音效(默认开启):发送系统通知时同时播放提示音 */
  notifySoundEnabled: boolean;
  setNotifySoundEnabled: (enabled: boolean) => void;
  /** 通知语音播报(默认开启):任务结束/需要交互时用 TTS 语音模型播报随机提示语 */
  notifyVoiceEnabled: boolean;
  setNotifyVoiceEnabled: (enabled: boolean) => void;
}

export const useUIPreferences = create<UIPreferencesState>()(
  persist(
    (set) => ({
      liquidEnabled: true,
      setLiquidEnabled: (enabled) => set({ liquidEnabled: enabled }),
      comboSoundEnabled: true,
      setComboSoundEnabled: (enabled) => set({ comboSoundEnabled: enabled }),
      dndEnabled: false,
      setDndEnabled: (enabled) => set({ dndEnabled: enabled }),
      notifyRunComplete: true,
      setNotifyRunComplete: (enabled) => set({ notifyRunComplete: enabled }),
      notifyInteraction: true,
      setNotifyInteraction: (enabled) => set({ notifyInteraction: enabled }),
      notifySoundEnabled: true,
      setNotifySoundEnabled: (enabled) => set({ notifySoundEnabled: enabled }),
      notifyVoiceEnabled: true,
      setNotifyVoiceEnabled: (enabled) => set({ notifyVoiceEnabled: enabled }),
    }),
    {
      name: 'combo.uiPrefs',
    },
  ),
);
