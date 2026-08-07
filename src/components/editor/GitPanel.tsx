import { useCallback, useEffect, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  CircleDot,
  Download,
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
  getGitBranchInfo,
  gitStage,
  gitUnstage,
  gitCommit,
  gitPush,
  gitPull,
  gitFetch,
} from '../../lib/api';
import type { Api } from '../../lib/api/types';
import { useGitStore, type GitFileEntry } from '../../stores/gitStore';
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

interface CommitPrefix {
  label: string;
  color: string;
  dot: string;
}

const COMMIT_PREFIXES: CommitPrefix[] = [
  { label: 'feat', color: 'text-emerald-400', dot: 'bg-emerald-400' },
  { label: 'fix', color: 'text-red-400', dot: 'bg-red-400' },
  { label: 'docs', color: 'text-blue-400', dot: 'bg-blue-400' },
  { label: 'style', color: 'text-purple-400', dot: 'bg-purple-400' },
  { label: 'refactor', color: 'text-amber-400', dot: 'bg-amber-400' },
  { label: 'perf', color: 'text-orange-400', dot: 'bg-orange-400' },
  { label: 'test', color: 'text-cyan-400', dot: 'bg-cyan-400' },
  { label: 'chore', color: 'text-slate-400', dot: 'bg-slate-400' },
  { label: 'ci', color: 'text-indigo-400', dot: 'bg-indigo-400' },
  { label: 'build', color: 'text-teal-400', dot: 'bg-teal-400' },
];

interface Props {
  workspaceId: string;
  /** 当前选中显示 diff 的文件路径 */
  selectedDiffPath: string | null;
  /** 点击文件行,在右侧显示 diff */
  onShowDiff: (path: string) => void;
  /** 打开文件进行编辑 */
  onOpenFile: (path: string, name: string) => void;
}

