import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface UIPreferencesState {
  /** Liquid 流体特效开关(默认开启) */
  liquidEnabled: boolean;
  setLiquidEnabled: (enabled: boolean) => void;
  /** 任务结束通知(默认开启) */
  notifyRunComplete: boolean;
  setNotifyRunComplete: (enabled: boolean) => void;
  /** 交互请求通知:确认/提问弹窗时提醒(默认开启) */
  notifyInteraction: boolean;
  setNotifyInteraction: (enabled: boolean) => void;
}

export const useUIPreferences = create<UIPreferencesState>()(
  persist(
    (set) => ({
      liquidEnabled: true,
      setLiquidEnabled: (enabled) => set({ liquidEnabled: enabled }),
      notifyRunComplete: true,
      setNotifyRunComplete: (enabled) => set({ notifyRunComplete: enabled }),
      notifyInteraction: true,
      setNotifyInteraction: (enabled) => set({ notifyInteraction: enabled }),
    }),
    {
      name: 'combo.uiPrefs',
    },
  ),
);
