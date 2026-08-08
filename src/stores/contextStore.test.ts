import { describe, expect, it, beforeEach } from 'vitest';
import { useContextStore, formatContextPrompt } from './contextStore';

describe('contextStore', () => {
  beforeEach(() => {
    useContextStore.getState().clear();
  });

  it('adds and removes items', () => {
    const { addItem, removeItem } = useContextStore.getState();
    addItem({ filePath: 'src/a.ts', fileName: 'a.ts', type: 'file' });
    addItem({ filePath: 'src/b.ts', fileName: 'b.ts', type: 'file' });
    expect(useContextStore.getState().items).toHaveLength(2);

    const firstId = useContextStore.getState().items[0].id;
    removeItem(firstId);
    expect(useContextStore.getState().items).toHaveLength(1);
    expect(useContextStore.getState().items[0].filePath).toBe('src/b.ts');
  });

  it('deduplicates file items by path', () => {
    const { addItem } = useContextStore.getState();
    addItem({ filePath: 'src/a.ts', fileName: 'a.ts', type: 'file' });
    addItem({ filePath: 'src/a.ts', fileName: 'a.ts', type: 'file' });
    expect(useContextStore.getState().items).toHaveLength(1);
  });

  it('allows multiple snippets from the same file', () => {
    const { addItem } = useContextStore.getState();
    addItem({ filePath: 'a.ts', fileName: 'a.ts', type: 'snippet', startLine: 1, endLine: 3, text: 'foo' });
    addItem({ filePath: 'a.ts', fileName: 'a.ts', type: 'snippet', startLine: 10, endLine: 20, text: 'bar' });
    expect(useContextStore.getState().items).toHaveLength(2);
  });
});

describe('formatContextPrompt', () => {
  it('returns prompt unchanged when no items', () => {
    expect(formatContextPrompt('hello', [])).toBe('hello');
  });

  it('formats file item', () => {
    const result = formatContextPrompt('hello', [
      { id: '1', filePath: 'src/a.ts', fileName: 'a.ts', type: 'file' },
    ]);
    expect(result).toBe('hello\n\n文件: `src/a.ts`');
  });

  it('formats snippet with line range and text', () => {
    const result = formatContextPrompt('', [
      {
        id: '1',
        filePath: 'src/a.ts',
        fileName: 'a.ts',
        type: 'snippet',
        startLine: 5,
        endLine: 8,
        text: 'const x = 1;',
      },
    ]);
    expect(result).toBe('文件: `src/a.ts:5-8`\n```\nconst x = 1;\n```');
  });

  it('formats snippet with single line', () => {
    const result = formatContextPrompt('fix this', [
      {
        id: '1',
        filePath: 'b.ts',
        fileName: 'b.ts',
        type: 'snippet',
        startLine: 3,
        endLine: 3,
        text: 'bug',
      },
    ]);
    expect(result).toBe('fix this\n\n文件: `b.ts:3`\n```\nbug\n```');
  });

  it('combines multiple items', () => {
    const result = formatContextPrompt('q', [
      { id: '1', filePath: 'a.ts', fileName: 'a.ts', type: 'file' },
      {
        id: '2',
        filePath: 'b.ts',
        fileName: 'b.ts',
        type: 'snippet',
        startLine: 1,
        endLine: 2,
        text: 'code',
      },
    ]);
    expect(result).toBe('q\n\n文件: `a.ts`\n\n文件: `b.ts:1-2`\n```\ncode\n```');
  });
});
