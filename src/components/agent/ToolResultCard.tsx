import { useState } from 'react';
import { ChevronDown, ChevronRight, CheckCircle, XCircle, Terminal } from 'lucide-react';
import type { Api } from '../../lib/api/types';

const COLLAPSE_THRESHOLD = 800;

function detectKind(name: string, content: string): 'bash' | 'json' | 'text' {
  if (name === 'bash' || name === 'run_shell_command') return 'bash';
  const trimmed = content.trim();
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    return 'json';
  }
  return 'text';
}

function tryFormatJson(content: string): string {
  try {
    return JSON.stringify(JSON.parse(content), null, 2);
  } catch {
    return content;
  }
}

export function ToolResultCard({ result }: { result: Api.ToolResult }) {
  const [expanded, setExpanded] = useState(false);
  const isError = result.is_error ?? false;
  const content = result.content ?? '';
  const kind = detectKind(result.name, content);
  const displayContent = kind === 'json' ? tryFormatJson(content) : content;
  const isLong = displayContent.length > COLLAPSE_THRESHOLD;
  const visibleContent = expanded || !isLong ? displayContent : displayContent.slice(0, COLLAPSE_THRESHOLD);

  // 提取 metadata 中的行数/状态信息
  let metaInfo = '';
  if (result.metadata) {
    try {
      const meta = JSON.parse(result.metadata) as Record<string, unknown>;
      const parts: string[] = [];
      if (typeof meta.rows === 'number') parts.push(`${meta.rows} 行`);
      if (typeof meta.exit_code === 'number' && meta.exit_code !== 0) parts.push(`退出码 ${meta.exit_code}`);
      if (typeof meta.duration_ms === 'number') parts.push(`${meta.duration_ms}ms`);
      metaInfo = parts.join(' · ');
    } catch {
      /* ignore */
    }
  }

  return (
    <details className="rounded-md border bg-muted/20" open={isError}>
      <summary className="flex cursor-pointer items-center gap-2 px-3 py-1.5">
        {expanded ? (
          <ChevronDown className="size-3 text-muted-foreground" />
        ) : (
          <ChevronRight className="size-3 text-muted-foreground" />
        )}
        {isError ? (
          <XCircle className="size-3.5 text-red-500" />
        ) : (
          <CheckCircle className="size-3.5 text-green-500" />
        )}
        <span className="font-mono text-[11px] text-muted-foreground">
          {kind === 'bash' ? '终端输出' : `${result.name} 返回`}
        </span>
        {metaInfo && <span className="text-[10px] text-muted-foreground/60">{metaInfo}</span>}
        {isLong && !expanded && (
          <span className="ml-auto text-[10px] text-brand">
            {displayContent.length.toLocaleString()} 字符 · 点击展开
          </span>
        )}
      </summary>
      <div className="border-t border-border">
        {kind === 'bash' && (
          <div className="flex items-center gap-1 bg-muted/30 px-3 py-1 text-[10px] text-muted-foreground">
            <Terminal className="size-3" />
            <span className="font-mono">{result.name}</span>
          </div>
        )}
        <pre className="max-h-[60vh] overflow-auto bg-background px-3 py-2 font-mono text-[11px] leading-relaxed text-foreground/80">
          {visibleContent}
          {isLong && !expanded && (
            <span className="text-muted-foreground/50"> {'\n'}… ({displayContent.length - COLLAPSE_THRESHOLD} 字符已折叠)</span>
          )}
        </pre>
        {isLong && (
          <button
            onClick={(e) => {
              e.preventDefault();
              setExpanded((v) => !v);
            }}
            className="w-full border-t border-border py-1 text-center text-[10px] text-brand hover:bg-surface-hover"
          >
            {expanded ? '收起' : '展开全部'}
          </button>
        )}
      </div>
    </details>
  );
}
