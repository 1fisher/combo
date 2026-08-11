import { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, ChevronDown, ChevronRight, FileEdit, Loader2, X, CheckCheck, Undo2 } from 'lucide-react';
import type { MessageVM } from '../../stores/agentStore';
import { getFileContent, putFileContent } from '../../lib/api';
import {
  computeDiffLines,
  countChanges,
  extractFileToolCalls,
  groupByPath,
  reconstructAfter,
  reconstructBefore,
  type DiffLine,
} from '../../lib/fileChanges';
import { DiffView } from './DiffView';
import { cn } from '../../lib/utils';

export type ChangeStatus = 'pending' | 'approved' | 'rejected';

interface DiffEntry {
  lines: DiffLine[];
  additions: number;
  deletions: number;
  before: string;
  loading: boolean;
  error: string | null;
}

function basename(p: string): string {
  const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return idx >= 0 ? p.slice(idx + 1) : p;
}

function dirname(p: string): string {
  const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return idx >= 0 ? p.slice(0, idx) : '';
}

export function FileChangesPanel({
  messages,
  workspaceId,
  onClose,
  statuses,
  onStatusesChange,
}: {
  messages: MessageVM[];
  workspaceId: string;
  onClose: () => void;
  statuses: Record<string, ChangeStatus>;
  onStatusesChange: React.Dispatch<React.SetStateAction<Record<string, ChangeStatus>>>;
}) {
  const toolCalls = useMemo(() => extractFileToolCalls(messages), [messages]);
  const byPath = useMemo(() => groupByPath(toolCalls), [toolCalls]);
  const paths = useMemo(() => Array.from(byPath.keys()), [byPath]);
  const [expandedPath, setExpandedPath] = useState<string | null>(null);
  const [diffs, setDiffs] = useState<Record<string, DiffEntry>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const loadDiff = useCallback(
    async (path: string) => {
      const calls = byPath.get(path);
      if (!calls) return;
      setDiffs((prev) => ({
        ...prev,
        [path]: { lines: [], additions: 0, deletions: 0, before: '', loading: true, error: null },
      }));
      try {
        let after: string;
        try {
          const res = await getFileContent(workspaceId, path);
          after = res.content;
        } catch {
          after = reconstructAfter(calls);
        }
        const before = reconstructBefore(after, calls);
        const lines = computeDiffLines(before, after);
        const { additions, deletions } = countChanges(lines);
        setDiffs((prev) => ({
          ...prev,
          [path]: { lines, additions, deletions, before, loading: false, error: null },
        }));
      } catch (e) {
        setDiffs((prev) => ({
          ...prev,
          [path]: {
            lines: [],
            additions: 0,
            deletions: 0,
            before: '',
            loading: false,
            error: e instanceof Error ? e.message : String(e),
          },
        }));
      }
    },
    [byPath, workspaceId],
  );

  // 展开文件时自动加载 diff
  useEffect(() => {
    if (expandedPath && !diffs[expandedPath]) {
      void loadDiff(expandedPath);
    }
  }, [expandedPath, diffs, loadDiff]);

  const handleApprove = useCallback((path: string) => {
    onStatusesChange((prev) => ({ ...prev, [path]: 'approved' }));
  }, [onStatusesChange]);

  const handleReject = useCallback(
    async (path: string) => {
      const entry = diffs[path];
      if (!entry || entry.loading) return;
      setBusy(path);
      try {
        await putFileContent(workspaceId, path, entry.before);
        onStatusesChange((prev) => ({ ...prev, [path]: 'rejected' }));
        // 重新加载 diff(revert 后应无差异)
        setDiffs((prev) => {
          const next = { ...prev };
          delete next[path];
          return next;
        });
        void loadDiff(path);
      } catch (e) {
        console.error('撤销变更失败', e);
      } finally {
        setBusy(null);
      }
    },
    [diffs, workspaceId, loadDiff, onStatusesChange],
  );

  const handleApproveAll = useCallback(() => {
    onStatusesChange((prev) => {
      const next = { ...prev };
      for (const p of paths) if (next[p] !== 'rejected') next[p] = 'approved';
      return next;
    });
  }, [paths, onStatusesChange]);

  const handleRejectAll = useCallback(async () => {
    for (const p of paths) {
      if (statuses[p] === 'approved') continue;
      if (!diffs[p]) await loadDiff(p);
      await handleReject(p);
    }
  }, [paths, statuses, diffs, loadDiff, handleReject]);

  const stats = useMemo(() => {
    let approved = 0;
    let rejected = 0;
    let pending = 0;
    for (const p of paths) {
      const s = statuses[p] ?? 'pending';
      if (s === 'approved') approved++;
      else if (s === 'rejected') rejected++;
      else pending++;
    }
    return { approved, rejected, pending, total: paths.length };
  }, [paths, statuses]);

  if (paths.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
        <FileEdit className="size-8 text-muted-foreground/40" />
        <p>当前会话没有文件变更</p>
        <button
          onClick={onClose}
          className="rounded-md border border-border px-3 py-1 text-xs hover:bg-surface-hover"
        >
          返回对话
        </button>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 顶部标题栏 */}
      <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-2.5">
        <div className="flex items-center gap-2">
          <FileEdit className="size-4 text-brand" />
          <span className="text-sm font-medium">文件变更</span>
          <span className="text-xs text-muted-foreground">
            {stats.total} 个文件
            {stats.approved > 0 && <span className="ml-1 text-green-500">· {stats.approved} 已批准</span>}
            {stats.rejected > 0 && <span className="ml-1 text-red-500">· {stats.rejected} 已撤销</span>}
          </span>
        </div>
        <button
          onClick={onClose}
          className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-surface-hover hover:text-foreground"
          title="关闭"
        >
          <X className="size-4" />
        </button>
      </div>

      {/* 文件列表 */}
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        <div className="space-y-1.5">
          {paths.map((path) => {
            const calls = byPath.get(path) ?? [];
            const entry = diffs[path];
            const status = statuses[path] ?? 'pending';
            const isExpanded = expandedPath === path;
            return (
              <div
                key={path}
                className={cn(
                  'rounded-lg border border-border overflow-hidden',
                  status === 'approved' && 'ring-1 ring-green-500/30',
                  status === 'rejected' && 'opacity-60',
                )}
              >
                {/* 文件行 */}
                <div className="flex items-center gap-2 px-3 py-2">
                  <button
                    onClick={() => setExpandedPath(isExpanded ? null : path)}
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  >
                    {isExpanded ? (
                      <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
                    ) : (
                      <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
                    )}
                    <span className="truncate text-[13px] font-medium">{basename(path)}</span>
                    <span className="truncate text-[11px] text-muted-foreground/60">{dirname(path)}</span>
                    {entry && !entry.loading && (
                      <span className="ml-1 flex shrink-0 items-center gap-1 font-mono text-[10px]">
                        {entry.additions > 0 && <span className="text-green-500">+{entry.additions}</span>}
                        {entry.deletions > 0 && <span className="text-red-500">-{entry.deletions}</span>}
                      </span>
                    )}
                  </button>
                  {/* 操作按钮 */}
                  <div className="flex shrink-0 items-center gap-1">
                    {status === 'pending' ? (
                      <>
                        <button
                          onClick={() => handleApprove(path)}
                          disabled={busy === path}
                          className="flex items-center gap-1 rounded-md border border-border px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:border-green-500/40 hover:text-green-500 disabled:opacity-50"
                          title="批准变更"
                        >
                          <Check className="size-3" />
                          批准
                        </button>
                        <button
                          onClick={() => void handleReject(path)}
                          disabled={busy === path || !entry}
                          className="flex items-center gap-1 rounded-md border border-border px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:border-red-500/40 hover:text-red-500 disabled:opacity-50"
                          title="撤销变更(恢复原始内容)"
                        >
                          {busy === path ? (
                            <Loader2 className="size-3 animate-spin" />
                          ) : (
                            <Undo2 className="size-3" />
                          )}
                          撤销
                        </button>
                      </>
                    ) : (
                      <span
                        className={cn(
                          'flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px]',
                          status === 'approved' && 'text-green-500',
                          status === 'rejected' && 'text-red-500',
                        )}
                      >
                        {status === 'approved' ? (
                          <>
                            <Check className="size-3" />
                            已批准
                          </>
                        ) : (
                          <>
                            <Undo2 className="size-3" />
                            已撤销
                          </>
                        )}
                      </span>
                    )}
                  </div>
                </div>

                {/* diff 展开区 */}
                {isExpanded && (
                  <div className="border-t border-border p-2">
                    {entry?.loading && (
                      <div className="flex items-center justify-center gap-2 py-6 text-xs text-muted-foreground">
                        <Loader2 className="size-3.5 animate-spin" />
                        加载差异…
                      </div>
                    )}
                    {entry?.error && (
                      <div className="px-3 py-2 text-xs text-red-500">加载失败:{entry.error}</div>
                    )}
                    {entry && !entry.loading && !entry.error && (
                      <>
                        <DiffView lines={entry.lines} />
                        {/* 工具调用列表 */}
                        <div className="mt-2 flex flex-wrap gap-1">
                          {calls.map((c) => (
                            <span
                              key={c.id}
                              className="rounded bg-muted/40 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
                            >
                              {c.name}
                            </span>
                          ))}
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* 底部操作栏 */}
      <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border px-4 py-2.5">
        <button
          onClick={() => void handleRejectAll()}
          disabled={busy !== null || stats.pending === 0}
          className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:border-red-500/40 hover:text-red-500 disabled:opacity-50"
        >
          <Undo2 className="size-3.5" />
          全部撤销
        </button>
        <button
          onClick={handleApproveAll}
          disabled={busy !== null || stats.pending === 0}
          className="flex items-center gap-1.5 rounded-md bg-brand px-3 py-1.5 text-xs text-foreground-inverse transition-colors hover:opacity-90 disabled:opacity-50"
        >
          <CheckCheck className="size-3.5" />
          全部批准
        </button>
      </div>
    </div>
  );
}
