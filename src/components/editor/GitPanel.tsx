import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  CircleDot,
  FilePlus,
  FileText,
  Folder,
  GitBranch,
  GitCommitHorizontal,
  MinusCircle,
  PencilLine,
  Plus,
  RefreshCw,
  RotateCcw,
  Trash2,
} from 'lucide-react';
import {
  getGitStatus,
  getGitRepos,
  getGitBranchInfo,
  getGitBranches,
  gitCheckout,
  gitCreateBranch,
  gitDeleteBranch,
  gitStage,
  gitUnstage,
  gitDiscard,
  gitCommit,
  gitPush,
  gitPull,
  gitFetch,
} from '../../lib/api';
import type { Api } from '../../lib/api/types';
import { useGitStore, type GitFileEntry } from '../../stores/gitStore';
import { cn } from '../../lib/utils';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';

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
  /** 当前选中的 git 仓库(相对 workspace 根目录的路径,空串表示根仓库) */
  repo?: string;
  /** 切换 git 仓库(空串切回根仓库) */
  onRepoChange?: (repo: string) => void;
  /** 当前选中显示 diff 的文件路径 */
  selectedDiffPath: string | null;
  /** 点击文件行,在右侧显示 diff */
  onShowDiff: (path: string) => void;
  /** 打开文件进行编辑 */
  onOpenFile: (path: string, name: string) => void;
}

