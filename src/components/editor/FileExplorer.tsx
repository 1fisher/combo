import { useEffect, useState } from 'react';
import { ChevronRight, FileText, Folder, FolderOpen, MessageSquarePlus, MoreHorizontal } from 'lucide-react';
import { listFiles } from '../../lib/api';
import type { Api } from '../../lib/api/types';
import { cn } from '../../lib/utils';
import { useContextStore } from '../../stores/contextStore';
import { ContextMenu, type MenuItem } from '../ui/ContextMenu';

interface Props {
  workspaceId: string;
  onOpenFile: (path: string, name: string) => void;
  onError: (msg: string) => void;
}

/**
 * 懒加载的目录树:目录首次展开时才向后端请求子项。
 */
export function FileExplorer({ workspaceId, onOpenFile, onError }: Props) {
  const [byDir, setByDir] = useState<Record<string, Api.FileEntry[]>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [menu, setMenu] = useState<{ x: number; y: number; entry: Api.FileEntry } | null>(null);
  const addItem = useContextStore((s) => s.addItem);

  useEffect(() => {
    setByDir({});
    setExpanded({});
    void load('');
    // 切换项目时重新加载根目录
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  async function load(dir: string) {
    try {
      const entries = await listFiles(workspaceId, dir);
      setByDir((m) => ({ ...m, [dir]: entries }));
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    }
  }

  function toggle(dir: string) {
    const willOpen = !expanded[dir];
    setExpanded((m) => ({ ...m, [dir]: willOpen }));
    if (willOpen && !byDir[dir]) void load(dir);
  }

  function contextMenuItems(entry: Api.FileEntry): MenuItem[] {
    const items: MenuItem[] = [];
    if (entry.type !== 'dir') {
      items.push({
        label: '添加到对话',
        icon: <MessageSquarePlus className="size-3.5 text-muted-foreground" />,
        onClick: () =>
          addItem({ filePath: entry.path, fileName: entry.name, type: 'file' }),
      });
    }
    return items;
  }

  /** 打开上下文菜单:右键用指针坐标,行内按钮用按钮位置 */
  function openMenu(
    ev: React.MouseEvent,
    entry: Api.FileEntry,
    fromButton = false,
  ) {
    const list = contextMenuItems(entry);
    if (list.length === 0) return;
    ev.preventDefault();
    ev.stopPropagation();
    if (fromButton) {
      const rect = (ev.currentTarget as HTMLElement).getBoundingClientRect();
      setMenu({ x: rect.left, y: rect.bottom, entry });
    } else {
      setMenu({ x: ev.clientX, y: ev.clientY, entry });
    }
  }

  function renderDir(dir: string, depth: number) {
    const entries = byDir[dir] ?? [];
    return (
      <div key={dir}>
        {entries.map((e) => {
          const isDir = e.type === 'dir';
          const hasMenu = contextMenuItems(e).length > 0;
          return (
            <div key={e.path}>
              <div className="group flex items-center">
              <button
                onClick={() => (isDir ? toggle(e.path) : onOpenFile(e.path, e.name))}
                onContextMenu={(ev) => openMenu(ev, e)}
                className={cn(
                  'flex min-w-0 flex-1 items-center gap-1.5 rounded py-1 pr-2 text-left transition-colors hover:bg-accent',
                  !isDir && 'pl-6'
                )}
                style={{ paddingLeft: isDir ? 8 + depth * 14 : 24 + depth * 14 }}
                title={e.path}
              >
                {isDir ? (
                  <>
                    <ChevronRight
                      className={cn(
                        'h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform',
                        expanded[e.path] && 'rotate-90'
                      )}
                    />
                    {expanded[e.path] ? (
                      <FolderOpen className="h-3.5 w-3.5 shrink-0 text-primary/70" />
                    ) : (
                      <Folder className="h-3.5 w-3.5 shrink-0 text-primary/70" />
                    )}
                    <span className="truncate font-mono text-xs">{e.name}</span>
                  </>
                ) : (
                  <>
                    <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <span className="truncate font-mono text-xs">{e.name}</span>
                  </>
                )}
              </button>
              {/* 行内更多操作:移动端常驻,桌面端 hover 显示;触屏替代右键菜单 */}
              {hasMenu && (
                <button
                  onClick={(ev) => openMenu(ev, e, true)}
                  className="flex shrink-0 items-center justify-center rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground md:opacity-0 md:group-hover:opacity-100"
                  aria-label="更多操作"
                  title="更多操作"
                >
                  <MoreHorizontal className="size-3.5" />
                </button>
              )}
              </div>
              {isDir && expanded[e.path] && renderDir(e.path, depth + 1)}
            </div>
          );
        })}
        {entries.length === 0 && expanded[dir] && (
          <div
            className="py-1 text-xs text-muted-foreground/70"
            style={{ paddingLeft: 24 + depth * 14 }}
          >
            空目录
          </div>
        )}
      </div>
    );
  }

  return (
    <>
      <div className="p-1.5">{renderDir('', 0)}</div>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={contextMenuItems(menu.entry)}
          onClose={() => setMenu(null)}
        />
      )}
    </>
  );
}
