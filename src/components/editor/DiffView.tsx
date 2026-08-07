import { useEffect, useState } from 'react';
import { FileText } from 'lucide-react';
import { getGitDiffHead } from '../../lib/api';
import { parseUnifiedDiff, type UnifiedDiffHunk } from '../../lib/gitDiff';
import { cn } from '../../lib/utils';

interface Props {
  workspaceId: string;
  filePath: string;
}

export function DiffView({ workspaceId, filePath }: Props) {
  const [hunks, setHunks] = useState<UnifiedDiffHunk[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setHunks([]);
    getGitDiffHead(workspaceId, filePath)
      .then(({ diff }) => {
        if (!cancelled) setHunks(parseUnifiedDiff(diff));
      })
      .catch(() => {
        if (!cancelled) setHunks([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, filePath]);

  const fileName = filePath.split('/').pop() ?? filePath;

  return (
    <div className="flex h-full flex-col">
      {/* 顶栏:文件名 */}
      <div className="flex shrink-0 items-center gap-1.5 border-b bg-muted/30 px-3 py-2">
        <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate font-mono text-xs text-foreground">{fileName}</span>
        <span className="truncate text-[10px] text-muted-foreground/60">{filePath}</span>
        <span className="ml-auto shrink-0 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-400">
          Diff
        </span>
      </div>
      {/* diff 内容 */}
      <div className="min-h-0 flex-1 overflow-auto">
        {loading ? (
          <div className="px-3 py-4 text-center text-xs text-muted-foreground">加载中...</div>
        ) : hunks.length === 0 ? (
          <div className="px-3 py-4 text-center text-xs text-muted-foreground">无差异</div>
        ) : (
          <div className="font-mono text-xs">
            {hunks.map((hunk, hi) => (
              <div key={hi}>
                <div className="sticky top-0 border-b border-border/40 bg-muted/40 px-2 py-1 text-[10px] text-muted-foreground">
                  @@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@
                </div>
                {hunk.lines.map((line, li) => (
                  <div
                    key={li}
                    className={cn(
                      'flex',
                      line.type === 'add' && 'bg-emerald-500/10',
                      line.type === 'remove' && 'bg-red-500/10',
                    )}
                  >
                    <span
                      className={cn(
                        'w-6 shrink-0 select-none px-1 text-right',
                        line.type === 'add' && 'text-emerald-400',
                        line.type === 'remove' && 'text-red-400',
                        line.type === 'context' && 'text-muted-foreground/40',
                      )}
                    >
                      {line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' '}
                    </span>
                    <pre className="flex-1 whitespace-pre-wrap break-all px-1">{line.content}</pre>
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
