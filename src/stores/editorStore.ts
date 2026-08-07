import { create } from 'zustand';

export type FileKind = 'text' | 'image' | 'pdf';

export interface OpenFile {
  path: string;
  name: string;
  content: string;
  original: string;
  dirty: boolean;
  kind: FileKind;
  /** 文件在 git HEAD 的内容(用于 git gutter 对比);null 表示尚未获取 */
  headContent?: string | null;
}

interface EditorState {
  openFiles: OpenFile[];
  activePath: string | null;
  openFile: (path: string, name: string, content: string, kind?: FileKind) => void;
  setActive: (path: string | null) => void;
  setContent: (path: string, content: string) => void;
  closeFile: (path: string) => void;
  /** 保存成功后落盘内容,清掉脏标记 */
  markSaved: (path: string, content: string) => void;
  /** 更新文件的 HEAD 内容(git gutter 基准) */
  setHeadContent: (path: string, headContent: string | null) => void;
  /** 切换项目时清空所有打开的文件 */
  resetOpenFiles: () => void;
}

export const useEditorStore = create<EditorState>((set) => ({
  openFiles: [],
  activePath: null,

  openFile: (path, name, content, kind = 'text') =>
    set((st) => {
      const existing = st.openFiles.find((f) => f.path === path);
      if (existing) return { activePath: path };
      return {
        openFiles: [...st.openFiles, { path, name, content, original: content, dirty: false, kind }],
        activePath: path,
      };
    }),

  setActive: (path) => set({ activePath: path }),

  setContent: (path, content) =>
    set((st) => ({
      openFiles: st.openFiles.map((f) =>
        f.path === path ? { ...f, content, dirty: content !== f.original } : f
      ),
    })),

  closeFile: (path) =>
    set((st) => {
      const openFiles = st.openFiles.filter((f) => f.path !== path);
      let activePath = st.activePath;
      if (activePath === path) {
        const idx = st.openFiles.findIndex((f) => f.path === path);
        const neighbor = openFiles[Math.min(idx, openFiles.length - 1)];
        activePath = neighbor ? neighbor.path : null;
      }
      return { openFiles, activePath };
    }),

  markSaved: (path, content) =>
    set((st) => ({
      openFiles: st.openFiles.map((f) =>
        f.path === path ? { ...f, content, original: content, dirty: false } : f
      ),
    })),

  setHeadContent: (path, headContent) =>
    set((st) => ({
      openFiles: st.openFiles.map((f) =>
        f.path === path ? { ...f, headContent } : f
      ),
    })),

  resetOpenFiles: () => set({ openFiles: [], activePath: null }),
}));