export function GitPanel({ workspaceId, repo = '', onRepoChange, selectedDiffPath, onShowDiff, onOpenFile }: Props) {
  const branch = useGitStore((s) => s.branch);
  const files = useGitStore((s) => s.files);
  const loading = useGitStore((s) => s.loading);
  const setGitData = useGitStore((s) => s.setGitData);
  const setLoading = useGitStore((s) => s.setLoading);

  /** 工作区根目录及其一级子目录中的 git 仓库 */
  const [repos, setRepos] = useState<Api.GitRepoStatus[]>([]);
  const [repoMenuOpen, setRepoMenuOpen] = useState(false);

  const [staging, setStaging] = useState(false);
  const [commitMsg, setCommitMsg] = useState('');
  const [commitPrefix, setCommitPrefix] = useState<string>('feat');
  const [showPrefixMenu, setShowPrefixMenu] = useState(false);
  const prefixBtnRef = useRef<HTMLButtonElement>(null);
  const [prefixDropUp, setPrefixDropUp] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [commitError, setCommitError] = useState<string | null>(null);
  const [branchInfo, setBranchInfo] = useState<Api.GitBranchInfo | null>(null);
  const [branchList, setBranchList] = useState<Api.GitBranch[]>([]);
  const [branchMenuOpen, setBranchMenuOpen] = useState(false);
  const [branchBusy, setBranchBusy] = useState<string | null>(null);
  const [branchError, setBranchError] = useState<string | null>(null);
  const [branchCreateOpen, setBranchCreateOpen] = useState(false);
  const [newBranchName, setNewBranchName] = useState('');
  const [createAndSwitch, setCreateAndSwitch] = useState(false);
  const [branchCreating, setBranchCreating] = useState(false);
  const [branchCreateError, setBranchCreateError] = useState<string | null>(null);
  const [branchDeleteTarget, setBranchDeleteTarget] = useState<string | null>(null);
  const [branchDeleteForce, setBranchDeleteForce] = useState(false);
  const [branchDeleting, setBranchDeleting] = useState(false);
  const [branchDeleteError, setBranchDeleteError] = useState<string | null>(null);
  const [remoteBusy, setRemoteBusy] = useState<null | 'push' | 'pull' | 'fetch'>(null);
  const [remoteError, setRemoteError] = useState<string | null>(null);
  const [discardTarget, setDiscardTarget] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      // 发现根目录 + 一级子目录中的 git 仓库;当前选中仓库不存在时自动回退到第一个
      const { repos: found } = await getGitRepos(workspaceId);
      setRepos(found);
      const current = found.find((r) => r.path === repo) ?? found[0] ?? null;
      if (!current) {
        setGitData('', []);
        setBranchInfo(null);
        if (repo !== '') onRepoChange?.('');
        return;
      }
      const repoPath = current.path;
      if (repoPath !== repo) onRepoChange?.(repoPath);
      const [status, info, branches] = await Promise.all([
        getGitStatus(workspaceId, repoPath || undefined),
        getGitBranchInfo(workspaceId, repoPath || undefined).catch(() => null),
        getGitBranches(workspaceId, repoPath || undefined).catch(() => null),
      ]);
      setGitData(status.branch, status.files);
      if (info) setBranchInfo(info);
      if (branches) setBranchList(branches.branches);
    } catch (e) {
      console.error('[GitPanel] git status failed:', e);
      setGitData('', []);
    } finally {
      setLoading(false);
    }
  }, [workspaceId, repo, onRepoChange, setGitData, setLoading]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 打开前缀菜单时根据剩余空间决定向上还是向下弹出
  useEffect(() => {
    if (!showPrefixMenu) return;
    const btn = prefixBtnRef.current;
    if (!btn) return;
    const rect = btn.getBoundingClientRect();
    // 菜单最大高度约 192px(48*4),留 8px 安全间距
    const spaceBelow = window.innerHeight - rect.bottom;
    setPrefixDropUp(spaceBelow < 200);
  }, [showPrefixMenu]);

  async function handleStage(filePath: string) {
    setStaging(true);
    try {
      await gitStage(workspaceId, [filePath], repo || undefined);
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
      await gitUnstage(workspaceId, [filePath], repo || undefined);
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
      await gitStage(workspaceId, [], repo || undefined);
      await refresh();
    } catch {
      /* ignore */
    } finally {
      setStaging(false);
    }
  }

  async function handleDiscard(filePath: string) {
    setStaging(true);
    try {
      await gitDiscard(workspaceId, [filePath], repo || undefined);
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
      await gitCommit(workspaceId, `${prefix}${commitMsg.trim()}`, repo || undefined);
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
      if (op === 'push') await gitPush(workspaceId, repo || undefined);
      else if (op === 'pull') await gitPull(workspaceId, repo || undefined);
      else await gitFetch(workspaceId, repo || undefined);
      await refresh();
    } catch (e) {
      setRemoteError(e instanceof Error ? e.message : String(e));
    } finally {
      setRemoteBusy(null);
    }
  }

  async function handleCheckout(target: string) {
    if (branchBusy || target === branch) return;
    setBranchBusy(target);
    setBranchError(null);
    setBranchMenuOpen(false);
    try {
      await gitCheckout(workspaceId, target, repo || undefined);
      await refresh();
    } catch (e) {
      setBranchError(e instanceof Error ? e.message : String(e));
    } finally {
      setBranchBusy(null);
    }
  }

  async function handleCreateBranch() {
    const name = newBranchName.trim();
    if (!name || branchCreating) return;
    setBranchCreateError(null);
    if (branchList.some((b) => b.name === name)) {
      setBranchCreateError('分支已存在');
      return;
    }
    setBranchCreating(true);
    try {
      await gitCreateBranch(workspaceId, name, repo || undefined);
      if (createAndSwitch) {
        await gitCheckout(workspaceId, name, repo || undefined);
      }
      setBranchCreateOpen(false);
      setNewBranchName('');
      setCreateAndSwitch(false);
      await refresh();
    } catch (e) {
      setBranchCreateError(e instanceof Error ? e.message : String(e));
    } finally {
      setBranchCreating(false);
    }
  }

  async function handleDeleteBranch() {
    if (!branchDeleteTarget || branchDeleting) return;
    setBranchDeleting(true);
    setBranchDeleteError(null);
    try {
      await gitDeleteBranch(workspaceId, branchDeleteTarget, repo || undefined, branchDeleteForce);
      setBranchDeleteTarget(null);
      setBranchDeleteForce(false);
      await refresh();
    } catch (e) {
      setBranchDeleteError(e instanceof Error ? e.message : String(e));
    } finally {
      setBranchDeleting(false);
    }
  }

  return (
    <div className="flex h-full flex-col">
      {/* 头部:仓库选择(多仓库时) + 分支 + ahead/behind + 拉取/推送 + 刷新 */}
      <div className="flex shrink-0 flex-col gap-1.5 border-b px-3 py-2">
        {/* 多仓库切换:工作区根目录 + 一级子目录中的独立 git 仓库;
            仅一个子仓库时也显示,便于确认当前查看的仓库 */}
        {(repos.length > 1 || (repos.length === 1 && repo !== '')) && (
          <div className="relative">
            <button
              onClick={() => setRepoMenuOpen((v) => !v)}
              className="flex w-full items-center gap-1.5 rounded border border-border bg-background px-1.5 py-1 text-[10px] font-medium transition-colors hover:bg-accent"
              title="选择 git 仓库"
            >
              <Folder className="h-3 w-3 shrink-0 text-primary/60" />
              <span className="truncate">{repo ? repo : '根目录'}</span>
              <ChevronDown className="ml-auto h-2.5 w-2.5 shrink-0 text-muted-foreground" />
            </button>
            {repoMenuOpen && (
              <div className="absolute left-0 z-50 mt-1 max-h-48 w-full overflow-y-auto rounded-md border bg-popover p-1 shadow-md">
                {repos.map((r) => (
                  <button
                    key={r.path}
                    onClick={() => {
                      onRepoChange?.(r.path);
                      setRepoMenuOpen(false);
                    }}
                    className={cn(
                      'flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-[10px] transition-colors hover:bg-accent',
                      repo === r.path && 'bg-accent/50',
                    )}
                  >
                    <GitCommitHorizontal className="h-3 w-3 shrink-0 text-muted-foreground" />
                    <span className="truncate">{r.path ? r.path : '根目录'}</span>
                    {r.files.length > 0 && (
                      <span className="ml-auto shrink-0 text-[9px] text-muted-foreground/60">
                        {r.files.length} 个变更
                      </span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        <div className="flex items-center gap-1.5">
          <GitCommitHorizontal className="h-3.5 w-3.5 shrink-0 text-primary/60" />
          {/* 分支切换下拉:当前分支 + 其他本地分支,点击直接切换 */}
          <div className="relative min-w-0">
            <button
              onClick={() => setBranchMenuOpen((v) => !v)}
              disabled={branchBusy !== null}
              className="flex max-w-40 items-center gap-1 rounded px-1 py-0.5 text-xs font-medium transition-colors hover:bg-accent disabled:opacity-50"
              title="切换分支"
            >
              <GitBranch className="h-3 w-3 shrink-0 text-muted-foreground" />
              <span className="truncate font-mono">{branch || '—'}</span>
              <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
            </button>
            {branchMenuOpen && (
              <div className="absolute left-0 z-50 mt-1 max-h-64 w-52 overflow-y-auto rounded-md border bg-popover p-1 shadow-md">
                {branchList.length === 0 ? (
                  <div className="px-2 py-1.5 text-[10px] text-muted-foreground">无本地分支</div>
                ) : (
                  branchList.map((b) => {
                    const isCurrent = b.name === branch;
                    const busy = branchBusy === b.name;
                    return (
                      <div
                        key={b.name}
                        className={cn(
                          'group flex w-full items-center rounded transition-colors',
                          isCurrent ? 'bg-accent/60' : 'hover:bg-accent',
                        )}
                      >
                        <button
                          onClick={() => void handleCheckout(b.name)}
                          disabled={isCurrent || branchBusy !== null}
                          className={cn(
                            'flex min-w-0 flex-1 items-center gap-1.5 rounded px-1.5 py-1 text-[11px] transition-colors',
                            isCurrent
                              ? 'font-medium text-foreground'
                              : 'text-muted-foreground hover:text-foreground',
                            branchBusy !== null && 'cursor-default opacity-70',
                          )}
                          title={isCurrent ? '当前分支' : `切换到 ${b.name}`}
                        >
                          {isCurrent ? (
                            <Check className="h-3 w-3 shrink-0 text-primary" />
                          ) : (
                            <GitBranch className="h-3 w-3 shrink-0 text-muted-foreground" />
                          )}
                          <span className="truncate font-mono">{b.name}</span>
                          {busy && <RefreshCw className="ml-auto h-2.5 w-2.5 shrink-0 animate-spin" />}
                        </button>
                        {!isCurrent && (
                          <button
                            onClick={() => {
                              setBranchDeleteTarget(b.name);
                              setBranchMenuOpen(false);
                            }}
                            disabled={branchBusy !== null}
                            className="mr-1 shrink-0 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-red-400 group-hover:opacity-60 disabled:opacity-50"
                            title={`删除分支 ${b.name}`}
                          >
                            <Trash2 className="h-3 w-3" />
                          </button>
                        )}
                      </div>
                    );
                  })
                )}
                <div className="my-0.5 border-t border-border/50" />
                <button
                  onClick={() => {
                    setBranchMenuOpen(false);
                    setBranchCreateError(null);
                    setBranchCreateOpen(true);
                  }}
                  className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  title="基于当前分支新建本地分支"
                >
                  <Plus className="h-3 w-3 shrink-0" />
                  <span>新建分支</span>
                </button>
              </div>
            )}
          </div>
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
        {branchError && (
          <div className="text-[10px] text-destructive">{branchError}</div>
        )}
      </div>

      {/* 变更文件列表 */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {files.length === 0 && !loading && (
          <div className="px-3 py-4 text-center text-xs text-muted-foreground">
            {repos.length === 0 ? '未检测到 git 仓库' : '没有未提交的变更'}
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
              {/* 打开文件编辑:子仓库文件需拼上仓库路径,交给根目录文件服务 */}
              <button
                onClick={() => onOpenFile(repo ? `${repo}/${f.path}` : f.path, fileName)}
                className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-60"
                title="打开文件"
              >
                <FileText className="h-3 w-3" />
              </button>
              {/* 撤销变更 */}
              <button
                onClick={() => setDiscardTarget(f.path)}
                disabled={staging}
                className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-red-400 group-hover:opacity-60 disabled:opacity-50"
                title="撤销变更"
              >
                <RotateCcw className="h-3 w-3" />
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
                ref={prefixBtnRef}
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
                <div
                  className={cn(
                    'absolute left-0 z-50 max-h-48 overflow-y-auto rounded-md border bg-popover p-1 shadow-md',
                    prefixDropUp ? 'bottom-full mb-1' : 'top-full mt-1',
                  )}
                >
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

      {/* 撤销变更确认弹窗 */}
      <Dialog open={discardTarget !== null} onOpenChange={(v) => !v && setDiscardTarget(null)}>
        <DialogContent className="max-w-xs">
          <DialogHeader>
            <DialogTitle>撤销变更</DialogTitle>
            <DialogDescription>
              确定要撤销 <span className="font-mono text-foreground">{discardTarget}</span> 的所有变更吗?此操作不可恢复。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <button
              onClick={() => setDiscardTarget(null)}
              className="rounded border border-border px-3 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              取消
            </button>
            <button
              onClick={() => {
                if (discardTarget) void handleDiscard(discardTarget);
                setDiscardTarget(null);
              }}
              disabled={staging}
              className="rounded bg-red-500 px-3 py-1 text-xs font-medium text-white transition-colors hover:bg-red-600 disabled:opacity-50"
            >
              {staging ? '撤销中...' : '确认撤销'}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 新建分支弹窗 */}
      <Dialog
        open={branchCreateOpen}
        onOpenChange={(v) => {
          setBranchCreateOpen(v);
          if (!v) setBranchCreateError(null);
        }}
      >
        <DialogContent className="max-w-xs">
          <DialogHeader>
            <DialogTitle>新建分支</DialogTitle>
            <DialogDescription>
              基于当前分支 <span className="font-mono text-foreground">{branch || '—'}</span> 创建新的本地分支。
            </DialogDescription>
          </DialogHeader>
          <input
            value={newBranchName}
            onChange={(e) => setNewBranchName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void handleCreateBranch();
              }
            }}
            placeholder="分支名,如 feature/xxx"
            autoFocus
            className="w-full rounded border bg-background px-2 py-1.5 font-mono text-xs outline-none focus:border-primary/50"
          />
          <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-muted-foreground">
            <input
              type="checkbox"
              checked={createAndSwitch}
              onChange={(e) => setCreateAndSwitch(e.target.checked)}
              className="h-3 w-3"
            />
            创建后切换到新分支
          </label>
          {branchCreateError && (
            <div className="text-[10px] text-destructive">{branchCreateError}</div>
          )}
          <DialogFooter>
            <button
              onClick={() => setBranchCreateOpen(false)}
              className="rounded border border-border px-3 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              取消
            </button>
            <button
              onClick={() => void handleCreateBranch()}
              disabled={!newBranchName.trim() || branchCreating}
              className="rounded bg-primary px-3 py-1 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
            >
              {branchCreating ? '创建中...' : '创建'}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 删除分支确认弹窗 */}
      <Dialog
        open={branchDeleteTarget !== null}
        onOpenChange={(v) => {
          if (!v) {
            setBranchDeleteTarget(null);
            setBranchDeleteForce(false);
            setBranchDeleteError(null);
          }
        }}
      >
        <DialogContent className="max-w-xs">
          <DialogHeader>
            <DialogTitle>删除分支</DialogTitle>
            <DialogDescription>
              确定要删除本地分支 <span className="font-mono text-foreground">{branchDeleteTarget}</span> 吗?
            </DialogDescription>
          </DialogHeader>
          <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-muted-foreground">
            <input
              type="checkbox"
              checked={branchDeleteForce}
              onChange={(e) => setBranchDeleteForce(e.target.checked)}
              className="h-3 w-3"
            />
            强制删除(丢弃未合并的提交)
          </label>
          {branchDeleteError && (
            <div className="text-[10px] text-destructive" title={branchDeleteError}>
              {branchDeleteError}
            </div>
          )}
          <DialogFooter>
            <button
              onClick={() => setBranchDeleteTarget(null)}
              className="rounded border border-border px-3 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              取消
            </button>
            <button
              onClick={() => void handleDeleteBranch()}
              disabled={branchDeleting}
              className="rounded bg-red-500 px-3 py-1 text-xs font-medium text-white transition-colors hover:bg-red-600 disabled:opacity-50"
            >
              {branchDeleting ? '删除中...' : '确认删除'}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
