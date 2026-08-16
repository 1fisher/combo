import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CornerDownLeft, Folder, Loader2, MessageSquare, Search, X } from 'lucide-react';
import { listWorkspaces, listSessions } from '../../lib/api';
import { useAgentStore } from '../../stores/agentStore';
import { cn } from '../../lib/utils';
import { HeroBackdrop } from '../agent/HeroBackdrop';
import { PAGE } from './PageShell';
import type { Api } from '../../lib/api/types';

/**
 * 搜索视图(主内容区独立视图):空查询时是 hero 首页——Combo 线框字背景 +
 * 问候语 + 居中大搜索框 + 项目/任务统计;输入后切换为全宽结果页,输入框
 * 置顶收窄。输入框是同一个 DOM 节点(仅容器类名变化),打字切换布局不丢焦点。
 */

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

function formatTime(ts: number | null | undefined): string {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  return d.toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

export function SearchView({ onNavigate }: { onNavigate?: () => void }) {
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const qc = useQueryClient();

  const { data: workspaces } = useQuery({
    queryKey: ['workspaces'],
    queryFn: listWorkspaces,
  });

  // 并发拉取所有项目的会话列表(视图挂载即拉取,staleTime 避免频繁重打)
  const wsList = useMemo(() => workspaces ?? [], [workspaces]);
  const allSessions = useQuery({
    queryKey: ['search-sessions', wsList.map((w) => w.id).join(',')],
    queryFn: async () => {
      const results: { workspaceId: string; workspaceName: string; sessions: Api.Session[] }[] = [];
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
    enabled: wsList.length > 0,
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
    if (!q) return [];
    return [
      ...wsHits.filter(
        (w) => w.name.toLowerCase().includes(q) || w.path.toLowerCase().includes(q)
      ),
      ...sessHits.filter(
        (s) => s.title.toLowerCase().includes(q) || s.workspaceName.toLowerCase().includes(q)
      ),
    ];
  }, [query, workspaces, allSessions.data]);

  const totalSessions = useMemo(
    () => (allSessions.data ?? []).reduce((n, g) => n + g.sessions.length, 0),
    [allSessions.data]
  );

  const searching = query.trim().length > 0;

  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

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
    } else if (e.key === 'Escape' && query) {
      setQuery('');
    }
  }

  // 滚动到 active 项
  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-idx="${activeIndex}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  return (
    <div className="relative flex h-full w-full min-h-0 flex-col bg-background">
      {/* hero 背景:仅首页(空查询)显示 */}
      {!searching && <HeroBackdrop />}

      <div className="relative flex min-h-0 flex-1 flex-col">
        {/* 问候语(仅首页;搜索时此槽渲染 null,输入框 DOM 不受影响) */}
        {!searching && (
          <div className="relative z-10 mx-auto mb-8 mt-auto flex w-full max-w-2xl flex-col items-center gap-5">
            <p className="w-full px-4 text-center font-medium text-foreground max-md:text-xl text-3xl">
              找到你的每一场对话
            </p>
            <p className="max-w-md px-4 text-center text-[13px] leading-relaxed text-foreground-subtle">
              跨全部项目搜索会话与任务,回车直接打开第一个结果。
            </p>
          </div>
        )}

        {/* 搜索框:首页居中大号,搜索时置顶收窄(同一 DOM 节点,打字不丢焦点) */}
        <div className={cn('relative z-10 mx-auto w-full', searching ? '' : 'mb-auto max-w-2xl')}>
          <div
            className={cn(
              'mx-auto flex items-center gap-3 rounded-xl border border-border bg-surface-hover/60 pl-4 pr-2.5 backdrop-blur transition-all outline-none focus-within:border-ring/60 focus-within:ring-1 focus-within:ring-ring/40',
              searching ? 'h-11 max-w-[1400px]' : 'h-12 max-w-2xl'
            )}
          >
            <Search className="size-4.5 shrink-0 text-foreground-subtlest" />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="搜索项目或任务…"
              className={cn(
                'w-full bg-transparent text-foreground outline-none placeholder:text-foreground-subtlest',
                searching ? 'text-sm' : 'text-base'
              )}
            />
            {query && (
              <button
                onClick={() => setQuery('')}
                className="shrink-0 rounded p-1 text-foreground-subtlest transition-colors hover:text-foreground"
                aria-label="清除"
              >
                <X className="size-4" />
              </button>
            )}
          </div>
          {!searching && (
            <p className="mt-3 text-center text-[13px] text-foreground-subtlest">
              {allSessions.isLoading ? (
                <span className="inline-flex items-center gap-1.5">
                  <Loader2 className="size-3.5 animate-spin" /> 正在加载项目与会话…
                </span>
              ) : (
                `共 ${wsList.length} 个项目 · ${totalSessions} 个任务`
              )}
            </p>
          )}
        </div>

        {/* 结果列表(仅搜索时;此槽在首页渲染 null) */}
        {searching && (
          <div
            ref={listRef}
            className="relative z-10 mx-auto mt-5 min-h-0 w-full max-w-[1400px] flex-1 overflow-y-auto px-6 pb-10 md:px-10"
          >
            <p className="mb-4 text-[13px] text-foreground-subtlest">
              共 {hits.length} 个结果
            </p>
            {hits.length === 0 && (
              <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border px-6 py-16 text-center">
                <span className="flex size-12 items-center justify-center rounded-xl bg-surface-hover">
                  <Search className="size-6 text-foreground-subtle" />
                </span>
                <p className="mt-3 text-sm font-medium text-foreground">没有匹配结果</p>
                <p className="mt-1 text-[13px] text-foreground-subtlest">
                  试试其他关键词,或按 Esc 清空返回首页。
                </p>
              </div>
            )}
            <div className={cn(PAGE, 'gap-3 p-0')}>
              {hits.map((hit, idx) => {
                const active = activeIndex === idx;
                return (
                  <button
                    key={`${hit.type}-${hit.type === 'workspace' ? hit.workspaceId : hit.sessionId}`}
                    data-idx={idx}
                    onClick={() => selectHit(hit)}
                    onMouseEnter={() => setActiveIndex(idx)}
                    className={cn(
                      'flex items-center gap-4 rounded-xl border px-5 py-4 text-left transition-colors',
                      active
                        ? 'border-ring/50 bg-surface-hover'
                        : 'border-border bg-surface-hover/40 hover:bg-surface-hover'
                    )}
                  >
                    <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-surface-hover">
                      {hit.type === 'workspace' ? (
                        <Folder className="size-4.5 text-brand" />
                      ) : (
                        <MessageSquare className="size-4.5 text-foreground-subtle" />
                      )}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium text-foreground">
                          {hit.type === 'workspace' ? hit.name : hit.title}
                        </span>
                        <span className="shrink-0 rounded-full bg-surface-hover px-2 py-0.5 text-xs text-foreground-subtle">
                          {hit.type === 'workspace' ? '项目' : '任务'}
                        </span>
                      </div>
                      <p className="mt-0.5 truncate text-[13px] text-foreground-subtle">
                        {hit.type === 'workspace' ? hit.path : hit.workspaceName}
                      </p>
                    </div>
                    {hit.type === 'session' && hit.createdAt && (
                      <span className="shrink-0 text-[12px] tabular-nums text-foreground-subtlest">
                        {formatTime(hit.createdAt)}
                      </span>
                    )}
                    {active && (
                      <span className="flex shrink-0 items-center gap-1 text-xs text-foreground-subtlest">
                        <CornerDownLeft className="size-3" /> 打开
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
