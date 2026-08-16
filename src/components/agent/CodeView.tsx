import { useMemo, type ReactNode } from 'react';
import { common, createLowlight } from 'lowlight';
import dart from 'highlight.js/lib/languages/dart';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import powershell from 'highlight.js/lib/languages/powershell';
import scala from 'highlight.js/lib/languages/scala';
import type { Root, RootContent } from 'hast';
import { cn } from '../../lib/utils';

/**
 * 工具结果代码视图:按文件类型(lowlight/highlight.js 语法)高亮,
 * 可选行号列。用于 read 工具返回的文件内容、write 工具的输入内容等。
 *
 * 语言实例复用 lowlight common 语言集(与 rehype-highlight 渲染 markdown
 * 代码块共享同一批 grammar 模块,打包零冗余),另按需补充 common 缺失的
 * dart/scala/dockerfile/powershell。配色复用全局引入的 github-dark.css。
 */
const lowlight = createLowlight(common);
lowlight.register({ dart, dockerfile, powershell, scala });

/** 高亮结果缓存的语言名 → 是否已注册(未注册语言按纯文本渲染) */
export function isLangRegistered(lang: string): boolean {
  return lowlight.registered(lang);
}

/** hast 节点 → React 节点(hljs 输出只含 element/text,其余类型丢弃) */
function hastToReact(children: RootContent[], keyPrefix: string): ReactNode[] {
  return children.map((child, i) => {
    if (child.type === 'text') return child.value;
    if (child.type === 'element') {
      const cls = child.properties?.className;
      const className = Array.isArray(cls)
        ? cls.join(' ')
        : typeof cls === 'string'
          ? cls
          : undefined;
      return (
        <span key={`${keyPrefix}${i}`} className={className}>
          {hastToReact(child.children, `${keyPrefix}${i}.`)}
        </span>
      );
    }
    return null;
  });
}

export function CodeView({
  code,
  language,
  /** 与 code 行数一致的真实行号(1-based);不传则不渲染行号列 */
  lineNumbers,
  className,
}: {
  code: string;
  /** highlight.js 语言名;未注册或为空时按纯文本渲染 */
  language?: string | null;
  lineNumbers?: number[];
  className?: string;
}) {
  const nodes = useMemo<ReactNode[] | null>(() => {
    if (!language || !lowlight.registered(language)) return null;
    try {
      const root: Root = lowlight.highlight(language, code);
      return hastToReact(root.children, '');
    } catch {
      // 语法解析异常:退化为纯文本(由 React 转义,安全)
      return null;
    }
  }, [language, code]);

  return (
    <div
      className={cn(
        'flex max-h-[60vh] overflow-auto bg-[#0d1117] font-mono text-[11px] leading-relaxed',
        className,
      )}
    >
      {lineNumbers && lineNumbers.length > 0 && (
        <pre className="select-none shrink-0 border-r border-white/5 bg-white/[0.02] px-2 py-2 text-right text-muted-foreground/40">
          {lineNumbers.join('\n')}
        </pre>
      )}
      <pre className="min-w-0 flex-1 px-3 py-2">
        <code className={language ? `hljs language-${language}` : 'hljs'}>
          {nodes ?? code}
        </code>
      </pre>
    </div>
  );
}
