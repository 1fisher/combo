import { useMemo, useState } from 'react';
import { ChevronRight, CheckCircle, XCircle, Terminal } from 'lucide-react';
import type { Api } from '../../lib/api/types';
import { useAgentStore } from '../../stores/agentStore';
import { countChanges, diffFromToolInput, type DiffLine } from '../../lib/fileChanges';
import { DiffView } from './DiffView';
import { TerminalOutput } from './TerminalOutput';
import { JsonView, tryParseJson } from './JsonView';

const FILE_DIFF_TOOLS = new Set(['write', 'edit', 'multiedit']);
const BASH_TOOLS = new Set(['bash', 'run_shell_command']);
const COLLAPSE_THRESHOLD = 600;

/** 从 store 中查找 tool_call_id 对应的工具输入 */
function useToolCallInput(toolCallId: string): { name: string; input: string } | null {
  const sessionId = useAgentStore((s) => s.activeSessionId);
  const messages = useAgentStore((s) =>
    sessionId ? s.bySession[sessionId]?.messages : undefined,
  );
  return useMemo(() => {
    if (!messages) return null;
    for (const msg of messages) {
      for (const part of msg.parts) {
        if (part.type !== 'tool_call') continue;
        const tc = part.data as Api.ToolCall;
        if (tc.id === toolCallId) return { name: tc.name, input: tc.input };
      }
    }
    return null;
  }, [messages, toolCallId]);
}

export function ToolResultCard({ result }: { result: Api.ToolResult }) {
  const [expanded, setExpanded] = useState(false);
  const isError = result.is_error ?? false;
  const content =
    typeof result.content === 'string'
      ? result.content
      : result.content
        ? JSON.stringify(result.content, null, 2)
        : '';
  const toolCall = useToolCallInput(result.tool_call_id);
  // 后端可能缺 name(如旧版 combo-cli 的 tool_result),回退到配对 tool_call 的名字
  const name = result.name || toolCall?.name || '工具';

  const isFileTool = FILE_DIFF_TOOLS.has(name);
  const isBash = BASH_TOOLS.has(name) || name === 'bash';

  // 对文件修改工具计算 diff
  const diffLines = useMemo<DiffLine[] | null>(() => {
    if (!isFileTool || !toolCall) return null;
    return diffFromToolInput(toolCall.name, toolCall.input);
  }, [isFileTool, toolCall]);

  const changeStats = useMemo(
    () => (diffLines ? countChanges(diffLines) : null),
    [diffLines],
  );

  // 非 diff 内容的格式化与折叠
  const isJson = !isFileTool && !isBash && (() => {
    const t = content.trim();
    return (t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'));
  })();
  // JSON 内容解析为结构化展示(解析失败则回退原始文本)
  const parsedJson = isJson ? tryParseJson(content) : null;
  const isLong = !diffLines && parsedJson === null && content.length > COLLAPSE_THRESHOLD;
  const visibleContent = expanded || !isLong ? content : content.slice(0, COLLAPSE_THRESHOLD);

  // 提取 metadata 信息
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

  // 摘要标题
  const titleLabel = isFileTool
    ? `${name} 变更`
    : isBash
      ? '终端输出'
      : `${name} 返回`;

  return (
    <details className="group rounded-md border bg-muted/20" open={isError || !!diffLines}>
      <summary className="flex cursor-pointer items-center gap-2 px-3 py-1.5">
        <ChevronRight className="size-3 text-muted-foreground transition-transform group-open:rotate-90" />
        {isError ? (
          <XCircle className="size-3.5 text-red-500" />
        ) : (
          <CheckCircle className="size-3.5 text-green-500" />
        )}
        {isBash && <Terminal className="size-3 text-muted-foreground" />}
        <span className="font-mono text-[11px] text-muted-foreground">{titleLabel}</span>
        {/* 增删统计 */}
        {changeStats && (changeStats.additions > 0 || changeStats.deletions > 0) && (
          <span className="flex items-center gap-1 font-mono text-[10px]">
            {changeStats.additions > 0 && <span className="text-green-500">+{changeStats.additions}</span>}
            {changeStats.deletions > 0 && <span className="text-red-500">-{changeStats.deletions}</span>}
          </span>
        )}
        {metaInfo && <span className="text-[10px] text-muted-foreground/60">{metaInfo}</span>}
        {isLong && !expanded && (
          <span className="ml-auto text-[10px] text-brand">
            {content.length.toLocaleString()} 字符 · 点击展开
          </span>
        )}
      </summary>
      <div className="border-t border-border">
        {/* 文件修改 → DiffView */}
        {diffLines && (
          <DiffView
            lines={diffLines}
            className="max-h-[60vh] overflow-auto border-0"
          />
        )}
        {/* bash 输出 → TerminalOutput(diff 着色) */}
        {!diffLines && isBash && (
          <TerminalOutput content={content} className="border-0" />
        )}
        {/* JSON → 结构化展示 */}
        {!diffLines && !isBash && parsedJson !== null && (
          <JsonView data={parsedJson} className="max-h-[60vh] border-0" />
        )}
        {/* 其他 → 普通 pre */}
        {!diffLines && !isBash && parsedJson === null && (
          <pre className="max-h-[60vh] overflow-auto bg-background px-3 py-2 font-mono text-[11px] leading-relaxed text-foreground/80">
            {visibleContent}
            {isLong && !expanded && (
              <span className="text-muted-foreground/50">
                {'\n'}… ({content.length - COLLAPSE_THRESHOLD} 字符已折叠)
              </span>
            )}
          </pre>
        )}
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
