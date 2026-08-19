import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { EditorPane } from './EditorPane';
import { useEditorStore } from '../../stores/editorStore';
import { openSearchPanel } from '@codemirror/search';

/** 模拟 CodeMirror EditorView(onEditorReady 只需要 focus 与 dom.isConnected) */
const mockEditorView = {
  focus: vi.fn(),
  dom: { isConnected: true },
} as unknown as import('@codemirror/view').EditorView;

vi.mock('@codemirror/search', () => ({
  openSearchPanel: vi.fn(),
}));

vi.mock('./CodeEditor', async () => {
  const React = await import('react');
  return {
    // 轻量替身:挂载时同步回调 onEditorReady,模拟 CodeMirror onCreateEditor
    CodeEditor: (props: { onEditorReady?: (view: unknown) => void }) => {
      const cbRef = React.useRef(props.onEditorReady);
      cbRef.current = props.onEditorReady;
      React.useEffect(() => {
        cbRef.current?.(mockEditorView);
      }, []);
      return React.createElement('div', { 'data-testid': 'code-editor' });
    },
  };
});

vi.mock('./MarkdownPreview', async () => {
  const React = await import('react');
  return { MarkdownPreview: () => React.createElement('div', null, 'md-preview') };
});

vi.mock('../../lib/api', () => ({
  getFileContent: vi.fn(async () => ({ content: 'hello' })),
  getGitFileAtHead: vi.fn(async () => ({ content: '' })),
  putFileContent: vi.fn(async () => ({})),
  listFiles: vi.fn(async () => [
    { name: 'src', path: 'src', type: 'dir' as const, size: 0 },
    { name: 'a.rs', path: 'a.rs', type: 'file' as const, size: 1 },
  ]),
  searchFiles: vi.fn(async () => []),
}));

/** 在 window 上派生 ⌘(macOS)/Ctrl 组合键 */
function press(key: string, opts: KeyboardEventInit = {}) {
  const ev = new KeyboardEvent('keydown', {
    key,
    metaKey: true,
    bubbles: true,
    cancelable: true,
    ...opts,
  });
  window.dispatchEvent(ev);
  return ev;
}

beforeEach(() => {
  vi.clearAllMocks();
  useEditorStore.setState({ openFiles: [], activePath: null });
});

describe('EditorPane 快捷键(编辑器视图激活时)', () => {
  it('⌘/Ctrl+W 关闭当前文件并激活相邻文件', () => {
    const { openFile } = useEditorStore.getState();
    openFile('a.rs', 'a.rs', 'fn a() {}');
    openFile('b.rs', 'b.rs', 'fn b() {}');
    render(<EditorPane workspaceId="w1" />);

    const ev = press('w');
    expect(ev.defaultPrevented).toBe(true);
    const st = useEditorStore.getState();
    expect(st.openFiles.map((f) => f.path)).toEqual(['a.rs']);
    expect(st.activePath).toBe('a.rs');
  });

  it('isActive=false(非编辑器视图)时不响应 ⌘W', () => {
    const { openFile } = useEditorStore.getState();
    openFile('a.rs', 'a.rs', 'fn a() {}');
    render(<EditorPane workspaceId="w1" isActive={false} />);

    press('w');
    expect(useEditorStore.getState().openFiles).toHaveLength(1);
  });

  it('⌘/Ctrl+F 打开当前文件的编辑器内搜索面板', () => {
    useEditorStore.getState().openFile('a.rs', 'a.rs', 'fn a() {}');
    render(<EditorPane workspaceId="w1" />);

    // CodeEditor 替身挂载后 onEditorReady 已填充 editorViewRef
    expect(screen.getByTestId('code-editor')).toBeTruthy();
    press('f');
    expect(openSearchPanel).toHaveBeenCalledWith(mockEditorView);
    expect(mockEditorView.focus).toHaveBeenCalled();
  });

  it('⌘/Ctrl+F 在 markdown 预览模式下先切编辑模式再打开面板', async () => {
    useEditorStore.getState().openFile('README.md', 'README.md', '# hello');
    render(<EditorPane workspaceId="w1" />);

    // 初始为预览模式(无 CodeEditor)
    expect(screen.queryByTestId('code-editor')).toBeNull();
    act(() => {
      press('f');
    });
    // 切到编辑模式后 CodeEditor 挂载,onEditorReady 补发搜索面板
    expect(await screen.findByTestId('code-editor')).toBeTruthy();
    await waitFor(() => {
      expect(openSearchPanel).toHaveBeenCalledWith(mockEditorView);
    });
  });

  it('⌘/Ctrl+Shift+F 聚焦文件树跨文件搜索框', () => {
    render(<EditorPane workspaceId="w1" />);

    const input = document.querySelector<HTMLInputElement>('input[data-file-search]');
    expect(input).toBeTruthy();
    expect(document.activeElement).not.toBe(input);
    act(() => {
      press('F', { shiftKey: true });
    });
    expect(document.activeElement).toBe(input);
  });

  it('⌘/Ctrl+Alt+←/→ 在打开文件 tab 间循环切换', () => {
    const { openFile, setActive } = useEditorStore.getState();
    openFile('a.rs', 'a.rs', 'a');
    openFile('b.rs', 'b.rs', 'b');
    openFile('c.rs', 'c.rs', 'c');
    setActive('c.rs'); // 顺序打开后 active 为 c,显式固定便于断言循环
    render(<EditorPane workspaceId="w1" />);

    press('ArrowRight', { altKey: true });
    expect(useEditorStore.getState().activePath).toBe('a.rs'); // 末尾循环到首个

    press('ArrowLeft', { altKey: true });
    expect(useEditorStore.getState().activePath).toBe('c.rs'); // 首个循环回末尾
  });

  it('⌘/Ctrl+S 保存脏文件并清除脏标记', async () => {
    const { openFile, setContent } = useEditorStore.getState();
    openFile('a.rs', 'a.rs', 'old');
    setContent('a.rs', 'new');
    render(<EditorPane workspaceId="w1" />);

    press('s');
    const { putFileContent } = await import('../../lib/api');
    await waitFor(() => {
      expect(putFileContent).toHaveBeenCalledWith('w1', 'a.rs', 'new');
    });
    // 保存成功后脏标记清空
    await waitFor(() => {
      expect(useEditorStore.getState().openFiles[0]?.dirty).toBe(false);
    });
  });

  it('无打开文件时 ⌘/Ctrl+W 不拦截默认行为', () => {
    render(<EditorPane workspaceId="w1" />);
    const ev = press('w');
    expect(ev.defaultPrevented).toBe(false);
  });
});
