import { useMemo, useState } from 'react';
import { ChevronRight, CheckCircle, XCircle, Terminal } from 'lucide-react';
import type { Api } from '../../lib/api/types';
import { useAgentStore } from '../../stores/agentStore';
import { countChanges, diffFromToolInput, type DiffLine } from '../../lib/fileChanges';
import { langDisplayName, langFromPath, langFromShebang } from '../../lib/codeLang';
import { parseReadOutput } from '../../lib/readOutput';
import { DiffView } from './DiffView';
import { TerminalOutput } from './TerminalOutput';
import { JsonView, tryParseJson } from './JsonView';
import { BashCode } from './BashCode';
import { BASH_TOOLS, commandFromInput, stripCommandEcho } from './bashTools';
import { CodeView } from './CodeView';
import { toolPathFromInput } from './ToolCallCard';

const FILE_DIFF_TOOLS = new Set(['write', 'edit', 'multiedit']);
/** 读取类工具:返回按文件类型语法高亮的文件内容 */
const READ_TOOLS = new Set(['read']);
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

export function ToolResultCard({
  result,
  /** bash 类工具的命令文本:有值时摘要标题展示命令、展开区顶部高亮渲染 */
  command,
}: {
  result: Api.ToolResult;
  command?: string;
}) {
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
  const isRead = READ_TOOLS.has(name);
  // 读取类工具:解析后端分页输出(带行号),并按文件路径推断语法高亮语言
  const readView = useMemo(
    () => (isRead ? parseReadOutput(content) : null),
    [isRead, content],
  );
  const readPath = isRead
    ? (toolCall ? toolPathFromInput(toolCall.input) : null) ?? readView?.path ?? null
    : null;
  const readLang = useMemo(() => {
    if (!isRead) return null;
    if (readPath) {
      const lang = langFromPath(readPath);
      if (lang) return lang;
    }
    // 无路径/无法映射:仅原始内容(非分页格式)时用 shebang 兜底
    return readView ? null : langFromShebang(content);
  }, [isRead, readPath, readView, content]);
  // bash 命令:显式传入优先(shell_command part 自带),否则从配对
  // tool_call 的输入 JSON 中提取
  const commandText =
    command ?? (isBash && toolCall ? commandFromInput(toolCall.input) : null);
  // 展开区是否渲染完整命令:仅显式传入时(shell_command part 无配对的
  // ToolCallCard 展示命令);tool_result 场景配对的 ToolCallCard 已渲染,
  // 不再重复一份
  const showCommandBody = command != null && command.trim() !== '';
  // 摘要标题上的命令:仅独立 shell_command(无配对 ToolCallCard)时展示;
  // tool_result 场景上方配对的 ToolCallCard 已带命令摘要,不再重复
  const commandBrief =
    command != null && commandText
      ? commandText.split('\n')[0].trim().slice(0, 80) +
        (commandText.length > 80 ? '…' : '')
      : null;
  // 旧版后端会把命令以 `$ <command>\n` 回显进返回内容,配对卡片已渲染命令,
  // 渲染输出前剥离这行回显,避免请求内容在返回里重复
  const outputContent = isBash ? stripCommandEcho(content, commandText) : content;

  // 对文件修改工具计算 diff
  const diffLines = useMemo<DiffLine[] | null>(() => {
    if (!isFileTool || !toolCall) return null;
    return diffFromToolInput(toolCall.name, toolCall.input);
  }, [isFileTool, toolCall]);

  const changeStats = useMemo(
    () => (diffLines ? countChanges(diffLines) : null),
    [diffLines],
  );

  // 非 diff 内容的格式化与折叠(read 结果走 CodeView,不参与 JSON/折叠判定)
  const isJson =
    !isFileTool && !isBash && !readView &&
    (() => {
      const t = content.trim();
      return (t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'));
    })();
  const parsedJson = isJson ? tryParseJson(content) : null;
  const isLong =
    !diffLines && !readView && parsedJson === null && content.length > COLLAPSE_THRESHOLD;
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
      ? (commandBrief ? `$ ${commandBrief}` : '终端输出')
      : isRead && readPath
        ? `读取 ${readPath.length > 40 ? readPath.slice(0, 37) + '…' : readPath}`
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
        {/* bash 输出 → 顶部命令(bash 高亮,仅独立 shell_command)+ 输出(diff 着色) */}
        {!diffLines && isBash && (
          <>
            {showCommandBody && commandText && (
              <BashCode command={commandText} className="rounded-none" />
            )}
            <TerminalOutput content={outputContent} className="border-0" />
          </>
        )}
        {/* read 结果 → 按文件类型语法高亮 + 行号列 */}
        {!diffLines && !isBash && readView && (
          <div>
            <div className="flex items-center gap-2 border-b border-white/5 bg-white/5 px-3 py-1">
              {readLang && (
                <span className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
                  {langDisplayName(readLang)}
                </span>
              )}
              <span className="text-[10px] text-muted-foreground/60">
                {readView.range
                  ? `第 ${readView.range.start}-${readView.range.end} 行`
                  : `${readView.lines.length} 行`}
                {readView.total ? ` / 共 ${readView.total} 行` : ''}
              </span>
            </div>
            <CodeView
              code={readView.lines.join('\n')}
              language={readLang}
              lineNumbers={readView.lineNumbers}
              className="rounded-none border-0"
            />
            {readView.footer && (
              <div className="border-t border-border px-3 py-1 text-[10px] text-muted-foreground/60">
                {readView.footer}
              </div>
            )}
          </div>
        )}
        {/* JSON → 结构化展示 */}
        {!diffLines && !isBash && !readView && parsedJson !== null && (
          <JsonView data={parsedJson} className="max-h-[60vh] border-0" />
        )}
        {/* 其他 → 普通 pre */}
        {!diffLines && !isBash && !readView && parsedJson === null && (
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
