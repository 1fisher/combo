import { useEffect, useMemo, useRef, useState } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { EditorView } from '@codemirror/view';
import { oneDark } from '@codemirror/theme-one-dark';
import { search, SearchQuery, setSearchQuery } from '@codemirror/search';
import { go } from '@codemirror/lang-go';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { python } from '@codemirror/lang-python';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { markdown } from '@codemirror/lang-markdown';
import { rust } from '@codemirror/lang-rust';
import { FileText, MessageSquarePlus, Quote } from 'lucide-react';
import { createGitGutter } from './gitGutter';
import { useContextStore } from '../../stores/contextStore';
import { ContextMenu, type MenuItem } from '../ui/ContextMenu';

function extOf(filename: string): string {
  const lower = filename.toLowerCase();
  const idx = lower.lastIndexOf('.');
  return idx >= 0 ? lower.slice(idx) : '';
}

function langForFile(filename: string) {
  switch (extOf(filename)) {
    case '.go':
      return go();
    case '.ts':
    case '.mts':
    case '.cts':
      return javascript({ typescript: true });
    case '.tsx':
      return javascript({ jsx: true, typescript: true });
    case '.js':
    case '.mjs':
    case '.cjs':
      return javascript();
    case '.jsx':
      return javascript({ jsx: true });
    case '.json':
      return json();
    case '.py':
      return python();
    case '.css':
      return css();
    case '.html':
    case '.htm':
    case '.xml':
    case '.svg':
      return html();
    case '.md':
    case '.markdown':
      return markdown();
    case '.rs':
      return rust();
    default:
      return undefined;
  }
}

export function CodeEditor({
  value,
  filename,
  filePath,
  onChange,
  headContent,
  highlightQuery,
  highlightLine,
}: {
  value: string;
  filename: string;
  filePath?: string;
  onChange: (value: string) => void;
  /** 文件在 HEAD 的内容;提供后启用 git gutter 行标记 */
  headContent?: string;
  /** 搜索高亮关键词;提供后在编辑器内高亮所有匹配 */
  highlightQuery?: string | null;
  /** 搜索结果定位行号;打开后滚动到该行 */
  highlightLine?: number | null;
}) {
  const viewRef = useRef<EditorView | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const addItem = useContextStore((s) => s.addItem);

  const extensions = useMemo(() => {
    const lang = langForFile(filename);
    const exts = lang ? [lang, EditorView.lineWrapping] : [EditorView.lineWrapping];
    // 搜索高亮扩展(始终挂载,通过 setSearchQuery effect 控制查询)
    exts.push(
      search({
        top: false,
        createPanel: () => null as never,
      }),
    );
    if (headContent !== undefined) {
      exts.push(...createGitGutter(headContent));
    }
    return exts;
  }, [filename, headContent]);

  // 更新编辑器搜索高亮
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const q = highlightQuery?.trim() || '';
    view.dispatch({
      effects: setSearchQuery.of(
        new SearchQuery({
          search: q || '',
          caseSensitive: false,
        }),
      ),
    });
  }, [highlightQuery]);

  // 滚动到指定行
  useEffect(() => {
    const view = viewRef.current;
    if (!view || !highlightLine) return;
    try {
      const line = view.state.doc.line(highlightLine);
      view.dispatch({
        selection: { anchor: line.from },
        effects: EditorView.scrollIntoView(line.from, { y: 'center' }),
      });
    } catch {
      // 行号超出范围,忽略
    }
  }, [highlightLine, value]);

  /** 取当前选区;无选区返回 null */
  function getSelection() {
    const view = viewRef.current;
    if (!view) return null;
    const { from, to } = view.state.selection.main;
    if (from === to) return null;
    const selectedText = view.state.sliceDoc(from, to);
    const startLine = view.state.doc.lineAt(from).number;
    const endLine = view.state.doc.lineAt(to).number;
    return { selectedText, startLine, endLine };
  }

  function addSnippet() {
    if (!filePath) return;
    const sel = getSelection();
    if (!sel) return;
    addItem({
      filePath,
      fileName: filename,
      type: 'snippet',
      startLine: sel.startLine,
      endLine: sel.endLine,
      text: sel.selectedText,
    });
  }

  function addFile() {
    if (!filePath) return;
    addItem({ filePath, fileName: filename, type: 'file' });
  }

  // 全局快捷键:⌥1 = 选中代码(无选区则添加文件),⌥2 = 添加文件
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      const match = /^Digit(\d)$/.exec(e.code);
      if (!match) return;
      const num = parseInt(match[1], 10);
      if (num === 1) {
        const sel = getSelection();
        if (sel) addSnippet();
        else addFile();
        e.preventDefault();
        e.stopPropagation();
      } else if (num === 2) {
        addFile();
        e.preventDefault();
        e.stopPropagation();
      }
    }
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePath, filename]);

  function buildMenuItems(): MenuItem[] {
    const items: MenuItem[] = [];
    const hasSelection = !!getSelection();

    if (hasSelection && filePath) {
      items.push({
        label: '添加选中代码',
        icon: <Quote className="size-3.5 text-muted-foreground" />,
        onClick: addSnippet,
      });
    }

    if (filePath) {
      items.push({
        label: '添加文件',
        icon: hasSelection ? (
          <FileText className="size-3.5 text-muted-foreground" />
        ) : (
          <MessageSquarePlus className="size-3.5 text-muted-foreground" />
        ),
        onClick: addFile,
      });
    }

    return items;
  }

  return (
    <>
      <div
        className="h-full"
        onContextMenu={(e) => {
          if (!filePath) return;
          const items = buildMenuItems();
          if (items.length === 0) return;
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY });
        }}
      >
        <CodeMirror
          value={value}
          onChange={onChange}
          extensions={extensions}
          theme={oneDark}
          height="100%"
          style={{ height: '100%', fontSize: '13px' }}
          onCreateEditor={(view) => {
            viewRef.current = view;
          }}
          basicSetup={{
            lineNumbers: true,
            highlightActiveLine: true,
            highlightActiveLineGutter: true,
            foldGutter: false,
            autocompletion: false,
            searchKeymap: false,
          }}
        />
      </div>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={buildMenuItems()}
          onClose={() => setMenu(null)}
        />
      )}
    </>
  );
}
