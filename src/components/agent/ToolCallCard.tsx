import { FileText } from 'lucide-react';
import { Badge } from '../ui/badge';
import { openFileInEditor } from '../../lib/openFile';

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
  return (
    <details className="rounded-md border bg-muted/30">
      <summary className="flex cursor-pointer items-center gap-2 px-3 py-2">
        <span className="font-mono text-xs">⚙ {call.name}</span>
        <Badge variant={call.finished ? 'secondary' : 'outline'}>
          {call.finished ? 'done' : 'pending'}
        </Badge>
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
      <pre className="overflow-x-auto border-t bg-background px-3 py-2 font-mono text-xs text-muted-foreground">
        {call.input}
      </pre>
    </details>
  );
}