export function GitPanel({ workspaceId, selectedDiffPath, onShowDiff, onOpenFile }: Props) {
  const branch = useGitStore((s) => s.branch);
  const files = useGitStore((s) => s.files);
  const loading = useGitStore((s) => s.loading);
  const setGitData = useGitStore((s) => s.setGitData);
  const setLoading = useGitStore((s) => s.setLoading);

  const [staging, setStaging] = useState(false);
  const [commitMsg, setCommitMsg] = useState('');
  const [commitPrefix, setCommitPrefix] = useState<string>('feat');
  const [showPrefixMenu, setShowPrefixMenu] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [commitError, setCommitError] = useState<string | null>(null);
  const [branchInfo, setBranchInfo] = useState<Api.GitBranchInfo | null>(null);
  const [remoteBusy, setRemoteBusy] = useState<null | 'push' | 'pull' | 'fetch'>(null);
  const [remoteError, setRemoteError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [status, info] = await Promise.all([
        getGitStatus(workspaceId),
        getGitBranchInfo(workspaceId).catch(() => null),
      ]);
      setGitData(status.branch, status.files);
      if (info) setBranchInfo(info);
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
    const prefix = commitPrefix ? `${commitPrefix}: ` : '';
    try {
      await gitCommit(workspaceId, `${prefix}${commitMsg.trim()}`);
      setCommitMsg('');
      await refresh();
    } catch (e) {
      setCommitError(e instanceof Error ? e.message : String(e));
    } finally {
      setCommitting(false);
    }
  }

  async function handleRemote(op: 'push' | 'pull' | 'fetch') {
    if (remoteBusy) return;
    setRemoteBusy(op);
    setRemoteError(null);
    try {
      if (op === 'push') await gitPush(workspaceId);
      else if (op === 'pull') await gitPull(workspaceId);
      else await gitFetch(workspaceId);
      await refresh();
    } catch (e) {
      setRemoteError(e instanceof Error ? e.message : String(e));
    } finally {
      setRemoteBusy(null);
    }
  }

  return (
    <div className="flex h-full flex-col">
      {/* 头部:分支 + ahead/behind + 拉取/推送/获取 + 刷新 */}
      <div className="flex shrink-0 flex-col gap-1.5 border-b px-3 py-2">
        <div className="flex items-center gap-2">
          <GitCommitHorizontal className="h-3.5 w-3.5 shrink-0 text-primary/60" />
          <span className="truncate font-mono text-xs text-foreground">{branch || '—'}</span>
          {branchInfo?.upstream && (
            <span className="truncate text-[10px] text-muted-foreground/60">
              ← {branchInfo.upstream}
            </span>
          )}
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
        {/* ahead/behind 标记 + remote 操作按钮 */}
        {branchInfo?.hasRemote && (
          <div className="flex items-center gap-1">
            {branchInfo.upstream && (branchInfo.ahead > 0 || branchInfo.behind > 0) && (
              <div className="flex items-center gap-1">
                {branchInfo.ahead > 0 && (
                  <span className="flex items-center gap-0.5 rounded bg-emerald-500/15 px-1 py-0.5 text-[9px] font-medium text-emerald-400">
                    <ArrowUp className="h-2.5 w-2.5" />
                    {branchInfo.ahead}
                  </span>
                )}
                {branchInfo.behind > 0 && (
                  <span className="flex items-center gap-0.5 rounded bg-amber-500/15 px-1 py-0.5 text-[9px] font-medium text-amber-400">
                    <ArrowDown className="h-2.5 w-2.5" />
                    {branchInfo.behind}
                  </span>
                )}
              </div>
            )}
            <div className="ml-auto flex items-center gap-0.5">
              <button
                onClick={() => void handleRemote('fetch')}
                disabled={!!remoteBusy}
                className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
                title="获取远程变更"
              >
                <Download className={cn('h-3 w-3', remoteBusy === 'fetch' && 'animate-spin')} />
                获取
              </button>
              <button
                onClick={() => void handleRemote('pull')}
                disabled={!!remoteBusy}
                className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
                title="拉取并合并"
              >
                <ArrowDown className={cn('h-3 w-3', remoteBusy === 'pull' && 'animate-bounce')} />
                拉取
              </button>
              <button
                onClick={() => void handleRemote('push')}
                disabled={!!remoteBusy}
                className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
                title="推送到远程"
              >
                <ArrowUp className={cn('h-3 w-3', remoteBusy === 'push' && 'animate-bounce')} />
                推送
              </button>
            </div>
          </div>
        )}
        {remoteError && (
          <div className="text-[10px] text-destructive">{remoteError}</div>
        )}
      </div>

      {/* 变更文件列表 */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {files.length === 0 && !loading && (
          <div className="px-3 py-4 text-center text-xs text-muted-foreground">
            没有未提交的变更
          </div>
        )}
        {files.map((f) => {
          const st = effectiveStatus(f);
          const fileName = f.path.split('/').pop() ?? f.path;
          const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '';
          const staged = f.indexStatus !== null;
          const isSelected = selectedDiffPath === f.path;
          return (
            <div
              key={f.path}
              className={cn(
                'group flex items-center gap-1 px-1.5 py-1 transition-colors',
                isSelected ? 'bg-accent' : 'hover:bg-accent/50',
              )}
            >
              <span className={cn('shrink-0', statusColor(st))}>
                {statusIcon(st)}
              </span>
              <button
                onClick={() => onShowDiff(f.path)}
                className="flex min-w-0 flex-1 items-center gap-1 text-left"
                title={f.path}
              >
                <span className="truncate font-mono text-xs">{fileName}</span>
                {dir && (
                  <span className="truncate text-[10px] text-muted-foreground/60">{dir}</span>
                )}
              </button>
              {/* 打开文件编辑 */}
              <button
                onClick={() => onOpenFile(f.path, fileName)}
                className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-60"
                title="打开文件"
              >
                <FileText className="h-3 w-3" />
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
          );
        })}
      </div>

      {/* 提交区 */}
      {files.length > 0 && (
        <div className="shrink-0 border-t p-2">
          <div className="mb-1.5 flex items-center justify-between">
            <div className="relative">
              <button
                onClick={() => setShowPrefixMenu((v) => !v)}
                className="flex items-center gap-1 rounded border border-border bg-background px-1.5 py-0.5 text-[10px] font-medium transition-colors hover:bg-accent"
              >
                {commitPrefix ? (
                  <>
                    <span
                      className={cn('h-1.5 w-1.5 rounded-full', COMMIT_PREFIXES.find((p) => p.label === commitPrefix)?.dot)}
                    />
                    <span className={COMMIT_PREFIXES.find((p) => p.label === commitPrefix)?.color}>
                      {commitPrefix}
                    </span>
                  </>
                ) : (
                  <span className="text-muted-foreground">无前缀</span>
                )}
                <ChevronDown className="h-2.5 w-2.5 text-muted-foreground" />
              </button>
              {showPrefixMenu && (
                <div className="absolute bottom-full left-0 z-50 mb-1 w-32 rounded-md border bg-popover p-1 shadow-md">
                  {COMMIT_PREFIXES.map((p) => (
                    <button
                      key={p.label}
                      onClick={() => {
                        setCommitPrefix(p.label);
                        setShowPrefixMenu(false);
                      }}
                      className={cn(
                        'flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-[10px] font-medium transition-colors hover:bg-accent',
                        commitPrefix === p.label && 'bg-accent/50',
                      )}
                    >
                      <span className={cn('h-1.5 w-1.5 rounded-full', p.dot)} />
                      <span className={p.color}>{p.label}</span>
                    </button>
                  ))}
                  <div className="my-0.5 border-t border-border/50" />
                  <button
                    onClick={() => {
                      setCommitPrefix('');
                      setShowPrefixMenu(false);
                    }}
                    className={cn(
                      'flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-[10px] font-medium text-muted-foreground transition-colors hover:bg-accent',
                      commitPrefix === '' && 'bg-accent/50',
                    )}
                  >
                    无前缀
                  </button>
                </div>
              )}
            </div>
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
