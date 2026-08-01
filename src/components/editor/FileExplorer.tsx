import { useEffect, useState } from 'react';
import { ChevronRight, FileText, Folder, FolderOpen } from 'lucide-react';
import { listFiles } from '../../lib/api';
import type { Api } from '../../lib/api/types';
import { cn } from '../../lib/utils';

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

  function renderDir(dir: string, depth: number) {
    const entries = byDir[dir] ?? [];
    return (
      <div key={dir}>
        {entries.map((e) => {
          const isDir = e.type === 'dir';
          return (
            <div key={e.path}>
              <button
                onClick={() => (isDir ? toggle(e.path) : onOpenFile(e.path, e.name))}
                className={cn(
                  'flex w-full items-center gap-1.5 rounded py-1 pr-2 text-left transition-colors hover:bg-accent',
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

  return <div className="p-1.5">{renderDir('', 0)}</div>;
}
