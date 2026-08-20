import { useEffect, useState } from 'react';
import { Loader2, MessageSquare, Pencil, Trash2 } from 'lucide-react';
import type { Api } from '../../lib/api/types';
import { useAgentStore } from '../../stores/agentStore';
import { cn } from '../../lib/utils';

function formatTime(secs: number | undefined): string {
  if (!secs) return '';
  const ms = secs > 1e12 ? secs : secs * 1000;
  const diff = Date.now() - ms;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatCost(cost: number): string {
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(2)}`;
}

interface SessionRowProps {
  session: Api.Session;
  isActive: boolean;
  onActivate: () => void;
  onRename: (title: string) => Promise<unknown>;
  onDelete: () => void;
  /** 分组视图下行首缩进(pl-7)等额外 class */
  rowClassName?: string;
  showTime?: boolean;
  iconClassName?: string;
  /** 服务端上报的运行态(会话列表 is_busy);与本地 SSE 运行态取或 */
  isBusy?: boolean;
}

export function SessionRow({
  session,
  isActive,
  onActivate,
  onRename,
  onDelete,
  rowClassName,
  showTime = true,
  iconClassName,
  isBusy = false,
}: SessionRowProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(session.title);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  // 本地 SSE 运行态:selector 返回布尔,仅该会话 running 状态翻转时重渲染本行
  const localRunning = useAgentStore(
    (s) => s.bySession[session.id]?.run?.status === 'running',
  );
  // 未读标记:run 在未查看该会话期间结束(状态变了但没读过),点开后清除
  const unread = useAgentStore((s) => s.unreadSessions[session.id] === true);
  const busy = isBusy || localRunning;

  useEffect(() => {
    if (!ctxMenu) return;
    const close = () => setCtxMenu(null);
    window.addEventListener('click', close);
    window.addEventListener('contextmenu', close);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setCtxMenu(null);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('contextmenu', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [ctxMenu]);

  function startEdit() {
    setDraft(session.title);
    setEditing(true);
  }

  async function commitEdit() {
    const title = draft.trim();
    setEditing(false);
    if (!title || title === session.title) return;
    try {
      await onRename(title);
    } catch {
      /* 重命名失败忽略,列表会 refetch 回滚 */
    }
  }

  return (
    <>
      <div
        className={cn(
          'group flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] transition-colors hover:bg-surface-hover',
          isActive && 'bg-surface-hover text-foreground',
          rowClassName,
        )}
        title={busy ? '任务正在处理中' : unread ? '有未读的新结果' : undefined}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setCtxMenu({ x: e.clientX, y: e.clientY });
        }}
      >
        {busy ? (
          <Loader2
            className={cn('size-3.5 shrink-0 animate-spin text-brand', iconClassName)}
            aria-label="任务正在处理中"
          />
        ) : (
          <span className="relative flex shrink-0">
            <MessageSquare
              className={cn(
                'size-3.5',
                isActive || unread ? 'text-foreground' : 'text-foreground-subtlest',
                iconClassName,
              )}
            />
            {/* 未读角标:run 结束但用户还没看过该会话的结果 */}
            {unread && !isActive && (
              <span
                className="absolute -top-1 -right-1 size-2 rounded-full bg-brand ring-2 ring-background"
                aria-label="有未读的新结果"
              />
            )}
          </span>
        )}
        {editing ? (
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => void commitEdit()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void commitEdit();
              if (e.key === 'Escape') setEditing(false);
            }}
            onClick={(e) => e.stopPropagation()}
            className="w-full min-w-0 flex-1 rounded border border-input-border bg-background px-1.5 py-0.5 text-[13px] outline-none"
          />
        ) : (
          <>
            <button
              className={cn(
                'min-w-0 flex-1 truncate text-left',
                unread && !isActive && 'font-medium text-foreground',
              )}
              onClick={onActivate}
            >
              {session.title}
            </button>
            {showTime && (
              <span className="shrink-0 text-[11px] text-foreground-subtlest">
                {formatTime(session.created_at)}
              </span>
            )}
            {(session.prompt_tokens > 0 || session.completion_tokens > 0) && (
              <span
                className="shrink-0 rounded bg-surface-hover px-1 text-[10px] tabular-nums text-foreground-subtlest"
                title={`输入 ${formatTokens(session.prompt_tokens)} / 输出 ${formatTokens(session.completion_tokens)}${session.cost > 0 ? ` / 花费 ${formatCost(session.cost)}` : ''}`}
              >
                {formatTokens(session.prompt_tokens + session.completion_tokens)}
              </span>
            )}
            <button
              onClick={(e) => {
                e.stopPropagation();
                startEdit();
              }}
              title="重命名会话"
              className="shrink-0 rounded-md p-0.5 text-foreground-subtle opacity-100 transition-opacity hover:bg-surface-hover hover:text-foreground md:opacity-0 md:group-hover:opacity-100"
            >
              <Pencil className="size-3" />
            </button>
            <button
              className="shrink-0 opacity-100 transition-opacity hover:text-destructive md:opacity-0 md:group-hover:opacity-100"
              title="删除会话"
              onClick={(e) => {
                e.stopPropagation();
                onDelete();
              }}
            >
              <Trash2 className="size-3.5" />
            </button>
          </>
        )}
      </div>
      {ctxMenu && (
        <div
          className="fixed z-50 min-w-[140px] rounded-lg border border-border bg-popover p-1 text-[13px] text-popover-foreground shadow-lg"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
          onClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.preventDefault()}
        >
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left transition-colors hover:bg-surface-hover"
            onClick={() => {
              startEdit();
              setCtxMenu(null);
            }}
          >
            <Pencil className="size-3.5 shrink-0 text-foreground-subtle" />
            <span>重命名</span>
          </button>
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-destructive transition-colors hover:bg-destructive/10"
            onClick={() => {
              setCtxMenu(null);
              onDelete();
            }}
          >
            <Trash2 className="size-3.5 shrink-0" />
            <span>删除会话</span>
          </button>
        </div>
      )}
    </>
  );
}
