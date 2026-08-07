import { useEffect, useState } from 'react';
import { MessageSquare, Pencil, Trash2 } from 'lucide-react';
import type { Api } from '../../lib/api/types';
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
}: SessionRowProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(session.title);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);

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
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setCtxMenu({ x: e.clientX, y: e.clientY });
        }}
      >
        <MessageSquare
          className={cn(
            'size-3.5 shrink-0',
            isActive ? 'text-foreground' : 'text-foreground-subtlest',
            iconClassName,
          )}
        />
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
              className="min-w-0 flex-1 truncate"
              onClick={onActivate}
            >
              {session.title}
            </button>
            {showTime && (
              <span className="shrink-0 text-[11px] text-foreground-subtlest">
                {formatTime(session.created_at)}
              </span>
            )}
            <button
              onClick={(e) => {
                e.stopPropagation();
                startEdit();
              }}
              title="重命名会话"
              className="shrink-0 rounded-md p-0.5 text-foreground-subtle opacity-0 transition-opacity hover:bg-surface-hover hover:text-foreground group-hover:opacity-100"
            >
              <Pencil className="size-3" />
            </button>
            <button
              className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100 hover:text-destructive"
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
