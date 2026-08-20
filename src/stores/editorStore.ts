import { create } from 'zustand';

export type FileKind = 'text' | 'image' | 'pdf';

/** 单文件 LSP 诊断计数(编辑器同步后上报,状态指示器联动用)。 */
export interface FileDiagnostics {
  errors: number;
  warnings: number;
}

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
  /** path → LSP 诊断计数(实时,编辑/保存后更新;关闭文件时清理)。 */
  diagnostics: Record<string, FileDiagnostics>;
  /** 待消费的「跳转到文件某行」请求(消息区诊断列表点击发起,编辑器视图消费)。 */
  revealRequest: { path: string; line: number; nonce: number } | null;
  openFile: (path: string, name: string, content: string, kind?: FileKind) => void;
  setActive: (path: string | null) => void;
  setContent: (path: string, content: string) => void;
  closeFile: (path: string) => void;
  /** 保存成功后落盘内容,清掉脏标记 */
  markSaved: (path: string, content: string) => void;
  /** 更新文件的 HEAD 内容(git gutter 基准) */
  setHeadContent: (path: string, headContent: string | null) => void;
  /** 上报/清除某文件的 LSP 诊断计数(null 删除条目) */
  setDiagnostics: (path: string, d: FileDiagnostics | null) => void;
  /** 请求编辑器跳转到某文件某行(1-based);EditorPane 定位后 clearReveal 消费 */
  revealLine: (path: string, line: number) => void;
  clearReveal: () => void;
  /** 切换项目时清空所有打开的文件 */
  resetOpenFiles: () => void;
}

export const useEditorStore = create<EditorState>((set) => ({
  openFiles: [],
  activePath: null,
  diagnostics: {},
  revealRequest: null,

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
      const { [path]: _removed, ...diagnostics } = st.diagnostics;
      return { openFiles, activePath, diagnostics };
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

  setDiagnostics: (path, d) =>
    set((st) => {
      if (!d) {
        const { [path]: _removed, ...rest } = st.diagnostics;
        return { diagnostics: rest };
      }
      // 计数相同不产生新引用,避免订阅方无谓重渲染
      const prev = st.diagnostics[path];
      if (prev && prev.errors === d.errors && prev.warnings === d.warnings) return st;
      return { diagnostics: { ...st.diagnostics, [path]: d } };
    }),

  revealLine: (path, line) =>
    set({ revealRequest: { path, line, nonce: Date.now() + Math.random() } }),

  clearReveal: () => set({ revealRequest: null }),

  resetOpenFiles: () =>
    set({ openFiles: [], activePath: null, diagnostics: {}, revealRequest: null }),
}));
