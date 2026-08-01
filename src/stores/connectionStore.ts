import { create } from 'zustand';

export type ConnStatus = 'disconnected' | 'connecting' | 'connected';

interface ConnectionState {
  status: ConnStatus;
  lastError: string | null;
  setStatus: (status: ConnStatus) => void;
  setError: (msg: string | null) => void;
}

export const useConnectionStore = create<ConnectionState>((set) => ({
  status: 'disconnected',
  lastError: null,
  setStatus: (status) => set({ status }),
  setError: (msg) => set({ lastError: msg }),
}));
