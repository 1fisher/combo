import { MessageSquarePlus } from 'lucide-react';
import { Button } from '../ui/button';
import { useSessions } from '../../hooks/useSessions';
import { useActiveWorkspaceId } from '../../hooks/useActiveWorkspaceId';
import { useAgentStore } from '../../stores/agentStore';
import { confirmDialog } from '../../lib/confirm';
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
  const { sessions, isLoading, create, activate, remove, rename } = useSessions(workspaceId);

  if (!workspaceId) {
    return (
      <div className="px-3 py-2 text-[13px] text-foreground-subtle">
        先添加/选择项目,再创建任务。
      </div>
    );
  }

  async function onNew() {
    const base = `会话 ${(sessions?.length ?? 0) + 1}`;
    const s = await create(base);
    void activate(s.id);
    onNavigate?.();
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
          onActivate={() => {
            void activate(s.id);
            onNavigate?.();
          }}
          onRename={(title) => rename({ id: s.id, title })}
          onDelete={() =>
            void confirmDialog('确定删除此会话?').then((ok) => {
              if (ok) void remove(s.id);
            })
          }
        />
      ))}
      {!isLoading && showList.length === 0 && (
        <div className="px-3 py-2 text-[13px] text-foreground-subtle">
          {archiveOpen ? '没有归档的任务' : '还没有任务'}
        </div>
      )}
      {!isLoading && !archiveOpen && sessions && (
        <Button
          variant="ghost"
          size="sm"
          className="h-7 justify-start gap-1.5 px-2.5 text-[13px] font-normal text-foreground-subtle hover:text-foreground"
          onClick={() => void onNew()}
          title="新建会话"
        >
          <MessageSquarePlus className="size-3.5" />
          新建会话
        </Button>
      )}
    </div>
  );
}
