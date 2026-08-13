import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface UIPreferencesState {
  /** Liquid 流体特效开关(默认开启) */
  liquidEnabled: boolean;
  setLiquidEnabled: (enabled: boolean) => void;
}

export const useUIPreferences = create<UIPreferencesState>()(
  persist(
    (set) => ({
      liquidEnabled: true,
      setLiquidEnabled: (enabled) => set({ liquidEnabled: enabled }),
    }),
    {
      name: 'combo.uiPrefs',
    },
  ),
);
