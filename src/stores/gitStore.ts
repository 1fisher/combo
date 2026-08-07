import { create } from 'zustand';

export type GitFileStatus =
  | 'modified'
  | 'added'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'unmerged'
  | 'untracked'
  | 'ignored';

export interface GitFileEntry {
  path: string;
  oldPath?: string;
  indexStatus: GitFileStatus | null;
  workTreeStatus: GitFileStatus | null;
}

interface GitState {
  branch: string;
  files: GitFileEntry[];
  loading: boolean;
  error: string | null;

  setGitData: (branch: string, files: GitFileEntry[]) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  reset: () => void;
}

export const useGitStore = create<GitState>((set) => ({
  branch: '',
  files: [],
  loading: false,
  error: null,

  setGitData: (branch, files) => set({ branch, files, error: null }),
  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error }),
  reset: () => set({ branch: '', files: [], loading: false, error: null }),
}));
