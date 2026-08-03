import { MessageSquare, MessageSquarePlus } from 'lucide-react';
import { Button } from '../ui/button';
import { useSessions } from '../../hooks/useSessions';
import { useAgentStore } from '../../stores/agentStore';
import { cn } from '../../lib/utils';

function formatTime(secs: number | undefined): string {
  if (!secs) return '';
  // rune 返回的是秒级时间戳;毫秒值(>1e12)直接当作 Date 输入
  const ms = secs > 1e12 ? secs : secs * 1000;
  const diff = Date.now() - ms;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
}

/** 侧边栏「任务」分区内容:当前项目下的会话列表 */
export function ConversationList() {
  const workspaceId = useAgentStore((s) => s.activeWorkspaceId);
  const activeSessionId = useAgentStore((s) => s.activeSessionId);
  const { sessions, isLoading, create, activate } = useSessions(workspaceId);

  if (!workspaceId) {
    return (
      <div className="px-3 py-2 text-[13px] text-foreground-subtle">
        先添加/选择项目,再创建任务。
      </div>
    );
  }

  async function onNew() {
    const base = `会话 ${(sessions?.length ?? 0) + 1}`;
    await create(base);
  }

  return (
    <div className="flex flex-col gap-0.5">
      {isLoading && (
        <div className="px-3 py-2 text-[13px] text-foreground-subtle">加载中…</div>
      )}
      {sessions?.map((s) => (
        <button
          key={s.id}
          onClick={() => void activate(s.id)}
          className={cn(
            'group flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] transition-colors hover:bg-surface-hover',
            activeSessionId === s.id && 'bg-surface-hover text-foreground'
          )}
        >
          <MessageSquare
            className={cn(
              'size-3.5 shrink-0',
              activeSessionId === s.id ? 'text-foreground' : 'text-foreground-subtlest'
            )}
          />
          <span className="min-w-0 flex-1 truncate">{s.title}</span>
          <span className="shrink-0 text-[11px] text-foreground-subtlest">
            {formatTime(s.created_at)}
          </span>
        </button>
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
