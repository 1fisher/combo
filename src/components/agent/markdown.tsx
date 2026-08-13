import { useState, isValidElement, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { cn } from '../../lib/utils';
import { openExternal } from '../../lib/openExternal';
import 'highlight.js/styles/github-dark.css';

/** 递归提取 React 节点树中的纯文本(用于代码块复制按钮) */
function extractText(node: ReactNode): string {
  if (node === null || node === undefined) return '';
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(extractText).join('');
  if (isValidElement(node)) {
    const props = node.props as { children?: ReactNode };
    return extractText(props.children);
  }
  return '';
}

function CodeBlock({
  lang,
  code,
  children,
}: {
  lang: string;
  code: string;
  children?: ReactNode;
}) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* 剪贴板不可用时静默 */
    }
  }
  return (
    <div className="my-2 overflow-hidden rounded-lg border bg-[#0d1117]">
      <div className="flex items-center justify-between border-b border-white/10 bg-white/5 px-3 py-1">
        <span className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
          {lang || 'code'}
        </span>
        <button
          onClick={copy}
          className="rounded px-1.5 font-mono text-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          {copied ? '已复制' : '复制'}
        </button>
      </div>
      <pre className="overflow-x-auto p-3 font-mono text-xs leading-relaxed [&_code]:bg-transparent [&_code]:p-0">
        {children}
      </pre>
    </div>
  );
}

/** 聊天气泡内的紧凑排版 */
const CHAT_PROSE =
  'space-y-1 text-sm leading-relaxed ' +
  '[&_p]:my-1 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 ' +
  '[&_li]:my-0.5 [&_li:has(>input)]:list-none [&_li:has(>input)]:ml-0 [&_li:has(>input)]:pl-0 ' +
  '[&_input[type=checkbox]]:mr-1.5 [&_input[type=checkbox]]:accent-primary ' +
  '[&_h1]:text-base [&_h1]:font-semibold [&_h1]:mt-3 [&_h1]:mb-1 ' +
  '[&_h2]:text-sm [&_h2]:font-semibold [&_h2]:mt-2 [&_h2]:mb-1 ' +
  '[&_h3]:text-sm [&_h3]:font-medium [&_h3]:mt-2 [&_h3]:mb-0.5 ' +
  '[&_a]:font-medium [&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2 ' +
  '[&_blockquote]:border-l-2 [&_blockquote]:border-primary/40 [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground ' +
  '[&_del]:text-muted-foreground [&_del]:line-through ' +
  '[&_table]:w-full [&_table]:border-collapse [&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1 ' +
  '[&_th]:border [&_th]:border-border [&_th]:px-2 [&_th]:py-1 [&_th]:bg-muted [&_tr]:border-border ' +
  '[&_hr]:my-2 [&_hr]:border-border';

/** 文件预览中的宽松文档排版 */
const DOC_PROSE =
  'text-[15px] leading-7 ' +
  '[&_p]:my-4 [&_ul]:my-4 [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:my-4 [&_ol]:list-decimal [&_ol]:pl-6 ' +
  '[&_li]:my-1 [&_li:has(>input)]:list-none [&_li:has(>input)]:ml-0 [&_li:has(>input)]:pl-0 ' +
  '[&_input[type=checkbox]]:mr-1.5 [&_input[type=checkbox]]:accent-primary ' +
  '[&_h1]:mt-7 [&_h1]:mb-3 [&_h1]:text-2xl [&_h1]:font-bold [&_h1]:border-b [&_h1]:pb-2 [&_h1]:border-border ' +
  '[&_h2]:mt-6 [&_h2]:mb-3 [&_h2]:text-xl [&_h2]:font-semibold ' +
  '[&_h3]:mt-5 [&_h3]:mb-2 [&_h3]:text-lg [&_h3]:font-semibold ' +
  '[&_h4]:mt-4 [&_h4]:mb-2 [&_h4]:text-base [&_h4]:font-medium ' +
  '[&_a]:font-medium [&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2 ' +
  '[&_blockquote]:my-4 [&_blockquote]:border-l-2 [&_blockquote]:border-primary/40 [&_blockquote]:pl-4 [&_blockquote]:text-muted-foreground ' +
  '[&_del]:text-muted-foreground [&_del]:line-through ' +
  '[&_table]:my-4 [&_table]:w-full [&_table]:border-collapse [&_td]:border [&_td]:border-border [&_td]:px-3 [&_td]:py-1.5 ' +
  '[&_th]:border [&_th]:border-border [&_th]:px-3 [&_th]:py-1.5 [&_th]:bg-muted [&_tr]:border-border ' +
  '[&_hr]:my-6 [&_hr]:border-border [&_img]:mx-auto [&_img]:rounded-lg';

export function Markdown({
  text,
  streaming = false,
  variant = 'chat',
}: {
  text: string;
  streaming?: boolean;
  variant?: 'chat' | 'document';
}) {
  // 流式时在末尾追加 ▍ 光标,提示内容仍在生成
  const body = streaming ? `${text}\u258D` : text;
  return (
    <div className={cn(variant === 'document' ? DOC_PROSE : CHAT_PROSE)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
        components={{
          a({ href, children }) {
            return (
              <a
                href={href}
                onClick={(e) => {
                  // 阻止默认跳转(避免在 webview/当前标签页内导航),
                  // 仅 cmd(Mac)/ctrl(Windows)+click 时在系统默认浏览器打开
                  e.preventDefault();
                  if (e.metaKey || e.ctrlKey) {
                    void openExternal(href ?? '');
                  }
                }}
              >
                {children}
              </a>
            );
          },
          pre({ children }) {
            const codeEl = children as React.ReactElement<{
              className?: string;
              children?: ReactNode;
            }>;
            const className = codeEl?.props?.className ?? '';
            const lang = className.match(/language-([\w-]+)/)?.[1] ?? '';
            const code = extractText(codeEl?.props?.children);
            return (
              <CodeBlock lang={lang} code={code}>
                {children}
              </CodeBlock>
            );
          },
          code({ className, children }) {
            // rehype-highlight 给代码块的 <code> 加了 hljs 类,不再追加行内样式
            if (className?.includes('hljs')) {
              return <code className={className}>{children}</code>;
            }
            return (
              <code
                className={cn(
                  'rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]',
                  className
                )}
              >
                {children}
              </code>
            );
          },
        }}
      >
        {body}
      </ReactMarkdown>
    </div>
  );
}
