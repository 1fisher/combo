import { useEffect, useMemo, useRef, useState } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { EditorView } from '@codemirror/view';
import { oneDark } from '@codemirror/theme-one-dark';
import { search } from '@codemirror/search';
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
import { searchHighlightPlugin } from './searchHighlight';
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
  onEditorReady,
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
  /** 编辑器创建/更新时回调,暴露 EditorView 供外部控制 */
  onEditorReady?: (view: EditorView) => void;
}) {
  const viewRef = useRef<EditorView | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const addItem = useContextStore((s) => s.addItem);

  const extensions = useMemo(() => {
    const lang = langForFile(filename);
    const exts = lang ? [lang, EditorView.lineWrapping] : [EditorView.lineWrapping];
    // 文件内搜索面板(定位在顶部)
    exts.push(search({ top: true }));
    // 侧边栏搜索结果高亮(自定义 Decoration 插件,可靠无状态问题)
    const q = highlightQuery?.trim();
    if (q) {
      exts.push(searchHighlightPlugin(q));
    }
    // 高亮匹配样式 — 侧边栏搜索用蓝绿色,文件内搜索面板用黄色,便于区分
    exts.push(
      EditorView.theme({
        // 侧边栏搜索结果高亮(来自 FileExplorer 的 highlightQuery)
        '.cm-sidebar-search-match': {
          'background-color': 'rgba(20, 184, 166, 0.45)',
          'outline': '1.5px solid rgba(20, 184, 166, 0.9)',
          'border-radius': '2px',
        },
        // 文件内搜索面板高亮(CodeMirror search extension)
        '.cm-searchMatch': {
          'background-color': 'rgba(255, 213, 79, 0.4)',
          'border-radius': '2px',
        },
        '.cm-searchMatch.cm-searchMatch-selected': {
          'background-color': 'rgba(255, 170, 0, 0.6)',
          'outline': '1.5px solid rgba(255, 170, 0, 0.9)',
        },
        // 搜索面板定位在顶部
        '.cm-panels': { 'border-bottom': '1px solid var(--border)' },
        '.cm-search-panel': { 'background-color': 'rgba(30, 30, 46, 0.95)' },
      }),
    );
    if (headContent !== undefined) {
      exts.push(...createGitGutter(headContent));
    }
    return exts;
  }, [filename, headContent, highlightQuery]);

  // 滚动到指定行(文档内容变化后执行)
  useEffect(() => {
    const view = viewRef.current;
    if (!view || !highlightLine) return;
    const raf = requestAnimationFrame(() => {
      try {
        const line = view.state.doc.line(highlightLine);
        view.dispatch({
          selection: { anchor: line.from },
          effects: EditorView.scrollIntoView(line.from, { y: 'center' }),
        });
      } catch {
        // 行号超出范围,忽略
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [highlightLine, value]);

  // 监听搜索面板出现,用图标替换文字按钮
  const containerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    function restylePanel() {
      const panel = container!.querySelector('.cm-panel.cm-search');
      if (!panel || (panel as HTMLElement).dataset.styled) return;
      (panel as HTMLElement).dataset.styled = '1';

      // 替换按钮文字:导航保持图标,选项按钮参考 VS Code 样式
      panel.querySelectorAll('button[name]').forEach((btn) => {
        const name = btn.getAttribute('name');
        const iconMap: Record<string, string> = {
          next: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>',
          prev: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>',
          select: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>',
          replace: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-15-6.7L3 13"/></svg>',
          replaceAll: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-15-6.7L3 13"/><path d="M17 7v6h4"/></svg>',
        };
        if (iconMap[name!]) {
          btn.innerHTML = iconMap[name!];
          btn.setAttribute('title', btn.textContent || name || '');
          // 导航按钮(next/prev/select)去掉外边框,仅保留图标
          const isNav = name === 'next' || name === 'prev' || name === 'select';
          (btn as HTMLElement).style.cssText =
            'display:inline-flex;align-items:center;justify-content:center;padding:2px 4px;' +
            (isNav ? 'border:none;background:transparent;color:inherit;' : '');
        }
      });

      // 替换 label 文字:参考 VS Code 样式(match case → aA,regexp → .*,by word → ab)
      panel.querySelectorAll('label').forEach((label) => {
        const text = label.textContent || '';
        if (text.includes('match case')) {
          // 保留 checkbox,替换文字为 aA(VS Code 匹配大小写样式)
          const checkbox = label.querySelector('input[type=checkbox]');
          label.innerHTML = '';
          if (checkbox) label.appendChild(checkbox);
          const icon = document.createElement('span');
          icon.textContent = 'aA';
          icon.title = 'Match Case';
          icon.style.cssText =
            'font-family:Verdana,sans-serif;font-size:11px;font-weight:700;cursor:pointer;line-height:1;';
          label.appendChild(icon);
          label.title = 'Match Case';
        } else if (text.includes('regexp')) {
          const checkbox = label.querySelector('input[type=checkbox]');
          label.innerHTML = '';
          if (checkbox) label.appendChild(checkbox);
          const icon = document.createElement('span');
          icon.textContent = '.*';
          icon.style.cssText =
            'font-family:monospace;font-size:12px;font-weight:700;cursor:pointer;line-height:1;';
          icon.title = 'RegExp';
          label.appendChild(icon);
          label.title = 'RegExp';
        } else if (text.includes('by word')) {
          const checkbox = label.querySelector('input[type=checkbox]');
          label.innerHTML = '';
          if (checkbox) label.appendChild(checkbox);
          const icon = document.createElement('span');
          icon.textContent = 'ab';
          icon.style.cssText =
            'font-family:Verdana,sans-serif;font-size:11px;font-weight:700;cursor:pointer;line-height:1;text-decoration:underline;text-underline-offset:2px;';
          icon.title = 'Whole Word';
          label.appendChild(icon);
          label.title = 'Whole Word';
        }
      });

      // 隐藏选项 checkbox,由外层 label 点击触发;选中时 label 显示外边框
      panel.querySelectorAll('label input[type=checkbox]').forEach((cb) => {
        const style = cb as HTMLInputElement;
        style.style.cssText =
          'position:absolute;opacity:0;pointer-events:none;width:0;height:0;';
        const label = style.closest('label')!;
        label.style.cssText =
          'display:inline-flex;align-items:center;gap:2px;margin:0 .4em 0 0;cursor:pointer;user-select:none;' +
          'border:1px solid transparent;border-radius:3px;padding:1px 3px;';
        const updateActive = () => {
          label.style.borderColor = style.checked
            ? 'rgba(94, 234, 212, 0.8)'
            : 'transparent';
          label.style.backgroundColor = style.checked
            ? 'rgba(94, 234, 212, 0.12)'
            : 'transparent';
        };
        style.addEventListener('change', updateActive);
        updateActive();
      });

      // 参考 VS Code 重排元素顺序:折叠按钮 → 输入框 → 选项 → 导航 → 替换区(默认折叠)→ 关闭
      const searchInput = panel.querySelector('input[name=search]');
      const labels = Array.from(panel.querySelectorAll('label'));
      const navButtons = panel.querySelectorAll('button[name="next"], button[name="prev"], button[name="select"]');
      const closeBtn = panel.querySelector('button[name="close"]');
      const replaceBtns = panel.querySelectorAll('button[name="replace"], button[name="replaceAll"]');
      const replaceField = panel.querySelector('input[name="replace"]');
      const brEl = Array.from(panel.children).find((el) => el.tagName === 'BR');

      // 折叠切换按钮:搜索框前的 > / v 图标,展开/收起替换区
      const replaceArea = document.createElement('span');
      replaceArea.style.cssText =
        'display:none;width:100%;' +
        'align-items:center;gap:4px;' +
        'margin:.2em 0 0;';
      if (replaceField) {
        // 替换框与搜索框左对齐并占满整行
        (replaceField as HTMLInputElement).style.flex = '1';
        (replaceField as HTMLInputElement).style.marginLeft = '0';
        replaceArea.appendChild(replaceField);
      }
      if (replaceBtns[0]) replaceArea.appendChild(replaceBtns[0]);
      if (replaceBtns[1]) replaceArea.appendChild(replaceBtns[1]);
      if (brEl) brEl.remove();

      const toggleBtn = document.createElement('button');
      toggleBtn.type = 'button';
      toggleBtn.className = 'cm-button cm-replace-toggle';
      toggleBtn.title = '切换替换';
      // 默认右箭头 >,展开后向下 v
      const chevronRight =
        '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>';
      const chevronDown =
        '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>';
      toggleBtn.innerHTML = chevronRight;
      toggleBtn.style.cssText =
        'display:inline-flex;align-items:center;justify-content:center;' +
        'padding:2px 3px;margin:0 .2em 0 0;background:none;border:none;' +
        'color:inherit;cursor:pointer;font-size:0;';
      let expanded = false;
      toggleBtn.addEventListener('click', () => {
        expanded = !expanded;
        replaceArea.style.display = expanded ? 'flex' : 'none';
        toggleBtn.innerHTML = expanded ? chevronDown : chevronRight;
      });

      const ordered = [
        toggleBtn,
        searchInput,
        ...labels, // aA → .* → ab(匹配 DOM 顺序:case, regexp, word)
        navButtons[1], // prev
        navButtons[0], // next
        navButtons[2], // all
        closeBtn,
      ].filter(Boolean) as Element[];

      // 按新顺序重新挂载(VS Code 布局)
      for (const el of ordered) {
        panel.appendChild(el);
      }
      // 替换区(默认折叠)附加到面板末尾
      panel.appendChild(replaceArea);
    }

    const observer = new MutationObserver(() => restylePanel());
    observer.observe(container, { childList: true, subtree: true });
    restylePanel();
    return () => observer.disconnect();
  }, []);

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
        ref={containerRef}
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
            onEditorReady?.(view);
          }}
          basicSetup={{
            lineNumbers: true,
            highlightActiveLine: true,
            highlightActiveLineGutter: true,
            foldGutter: false,
            autocompletion: false,
            searchKeymap: true,
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
