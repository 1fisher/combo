import { useState } from 'react';
import { CheckCircle, Clock, FileText, XCircle } from 'lucide-react';
import { openFileInEditor } from '../../lib/openFile';
import { langFromPath } from '../../lib/codeLang';
import type { Api } from '../../lib/api/types';
import { JsonView, tryParseJson } from './JsonView';
import { BashCode } from './BashCode';
import { CodeView } from './CodeView';
import { ToolResultBody } from './ToolResultCard';
import { BASH_TOOLS, commandFromInput, formatDurationMs } from './bashTools';
import { toolIcon } from './toolIcons';

export interface ToolCallInfo {
  id: string;
  name: string;
  input: string;
  finished: boolean;
}

/** 从工具输入的 JSON 里提取文件路径(常见 key:path / file_path / filePath / filename) */
export function toolPathFromInput(input: string): string | null {
  try {
    const j = JSON.parse(input) as Record<string, unknown>;
    if (!j || typeof j !== 'object') return null;
    for (const key of ['path', 'file_path', 'filePath', 'filename']) {
      const v = j[key];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
  } catch {
    /* 非 JSON,无法提取 */
  }
  return null;
}

export function ToolCallCard({
  call,
  workspaceId,
  result,
}: {
  call: ToolCallInfo;
  workspaceId?: string;
  /** 配对 tool_result(bash):输出与状态合并进同一卡片,不再单独渲染 */
  result?: Api.ToolResult;
}) {
  const path = toolPathFromInput(call.input);
  const inputJson = tryParseJson(call.input);
  // bash 类工具:命令是主体,提取后直接展示(不再按 JSON 树渲染)
  const isBash = BASH_TOOLS.has(call.name);
  const command = isBash ? commandFromInput(call.input) : null;
  // write 工具:content 是完整文件内容,按目标文件类型语法高亮展示
  const writeContent =
    call.name === 'write' &&
    inputJson &&
    typeof inputJson === 'object' &&
    typeof (inputJson as Record<string, unknown>).content === 'string'
      ? {
          path: toolPathFromInput(call.input) ?? '',
          content: (inputJson as Record<string, unknown>).content as string,
        }
      : null;
  const writeLang = writeContent ? langFromPath(writeContent.path) : null;
  // summary 上的命令摘要:折叠时也能一眼看到在跑什么(取首行,超长截断)
  const commandBrief = command
    ? command.split('\n')[0].trim().slice(0, 80) + (command.length > 80 ? '…' : '')
    : null;

  // 配对结果的执行状态与输出(仅 bash 合并场景)
  let resultMeta: Record<string, unknown> | null = null;
  if (result?.metadata) {
    try {
      resultMeta = JSON.parse(result.metadata) as Record<string, unknown>;
    } catch {
      /* ignore */
    }
  }
  const resultTimedOut = resultMeta?.timed_out === true;
  const resultExitCode =
    typeof resultMeta?.exit_code === 'number' ? resultMeta.exit_code : undefined;
  const resultFailed = (result?.is_error ?? false) || resultTimedOut;
  const resultDuration =
    typeof resultMeta?.duration_ms === 'number'
      ? formatDurationMs(resultMeta.duration_ms)
      : null;
  const [expanded, setExpanded] = useState(false);
  // 按工具名取专属图标(read/write/grep/搜索/LSP… 各不相同,未知回退扳手)
  const ToolGlyph = toolIcon(call.name);

  return (
    <details
      className="rounded-md border bg-muted/30"
      open={result != null && resultFailed}
    >
      <summary className="flex cursor-pointer items-center gap-2 px-3 py-2">
        {call.finished ? (
          <ToolGlyph className="h-3.5 w-3.5 shrink-0 text-brand" />
        ) : (
          <span className="font-mono text-xs">⚙</span>
        )}
        <span className="font-mono text-xs">{call.name}</span>
        {/* 输入摘要:bash 显示 `$ <命令>`,read/write 无 workspaceId 时显示路径 */}
        {commandBrief ? (
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground/70">
            <span className="text-muted-foreground/60">$ </span>
            {commandBrief}
          </span>
        ) : path && !workspaceId ? (
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground/70">
            {path}
          </span>
        ) : null}
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {path && (
            <button
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                if (workspaceId) void openFileInEditor(workspaceId, path);
              }}
              title="在编辑器中打开该文件"
              className="flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <FileText className="h-3 w-3" />
              <span className="max-w-40 truncate">{path}</span>
            </button>
          )}
          {/* 配对结果的执行状态与耗时:标记在 tool_call 卡片上,不拼进输出。
              成功仅对勾图标(不显示「成功」文字),失败/超时显示图标+徽标 */}
          {result != null && (
            <>
              {resultFailed ? (
                resultTimedOut ? (
                  <Clock className="size-3.5 text-amber-500" />
                ) : (
                  <XCircle className="size-3.5 text-red-500" />
                )
              ) : (
                <CheckCircle className="size-3.5 text-green-500" />
              )}
              {resultFailed && (
                <span
                  className={
                    resultTimedOut
                      ? 'rounded bg-amber-500/10 px-1.5 py-0.5 font-mono text-[10px] font-medium text-amber-500'
                      : 'rounded bg-red-500/10 px-1.5 py-0.5 font-mono text-[10px] font-medium text-red-500'
                  }
                >
                  {resultTimedOut
                    ? '超时'
                    : `失败${resultExitCode != null ? `(${resultExitCode})` : ''}`}
                </span>
              )}
              {resultDuration && (
                <span className="font-mono text-[10px] text-muted-foreground/60">{resultDuration}</span>
              )}
            </>
          )}
        </span>
      </summary>
      {result != null ? (
        // 配对结果:单一代码展示区(命令+输出 / 文件内容 / diff / 搜索结果),
        // 不再单独渲染输入 JSON 与结果卡片;输入摘要已在 summary 中
        <ToolResultBody
          result={result}
          command={command ?? undefined}
          expanded={expanded}
          setExpanded={setExpanded}
        />
      ) : command !== null ? (
        // 未出结果(运行中):bash 命令以高亮展示作为过程反馈
        <BashCode command={command} className="rounded-none border-t" />
      ) : writeContent !== null ? (
        // write 工具:文件内容按目标文件类型高亮(语言未识别时纯文本)
        <CodeView
          code={writeContent.content}
          language={writeLang}
          className="rounded-none border-t"
        />
      ) : inputJson !== null ? (
        <JsonView data={inputJson} className="border-t border-border px-3 py-2" />
      ) : (
        <pre className="overflow-x-auto border-t bg-background px-3 py-2 font-mono text-xs text-muted-foreground">
          {call.input}
        </pre>
      )}
    </details>
  );
}
