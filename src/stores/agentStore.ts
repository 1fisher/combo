import { create } from 'zustand';

interface AgentState {
  activeWorkspaceId: string | null;
  activeSessionId: string | null;
  setActiveWorkspace: (id: string | null) => void;
  setActiveSessionId: (id: string | null) => void;
}

export const useAgentStore = create<AgentState>((set) => ({
  activeWorkspaceId: null,
  activeSessionId: null,
  setActiveWorkspace: (id) => set({ activeWorkspaceId: id }),
  setActiveSessionId: (id) => set({ activeSessionId: id }),
}));
