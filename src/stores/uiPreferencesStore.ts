import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface UIPreferencesState {
  /** Liquid 流体特效开关(默认开启) */
  liquidEnabled: boolean;
  setLiquidEnabled: (enabled: boolean) => void;
  /** Combo 连击特效音效(默认开启):连击弹出/增长时播放气泡音 */
  comboSoundEnabled: boolean;
  setComboSoundEnabled: (enabled: boolean) => void;
  /** 任务结束通知(默认开启) */
  notifyRunComplete: boolean;
  setNotifyRunComplete: (enabled: boolean) => void;
  /** 交互请求通知:确认/提问弹窗时提醒(默认开启) */
  notifyInteraction: boolean;
  setNotifyInteraction: (enabled: boolean) => void;
  /** 通知音效(默认开启):发送系统通知时同时播放提示音 */
  notifySoundEnabled: boolean;
  setNotifySoundEnabled: (enabled: boolean) => void;
}

export const useUIPreferences = create<UIPreferencesState>()(
  persist(
    (set) => ({
      liquidEnabled: true,
      setLiquidEnabled: (enabled) => set({ liquidEnabled: enabled }),
      comboSoundEnabled: true,
      setComboSoundEnabled: (enabled) => set({ comboSoundEnabled: enabled }),
      notifyRunComplete: true,
      setNotifyRunComplete: (enabled) => set({ notifyRunComplete: enabled }),
      notifyInteraction: true,
      setNotifyInteraction: (enabled) => set({ notifyInteraction: enabled }),
      notifySoundEnabled: true,
      setNotifySoundEnabled: (enabled) => set({ notifySoundEnabled: enabled }),
    }),
    {
      name: 'combo.uiPrefs',
    },
  ),
);
