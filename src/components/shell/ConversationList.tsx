import { MessageSquarePlus } from 'lucide-react';
import { Button } from '../ui/button';
import { useSessions } from '../../hooks/useSessions';
import { useActiveWorkspaceId } from '../../hooks/useActiveWorkspaceId';
import { useAgentStore } from '../../stores/agentStore';
import { confirmDialog } from '../../lib/confirm';
import { SessionRow } from './SessionRow';

/** 侧边栏「任务」分区内容:当前项目下的会话列表 */
export function ConversationList() {
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
  }

  return (
    <div className="flex flex-col gap-0.5">
      {isLoading && (
        <div className="px-3 py-2 text-[13px] text-foreground-subtle">加载中…</div>
      )}
      {sessions?.map((s) => (
        <SessionRow
          key={s.id}
          session={s}
          isActive={activeSessionId === s.id}
          onActivate={() => void activate(s.id)}
          onRename={(title) => rename({ id: s.id, title })}
          onDelete={() =>
            void confirmDialog('确定删除此会话?').then((ok) => {
              if (ok) void remove(s.id);
            })
          }
        />
      ))}
      {!isLoading && sessions?.length === 0 && (
        <div className="px-3 py-2 text-[13px] text-foreground-subtle">还没有任务</div>
      )}
      {!isLoading && sessions && (
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
