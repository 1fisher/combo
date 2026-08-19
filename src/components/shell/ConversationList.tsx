import { useSessions } from '../../hooks/useSessions';
import { useActiveWorkspaceId } from '../../hooks/useActiveWorkspaceId';
import { useAgentStore } from '../../stores/agentStore';
import { deleteSessionWithConfirm } from './sessionDelete';
import { SessionRow } from './SessionRow';

export type SortMode = 'recent' | 'name';

interface ConversationListProps {
  onNavigate?: () => void;
  sortMode?: SortMode;
  archiveOpen?: boolean;
}

const ARCHIVE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;

export function ConversationList({
  onNavigate,
  sortMode = 'recent',
  archiveOpen = false,
}: ConversationListProps = {}) {
  const workspaceId = useActiveWorkspaceId();
  const activeSessionId = useAgentStore((s) => s.activeSessionId);
  const { sessions, isLoading, activate, remove, rename } = useSessions(workspaceId);

  if (!workspaceId) {
    return (
      <div className="px-3 py-2 text-[13px] text-foreground-subtle">
        先添加/选择项目,再创建任务。
      </div>
    );
  }

  // 拆分:活跃会话 vs 归档会话(超过7天)
  const now = Date.now();
  const allSorted = [...(sessions ?? [])].sort((a, b) => {
    if (sortMode === 'name') return a.title.localeCompare(b.title, 'zh');
    return (b.created_at ?? 0) - (a.created_at ?? 0);
  });
  const activeSessions = archiveOpen
    ? allSorted.filter((s) => {
        const ts = s.created_at ?? 0;
        const ms = ts > 1e12 ? ts : ts * 1000;
        return now - ms < ARCHIVE_THRESHOLD_MS;
      })
    : allSorted;
  const archivedSessions = allSorted.filter((s) => {
    const ts = s.created_at ?? 0;
    const ms = ts > 1e12 ? ts : ts * 1000;
    return now - ms >= ARCHIVE_THRESHOLD_MS;
  });

  const showList = archiveOpen ? archivedSessions : activeSessions;

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
      {!isLoading && showList.length === 0 && (
        <div className="px-3 py-2 text-[13px] text-foreground-subtle">
          {archiveOpen ? '没有归档的任务' : '还没有任务'}
        </div>
      )}
    </div>
  );
}
