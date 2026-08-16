import { useMemo } from 'react';
import hljs from 'highlight.js/lib/core';
import bashLang from 'highlight.js/lib/languages/bash';
import { cn } from '../../lib/utils';

// 只注册 bash 语言(hljs core 按需引入,避免全量打包所有语言);
// 配色复用 markdown.tsx 全局引入的 github-dark.css(.hljs-* 类全局生效),
// 与消息中 ```bash 代码块的观感保持一致。
hljs.registerLanguage('bash', bashLang);

/**
 * 终端风格的 bash 命令渲染块:首行带 `$` 提示符 + bash 语法高亮。
 * 用于 bash 类工具调用的命令展示(ToolCallCard / ToolResultCard)。
 */
export function BashCode({
  command,
  className,
}: {
  command: string;
  className?: string;
}) {
  // 高亮结果缓存:命令文本不变时不重复计算(流式更新频繁)。
  // hljs.highlight 输出的 HTML 已对源文本转义,换行保持字面 `\n`,
  // 整体注入不会破坏 token 标签(dangerouslySetInnerHTML 是官方推荐用法)。
  const html = useMemo(() => {
    try {
      return hljs.highlight(command, { language: 'bash' }).value;
    } catch {
      // 语言注册异常等边界情况:退化为纯文本(由 React 转义,安全)
      return null;
    }
  }, [command]);

  return (
    <pre
      className={cn(
        'overflow-x-auto bg-[#0d1117] px-3 py-2 font-mono text-xs leading-relaxed',
        className,
      )}
    >
      <code className="hljs language-bash">
        <span className="select-none text-muted-foreground/60">$ </span>
        {html !== null ? (
          <span dangerouslySetInnerHTML={{ __html: html }} />
        ) : (
          <span>{command}</span>
        )}
      </code>
    </pre>
  );
}
