import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CornerDownLeft,
  Folder,
  MessageSquare,
  Search,
  X,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from '../ui/dialog';
import { listWorkspaces, listSessions } from '../../lib/api';
import { useAgentStore } from '../../stores/agentStore';
import { cn } from '../../lib/utils';
import type { Api } from '../../lib/api/types';

interface SearchDialogProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onNavigate?: () => void;
}

interface SessionHit {
  type: 'session';
  sessionId: string;
  title: string;
  workspaceId: string;
  workspaceName: string;
  createdAt?: number;
}

interface WorkspaceHit {
  type: 'workspace';
  workspaceId: string;
  name: string;
  path: string;
}

type Hit = SessionHit | WorkspaceHit;

export function SearchDialog({ open, onOpenChange, onNavigate }: SearchDialogProps) {
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const qc = useQueryClient();

  const { data: workspaces } = useQuery({
    queryKey: ['workspaces'],
    queryFn: listWorkspaces,
    enabled: open,
  });

  // 并发拉取所有项目的会话列表(仅 dialog 打开时)
  const wsList = useMemo(() => workspaces ?? [], [workspaces]);
  const allSessions = useQuery({
    queryKey: ['search-sessions', wsList.map((w) => w.id).join(',')],
    queryFn: async () => {
      const results: { workspaceId: string; workspaceName: string; sessions: Api.Session[] }[] =
        [];
      await Promise.all(
        wsList.map(async (w) => {
          try {
            const sessions = await listSessions(w.id);
            results.push({
              workspaceId: w.id,
              workspaceName: w.name || w.path,
              sessions,
            });
          } catch {
            /* 单个项目失败不阻塞搜索 */
          }
        })
      );
      return results;
    },
    enabled: open && wsList.length > 0,
    staleTime: 10_000,
  });

  const setActiveWorkspace = useAgentStore((s) => s.setActiveWorkspace);
  const setActiveSessionId = useAgentStore((s) => s.setActiveSessionId);

  const hits = useMemo<Hit[]>(() => {
    const q = query.trim().toLowerCase();
    const wsHits: WorkspaceHit[] = (workspaces ?? []).map((w) => ({
      type: 'workspace' as const,
      workspaceId: w.id,
      name: w.name || w.path,
      path: w.path,
    }));
    const sessHits: SessionHit[] = [];
    for (const group of allSessions.data ?? []) {
      for (const s of group.sessions) {
        sessHits.push({
          type: 'session',
          sessionId: s.id,
          title: s.title,
          workspaceId: group.workspaceId,
          workspaceName: group.workspaceName,
          createdAt: s.created_at,
        });
      }
    }
    if (!q) {
      return [...wsHits.slice(0, 5), ...sessHits.slice(0, 10)];
    }
    return [
      ...wsHits.filter(
        (w) => w.name.toLowerCase().includes(q) || w.path.toLowerCase().includes(q)
      ),
      ...sessHits.filter(
        (s) =>
          s.title.toLowerCase().includes(q) ||
          s.workspaceName.toLowerCase().includes(q)
      ),
    ];
  }, [query, workspaces, allSessions.data]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  useEffect(() => {
    if (open) {
      setQuery('');
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  function selectHit(hit: Hit) {
    if (hit.type === 'workspace') {
      setActiveWorkspace(hit.workspaceId);
    } else {
      setActiveWorkspace(hit.workspaceId);
      setActiveSessionId(hit.sessionId);
      // 刷新历史缓存
      qc.invalidateQueries({
        queryKey: ['history', hit.workspaceId, hit.sessionId],
      });
    }
    onNavigate?.();
    onOpenChange(false);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, hits.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const hit = hits[activeIndex];
      if (hit) selectHit(hit);
    }
  }

  // 滚动到 active 项
  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-idx="${activeIndex}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="gap-0 overflow-hidden p-0 sm:max-w-lg"
        onKeyDown={onKeyDown}
      >
        <DialogTitle className="sr-only">搜索</DialogTitle>
        {/* 搜索栏 */}
        <div className="flex items-center gap-2.5 border-b border-border py-2.5 pr-9 pl-3">
          <Search className="size-4 shrink-0 text-foreground-subtlest" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索项目或任务…"
            className="w-full bg-transparent text-[14px] outline-none placeholder:text-foreground-subtlest"
          />
          {query && (
            <button
              onClick={() => setQuery('')}
              className="shrink-0 rounded p-0.5 text-foreground-subtlest hover:text-foreground"
              aria-label="清除"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>
        {/* 结果列表 */}
        <div ref={listRef} className="max-h-[50vh] overflow-y-auto py-1.5">
          {hits.length === 0 && (
            <div className="px-4 py-6 text-center text-[13px] text-foreground-subtle">
              {query ? '没有匹配结果' : '开始输入以搜索'}
            </div>
          )}
          {hits.map((hit, idx) => (
            <button
              key={`${hit.type}-${hit.type === 'workspace' ? hit.workspaceId : hit.sessionId}`}
              data-idx={idx}
              onClick={() => selectHit(hit)}
              onMouseEnter={() => setActiveIndex(idx)}
              className={cn(
                'flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors',
                activeIndex === idx ? 'bg-surface-hover' : 'hover:bg-surface-hover/50'
              )}
            >
              <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-surface-hover">
                {hit.type === 'workspace' ? (
                  <Folder className="size-3.5 text-brand" />
                ) : (
                  <MessageSquare className="size-3.5 text-foreground-subtle" />
                )}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium text-foreground">
                  {hit.type === 'workspace' ? hit.name : hit.title}
                </span>
                <span className="block truncate text-[12px] text-foreground-subtle">
                  {hit.type === 'workspace'
                    ? hit.path
                    : hit.workspaceName}
                </span>
              </span>
              {hit.type === 'session' && (
                <span className="shrink-0 rounded-full bg-surface-hover px-2 py-0.5 text-[11px] text-foreground-subtle">
                  任务
                </span>
              )}
              {hit.type === 'workspace' && (
                <span className="shrink-0 rounded-full bg-surface-hover px-2 py-0.5 text-[11px] text-foreground-subtle">
                  项目
                </span>
              )}
            </button>
          ))}
        </div>
        {/* 底部提示 */}
        <div className="flex items-center justify-between border-t border-border px-3 py-1.5 text-[11px] text-foreground-subtlest">
          <span className="flex items-center gap-1">
            <kbd className="rounded border border-border bg-surface px-1 py-px">↑</kbd>
            <kbd className="rounded border border-border bg-surface px-1 py-px">↓</kbd>
            导航
          </span>
          <span className="flex items-center gap-1">
            <CornerDownLeft className="size-3" />
            选择
          </span>
        </div>
      </DialogContent>
    </Dialog>
  );
}
