import { create } from 'zustand';
import { randomUUID } from '../lib/clientId';

export interface ContextItem {
  id: string;
  filePath: string;
  fileName: string;
  type: 'file' | 'snippet';
  startLine?: number;
  endLine?: number;
  text?: string;
}

interface ContextStore {
  items: ContextItem[];
  addItem: (item: Omit<ContextItem, 'id'>) => void;
  removeItem: (id: string) => void;
  clear: () => void;
}

export const useContextStore = create<ContextStore>((set) => ({
  items: [],
  addItem: (item) =>
    set((s) => {
      if (
        item.type === 'file' &&
        s.items.some((i) => i.type === 'file' && i.filePath === item.filePath)
      ) {
        return s;
      }
      return { items: [...s.items, { ...item, id: randomUUID() }] };
    }),
  removeItem: (id) => set((s) => ({ items: s.items.filter((i) => i.id !== id) })),
  clear: () => set({ items: [] }),
}));

/**
 * 将上下文条目格式化为可追加到 prompt 的文本。
 */
export function formatContextPrompt(prompt: string, items: ContextItem[]): string {
  if (items.length === 0) return prompt;
  const blocks = items.map((item) => {
    if (item.type === 'file') {
      return `文件: \`${item.filePath}\``;
    }
    const lineRef =
      item.startLine != null
        ? item.endLine != null && item.endLine !== item.startLine
          ? `:${item.startLine}-${item.endLine}`
          : `:${item.startLine}`
        : '';
    const header = `文件: \`${item.filePath}${lineRef}\``;
    if (item.text) {
      return `${header}\n\`\`\`\n${item.text}\n\`\`\``;
    }
    return header;
  });
  const ctx = blocks.join('\n\n');
  return prompt.trim() ? `${prompt}\n\n${ctx}` : ctx;
}
