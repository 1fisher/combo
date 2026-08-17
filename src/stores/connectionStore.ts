import { create } from 'zustand';

export type ConnStatus = 'disconnected' | 'connecting' | 'connected';

/** 连接方式:本机 / 局域网直连 / WebRTC P2P / 云端中转。 */
export type ConnTransport = 'local' | 'lan' | 'p2p' | 'relay';

interface ConnectionState {
  status: ConnStatus;
  lastError: string | null;
  transport: ConnTransport;
  setStatus: (status: ConnStatus) => void;
  setError: (msg: string | null) => void;
  setTransport: (transport: ConnTransport) => void;
}

/** 初始连接方式:桌面本机 / 局域网直连页 / 中转页(之后可被 P2P 覆盖)。 */
function initialTransport(): ConnTransport {
  if (typeof window === 'undefined') return 'local';
  try {
    const { hostname, origin } = window.location;
    if (hostname === 'localhost' || hostname === '127.0.0.1') return 'local';
    const lan = localStorage.getItem('combo.lanUrl');
    if (lan && origin === lan) return 'lan';
    return 'relay';
  } catch {
    return 'local';
  }
}

export const useConnectionStore = create<ConnectionState>((set) => ({
  status: 'disconnected',
  lastError: null,
  transport: initialTransport(),
  setStatus: (status) => set({ status }),
  setError: (msg) => set({ lastError: msg }),
  setTransport: (transport) => set({ transport }),
}));
