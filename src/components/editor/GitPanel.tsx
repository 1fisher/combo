import { useCallback, useEffect, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  CircleDot,
  FilePlus,
  FileText,
  GitCommitHorizontal,
  MinusCircle,
  PencilLine,
  Plus,
  RefreshCw,
} from 'lucide-react';
import {
  getGitStatus,
  getGitDiffHead,
  gitStage,
  gitUnstage,
  gitCommit,
} from '../../lib/api';
import { useGitStore, type GitFileEntry } from '../../stores/gitStore';
import { parseUnifiedDiff, type UnifiedDiffHunk } from '../../lib/gitDiff';
import { cn } from '../../lib/utils';

function statusColor(status: string | null): string {
  switch (status) {
    case 'added':
    case 'untracked':
      return 'text-emerald-400';
    case 'modified':
      return 'text-amber-400';
    case 'deleted':
      return 'text-red-400';
    case 'renamed':
    case 'copied':
      return 'text-blue-400';
    default:
      return 'text-muted-foreground';
  }
}

function statusIcon(status: string | null, className?: string) {
  switch (status) {
    case 'added':
    case 'untracked':
      return <FilePlus className={cn('h-3.5 w-3.5', className)} />;
    case 'modified':
      return <PencilLine className={cn('h-3.5 w-3.5', className)} />;
    case 'deleted':
      return <MinusCircle className={cn('h-3.5 w-3.5', className)} />;
    case 'renamed':
    case 'copied':
      return <CircleDot className={cn('h-3.5 w-3.5', className)} />;
    default:
      return <FileText className={cn('h-3.5 w-3.5', className)} />;
  }
}

function effectiveStatus(f: GitFileEntry): string | null {
  return f.workTreeStatus ?? f.indexStatus;
}

