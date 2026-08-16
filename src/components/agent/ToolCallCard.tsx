import { FileText, Terminal, Wrench } from 'lucide-react';
import { openFileInEditor } from '../../lib/openFile';
import { JsonView, tryParseJson } from './JsonView';
import { BashCode } from './BashCode';
import { BASH_TOOLS, commandFromInput } from './bashTools';

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
}: {
  call: ToolCallInfo;
  workspaceId?: string;
}) {
  const path = workspaceId ? toolPathFromInput(call.input) : null;
  const inputJson = tryParseJson(call.input);
  // bash 类工具:命令是主体,提取后直接展示(不再按 JSON 树渲染)
  const isBash = BASH_TOOLS.has(call.name);
  const command = isBash ? commandFromInput(call.input) : null;
  // summary 上的命令摘要:折叠时也能一眼看到在跑什么(取首行,超长截断)
  const commandBrief = command
    ? command.split('\n')[0].trim().slice(0, 80) + (command.length > 80 ? '…' : '')
    : null;
  return (
    <details className="rounded-md border bg-muted/30">
      <summary className="flex cursor-pointer items-center gap-2 px-3 py-2">
        {call.finished ? (
          isBash ? (
            <Terminal className="h-3.5 w-3.5 shrink-0 text-brand" />
          ) : (
            <Wrench className="h-3.5 w-3.5 shrink-0 text-brand" />
          )
        ) : (
          <span className="font-mono text-xs">⚙</span>
        )}
        <span className="font-mono text-xs">{call.name}</span>
        {/* bash 命令摘要:折叠态可见,展示为 `$ <命令>` */}
        {commandBrief && (
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground/70">
            <span className="text-muted-foreground/60">$ </span>
            {commandBrief}
          </span>
        )}
        {path && (
          <button
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              if (workspaceId) void openFileInEditor(workspaceId, path);
            }}
            title="在编辑器中打开该文件"
            className="ml-auto flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <FileText className="h-3 w-3" />
            <span className="max-w-40 truncate">{path}</span>
          </button>
        )}
      </summary>
      {command !== null ? (
        // bash 类工具:命令以 bash 语法高亮展示(与 markdown 代码块观感一致)
        <BashCode command={command} className="rounded-none border-t" />
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
