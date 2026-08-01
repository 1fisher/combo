import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { cn } from '../../lib/utils';

function CodeBlock({ lang, code }: { lang: string; code: string }) {
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
    <div className="my-2 overflow-hidden rounded-lg border bg-muted/40">
      <div className="flex items-center justify-between border-b bg-muted/60 px-3 py-1">
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
      <pre className="overflow-x-auto p-3 font-mono text-xs leading-relaxed">
        <code>{code}</code>
      </pre>
    </div>
  );
}

export function Markdown({ text, streaming = false }: { text: string; streaming?: boolean }) {
  // 流式时在末尾追加 ▍ 光标,提示内容仍在生成
  const body = streaming ? `${text}\u258D` : text;
  return (
    <div className="space-y-1 text-sm leading-relaxed [&_p]:my-1 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_h1]:text-base [&_h1]:font-semibold [&_h2]:text-sm [&_h2]:font-semibold [&_h3]:text-sm [&_h3]:font-medium [&_a]:font-medium [&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2 [&_blockquote]:border-l-2 [&_blockquote]:border-primary/40 [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground [&_table]:w-full [&_table]:border-collapse [&_td]:border [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:px-2 [&_th]:py-1 [&_th]:bg-muted [&_hr]:my-2 [&_hr]:border-border">
      <ReactMarkdown
        components={{
          pre({ children }) {
            const el = children as React.ReactElement<{
              className?: string;
              children?: React.ReactNode;
            }>;
            const lang = (el?.props?.className ?? '').replace(/^language-/, '');
            return <CodeBlock lang={lang} code={String(el?.props?.children ?? '')} />;
          },
          code({ className, children }) {
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
