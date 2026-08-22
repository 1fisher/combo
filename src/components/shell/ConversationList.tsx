import { useEffect, useRef } from 'react';
import { useSessions } from '../../hooks/useSessions';
import { useActiveWorkspaceId } from '../../hooks/useActiveWorkspaceId';
import { useAgentStore } from '../../stores/agentStore';
import { deleteSessionWithConfirm } from './sessionDelete';
import { SessionRow } from './SessionRow';

export type SortMode = 'recent' | 'name';

/** 任务筛选模式:全部 / 运行中 / 今天 / 最近 7 天 */
export type FilterMode = 'all' | 'busy' | 'today' | 'week';

/** 筛选模式的菜单文案(与 WorkspaceSidebar 的筛选菜单共用同一份) */
export const FILTER_MODES: readonly [FilterMode, string][] = [
  ['all', '全部任务'],
  ['busy', '运行中'],
  ['today', '今天'],
  ['week', '最近 7 天'],
];

interface ConversationListProps {
  onNavigate?: () => void;
  sortMode?: SortMode;
  /** 状态/时间筛选,默认 all(不筛) */
  filter?: FilterMode;
}

const DAY_MS = 24 * 60 * 60 * 1000;

const EMPTY_TEXT: Record<FilterMode, string> = {
  all: '还没有任务',
  busy: '没有运行中的任务',
  today: '今天还没有任务',
  week: '最近 7 天没有任务',
};

/** 会话创建时间(ms,兼容秒级时间戳) */
function sessionCreatedMs(s: { created_at?: number }): number {
  const ts = s.created_at ?? 0;
  return ts > 1e12 ? ts : ts * 1000;
}

/** 是否命中筛选条件(today 按本地日历日判断,busy 看 is_busy) */
function matchFilter(
  s: { created_at?: number; is_busy?: boolean },
  filter: FilterMode,
): boolean {
  switch (filter) {
    case 'busy':
      return s.is_busy === true;
    case 'today': {
      const d = new Date(sessionCreatedMs(s));
      const n = new Date();
      return (
        d.getFullYear() === n.getFullYear() &&
        d.getMonth() === n.getMonth() &&
        d.getDate() === n.getDate()
      );
    }
    case 'week':
      return Date.now() - sessionCreatedMs(s) < 7 * DAY_MS;
    default:
      return true;
  }
}

/** 哨兵距视口底部多近时开始预取下一页(px):提前一屏加载,滚动无感。 */
const PREFETCH_MARGIN_PX = 320;

export function ConversationList({
  onNavigate,
  sortMode = 'recent',
  filter = 'all',
}: ConversationListProps = {}) {
  const workspaceId = useActiveWorkspaceId();
  const activeSessionId = useAgentStore((s) => s.activeSessionId);
  const {
    sessions,
    isLoading,
    activate,
    remove,
    rename,
    hasNextPage,
    isFetchingNextPage,
    isFetchNextPageError,
    fetchNextPage,
  } = useSessions(workspaceId);

  // 无限滚动哨兵:进入预取区(或已在其内)时加载下一页。
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  // observer 回调只创建一次,通过 ref 读取最新的分页状态。
  const loadStateRef = useRef({ hasNextPage, isFetchingNextPage, fetchNextPage });
  loadStateRef.current = { hasNextPage, isFetchingNextPage, fetchNextPage };

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        const s = loadStateRef.current;
        if (s.hasNextPage && !s.isFetchingNextPage) void s.fetchNextPage();
      },
      { rootMargin: `${PREFETCH_MARGIN_PX}px 0px` },
    );
    observer.observe(el);
    return () => observer.disconnect();
    // workspace 切换时哨兵重新挂载,重建 observer
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  // IntersectionObserver 对「持续可见」不会再次触发:一页加载完后哨兵
  // 可能仍在预取区内(首页内容不足一屏、筛选条件在已加载页里没有
  // 匹配项等),这里主动补一次测量续拉,直到哨兵移出预取区或没有下一页。
  // getClientRects 为空说明分区处于 display:none(折叠),不拉。
  useEffect(() => {
    if (!hasNextPage || isFetchingNextPage) return;
    const el = sentinelRef.current;
    if (!el || el.getClientRects().length === 0) return;
    if (el.getBoundingClientRect().top <= window.innerHeight + PREFETCH_MARGIN_PX) {
      void fetchNextPage();
    }
  }, [hasNextPage, isFetchingNextPage, fetchNextPage, sessions?.length]);

  if (!workspaceId) {
    return (
      <div className="px-3 py-2 text-[13px] text-foreground-subtle">
        先添加/选择项目,再创建任务。
      </div>
    );
  }

  const showList = [...(sessions ?? [])]
    .sort((a, b) => {
      if (sortMode === 'name') return a.title.localeCompare(b.title, 'zh');
      return (b.created_at ?? 0) - (a.created_at ?? 0);
    })
    .filter((s) => matchFilter(s, filter));

  return (
    <div className="flex flex-col gap-0.5">
      {isLoading && (
        <div className="px-3 py-2 text-[13px] text-foreground-subtle">加载中…</div>
      )}
      {showList.map((s) => (
        <SessionRow
          key={s.id}
          session={s}
          isActive={activeSessionId === s.id}
          isBusy={s.is_busy === true}
          onActivate={() => {
            void activate(s.id);
            onNavigate?.();
          }}
          onRename={(title) => rename({ id: s.id, title })}
          onDelete={() => void deleteSessionWithConfirm(s, remove)}
        />
      ))}
      {/* 无感加载哨兵:滚动接近列表尾部时自动拉取下一页 */}
      <div ref={sentinelRef} aria-hidden="true" className="h-px" data-testid="session-list-sentinel" />
      {!isLoading && isFetchingNextPage && (
        <div className="px-3 py-1.5 text-[13px] text-foreground-subtlest">加载更多…</div>
      )}
      {!isLoading && isFetchNextPageError && (
        <button
          type="button"
          className="px-3 py-1.5 text-left text-[13px] text-warning hover:underline"
          onClick={() => void fetchNextPage()}
        >
          加载失败,点击重试
        </button>
      )}
      {!isLoading && showList.length === 0 && !hasNextPage && (
        <div className="px-3 py-2 text-[13px] text-foreground-subtle">
          {EMPTY_TEXT[filter]}
        </div>
      )}
    </div>
  );
}