function DiffViewer({ hunks }: { hunks: UnifiedDiffHunk[] }) {
  if (hunks.length === 0) {
    return <div className="px-3 py-2 text-xs text-muted-foreground">无差异</div>;
  }
  return (
    <div className="overflow-x-auto font-mono text-xs">
      {hunks.map((hunk, hi) => (
        <div key={hi}>
          <div className="border-b border-border/40 bg-muted/30 px-2 py-1 text-[10px] text-muted-foreground">
            @@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines}
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
                  'w-5 shrink-0 select-none px-1 text-right',
                  line.type === 'add' && 'text-emerald-400',
                  line.type === 'remove' && 'text-red-400',
                  line.type === 'context' && 'text-muted-foreground/50',
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
  );
}

interface Props {
  workspaceId: string;
  onOpenFile: (path: string, name: string) => void;
}

export function GitPanel({ workspaceId, onOpenFile }: Props) {
  const branch = useGitStore((s) => s.branch);
  const files = useGitStore((s) => s.files);
  const loading = useGitStore((s) => s.loading);
  const error = useGitStore((s) => s.error);
  const setGitData = useGitStore((s) => s.setGitData);
  const setLoading = useGitStore((s) => s.setLoading);

  const [expandedFile, setExpandedFile] = useState<string | null>(null);
  const [diffHunks, setDiffHunks] = useState<UnifiedDiffHunk[]>([]);
  const [staging, setStaging] = useState(false);
  const [commitMsg, setCommitMsg] = useState('');
  const [committing, setCommitting] = useState(false);
  const [commitError, setCommitError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const status = await getGitStatus(workspaceId);
      setGitData(status.branch, status.files);
    } catch (e) {
      console.error('[GitPanel] git status failed:', e);
      setGitData('', []);
    } finally {
      setLoading(false);
    }
  }, [workspaceId, setGitData, setLoading]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function toggleDiff(filePath: string) {
    if (expandedFile === filePath) {
      setExpandedFile(null);
      return;
    }
    setExpandedFile(filePath);
    setDiffHunks([]);
    try {
      const { diff } = await getGitDiffHead(workspaceId, filePath);
      setDiffHunks(parseUnifiedDiff(diff));
    } catch {
      setDiffHunks([]);
    }
  }

  async function handleStage(filePath: string) {
    setStaging(true);
    try {
      await gitStage(workspaceId, [filePath]);
      await refresh();
    } catch {
      /* ignore */
    } finally {
      setStaging(false);
    }
  }

  async function handleUnstage(filePath: string) {
    setStaging(true);
    try {
      await gitUnstage(workspaceId, [filePath]);
      await refresh();
    } catch {
      /* ignore */
    } finally {
      setStaging(false);
    }
  }

  async function handleStageAll() {
    setStaging(true);
    try {
      await gitStage(workspaceId, []);
      await refresh();
    } catch {
      /* ignore */
    } finally {
      setStaging(false);
    }
  }

  async function handleCommit() {
    if (!commitMsg.trim() || committing) return;
    setCommitting(true);
    setCommitError(null);
    try {
      await gitCommit(workspaceId, commitMsg.trim());
      setCommitMsg('');
      await refresh();
    } catch (e) {
      setCommitError(e instanceof Error ? e.message : String(e));
    } finally {
      setCommitting(false);
    }
  }

  return (
    <div className="flex h-full flex-col">
      {/* 头部:分支 + 刷新 */}
      <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
        <GitCommitHorizontal className="h-3.5 w-3.5 shrink-0 text-primary/60" />
        <span className="truncate font-mono text-xs text-foreground">{branch || '—'}</span>
        <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
          {files.length > 0 && `${files.length} 个变更`}
        </span>
        <button
          onClick={() => void refresh()}
          disabled={loading}
          className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
          title="刷新"
        >
          <RefreshCw className={cn('h-3 w-3', loading && 'animate-spin')} />
        </button>
      </div>

      {error && (
        <div className="border-b border-destructive/30 bg-destructive/10 px-3 py-1.5 text-xs text-destructive">
          {error}
        </div>
      )}

      {/* 变更文件列表 */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {files.length === 0 && !loading && (
          <div className="px-3 py-4 text-center text-xs text-muted-foreground">
            没有未提交的变更
          </div>
        )}
        {files.map((f) => {
          const st = effectiveStatus(f);
          const isExpanded = expandedFile === f.path;
          const fileName = f.path.split('/').pop() ?? f.path;
          const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '';
          const staged = f.indexStatus !== null;
          return (
            <div key={f.path} className="border-b border-border/30">
              <div
                className={cn(
                  'group flex items-center gap-1 px-1.5 py-1 transition-colors hover:bg-accent/50',
                )}
              >
                <button
                  onClick={() => void toggleDiff(f.path)}
                  className="shrink-0 text-muted-foreground"
                >
                  {isExpanded ? (
                    <ChevronDown className="h-3 w-3" />
                  ) : (
                    <ChevronRight className="h-3 w-3" />
                  )}
                </button>
                <span className={cn('shrink-0', statusColor(st))}>
                  {statusIcon(st)}
                </span>
                <button
                  onClick={() => onOpenFile(f.path, fileName)}
                  className="flex min-w-0 flex-1 items-center gap-1 text-left"
                  title={f.path}
                >
                  <span className="truncate font-mono text-xs">{fileName}</span>
                  {dir && (
                    <span className="truncate text-[10px] text-muted-foreground/60">{dir}</span>
                  )}
                </button>
                {/* 暂存 / 取消暂存 */}
                <button
                  onClick={() => void (staged ? handleUnstage(f.path) : handleStage(f.path))}
                  disabled={staging}
                  className={cn(
                    'shrink-0 rounded p-0.5 transition-colors disabled:opacity-50',
                    staged
                      ? 'text-emerald-400 hover:text-emerald-300'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                  title={staged ? '取消暂存' : '暂存'}
                >
                  <Plus className="h-3 w-3" />
                </button>
              </div>
              {isExpanded && (
                <div className="border-t border-border/20 bg-background/50">
                  <DiffViewer hunks={diffHunks} />
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* 提交区 */}
      {files.length > 0 && (
        <div className="shrink-0 border-t p-2">
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-[10px] font-medium text-muted-foreground">提交变更</span>
            <button
              onClick={() => void handleStageAll()}
              disabled={staging}
              className="text-[10px] text-primary/70 transition-colors hover:text-primary disabled:opacity-50"
            >
              全部暂存
            </button>
          </div>
          <textarea
            value={commitMsg}
            onChange={(e) => setCommitMsg(e.target.value)}
            placeholder="提交信息..."
            rows={2}
            className="w-full resize-none rounded border bg-background px-2 py-1 font-mono text-xs outline-none focus:border-primary/50"
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                e.preventDefault();
                void handleCommit();
              }
            }}
          />
          {commitError && (
            <div className="mt-1 text-[10px] text-destructive">{commitError}</div>
          )}
          <button
            onClick={() => void handleCommit()}
            disabled={!commitMsg.trim() || committing}
            className="mt-1.5 w-full rounded bg-primary px-2 py-1 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
          >
            {committing ? '提交中...' : '提交'}
          </button>
        </div>
      )}
    </div>
  );
}
