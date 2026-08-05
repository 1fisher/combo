import { useState, isValidElement, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { cn } from '../../lib/utils';
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

export function Markdown({
  text,
  streaming = false,
}: {
  text: string;
  streaming?: boolean;
}) {
  // 流式时在末尾追加 ▍ 光标,提示内容仍在生成
  const body = streaming ? `${text}\u258D` : text;
  return (
    <div className="space-y-1 text-sm leading-relaxed [&_p]:my-1 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-0.5 [&_li:has(>input)]:list-none [&_li:has(>input)]:ml-0 [&_li:has(>input)]:pl-0 [&_input[type=checkbox]]:mr-1.5 [&_input[type=checkbox]]:accent-primary [&_h1]:text-base [&_h1]:font-semibold [&_h1]:mt-3 [&_h1]:mb-1 [&_h2]:text-sm [&_h2]:font-semibold [&_h2]:mt-2 [&_h2]:mb-1 [&_h3]:text-sm [&_h3]:font-medium [&_h3]:mt-2 [&_h3]:mb-0.5 [&_a]:font-medium [&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2 [&_blockquote]:border-l-2 [&_blockquote]:border-primary/40 [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground [&_del]:text-muted-foreground [&_del]:line-through [&_table]:w-full [&_table]:border-collapse [&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:border-border [&_th]:px-2 [&_th]:py-1 [&_th]:bg-muted [&_tr]:border-border [&_hr]:my-2 [&_hr]:border-border">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
        components={{
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
