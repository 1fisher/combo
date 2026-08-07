import { useMemo } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { EditorView } from '@codemirror/view';
import { oneDark } from '@codemirror/theme-one-dark';
import { go } from '@codemirror/lang-go';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { python } from '@codemirror/lang-python';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { markdown } from '@codemirror/lang-markdown';
import { rust } from '@codemirror/lang-rust';
import { createGitGutter } from './gitGutter';

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
  onChange,
  headContent,
}: {
  value: string;
  filename: string;
  onChange: (value: string) => void;
  /** 文件在 HEAD 的内容;提供后启用 git gutter 行标记 */
  headContent?: string;
}) {
  const extensions = useMemo(() => {
    const lang = langForFile(filename);
    const exts = lang ? [lang, EditorView.lineWrapping] : [EditorView.lineWrapping];
    if (headContent !== undefined) {
      exts.push(...createGitGutter(headContent));
    }
    return exts;
  }, [filename, headContent]);

  return (
    <CodeMirror
      value={value}
      onChange={onChange}
      extensions={extensions}
      theme={oneDark}
      height="100%"
      style={{ height: '100%', fontSize: '13px' }}
      basicSetup={{
        lineNumbers: true,
        highlightActiveLine: true,
        highlightActiveLineGutter: true,
        foldGutter: false,
        autocompletion: false,
        searchKeymap: false,
      }}
    />
  );
}
