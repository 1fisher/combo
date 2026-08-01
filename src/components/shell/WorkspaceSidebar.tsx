import { useEffect, useState } from 'react';
import { ArrowLeft, FolderPlus } from 'lucide-react';
import { Button } from '../ui/button';
import { ScrollArea } from '../ui/scroll-area';
import { useWorkspaces } from '../../hooks/useWorkspaces';
import { useAgentStore } from '../../stores/agentStore';
import { useEditorStore } from '../../stores/editorStore';
import { getFileContent } from '../../lib/api';
import { isTauri } from '../../lib/connection';
import { FileExplorer } from '../editor/FileExplorer';
import { cn } from '../../lib/utils';

export function WorkspaceSidebar() {
  const { workspaces, isLoading, create } = useWorkspaces();
  const [picking, setPicking] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const active = useAgentStore((s) => s.activeWorkspaceId);
  const setActive = useAgentStore((s) => s.setActiveWorkspace);
  const activeWs = workspaces?.find((w) => w.id === active) ?? null;

  // 持久化恢复的 workspace 已不存在时自动清除
  useEffect(() => {
    if (workspaces && active && !workspaces.some((w) => w.id === active)) {
      setActive(null);
    }
  }, [workspaces, active, setActive]);

  async function onPickDirectory() {
    setFileError(null);
    if (!isTauri()) {
      setFileError('请在桌面版中选择项目目录');
      return;
    }
    setPicking(true);
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const dir = await open({ directory: true, multiple: false });
      if (typeof dir === 'string') {
        await create(dir);
      }
    } catch (e) {
      setFileError(e instanceof Error ? e.message : String(e));
    } finally {
      setPicking(false);
    }
  }

  async function onOpenFile(filePath: string, name: string) {
    if (!active) return;
    setFileError(null);
    try {
      const { content } = await getFileContent(active, filePath);
      useEditorStore.getState().openFile(filePath, name, content);
    } catch (e) {
      setFileError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <aside className="flex h-full w-[280px] flex-col border-r bg-muted/30">
      <div className="flex min-h-9 items-center gap-1 border-b px-2 py-1">
        {activeWs ? (
          <>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-1.5 text-xs"
              onClick={() => setActive(null)}
              title="返回项目列表"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
            </Button>
            <span className="truncate font-mono text-xs text-muted-foreground" title={activeWs.path}>
              {activeWs.path}
            </span>
          </>
        ) : (
          <span className="px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            项目
          </span>
        )}
      </div>
      <ScrollArea className="flex-1">
        {!activeWs ? (
          <>
            {isLoading && <div className="p-2 text-xs text-muted-foreground">加载中…</div>}
            {workspaces?.map((w) => (
              <button
                key={w.id}
                onClick={() => setActive(w.id)}
                className={cn(
                  'block w-full px-3 py-2 text-left text-sm transition-colors hover:bg-accent',
                  active === w.id && 'bg-accent text-accent-foreground'
                )}
              >
                <div className="truncate font-mono text-xs">{w.path}</div>
                <div className="truncate text-xs text-muted-foreground">{w.id}</div>
              </button>
            ))}
            {!isLoading && workspaces?.length === 0 && (
              <div className="p-3 text-xs leading-relaxed text-muted-foreground">
                还没有项目。点击「添加项目」选择项目目录,然后从文件树打开文件。
              </div>
            )}
          </>
        ) : (
          active && (
            <FileExplorer
              workspaceId={active}
              onOpenFile={onOpenFile}
              onError={setFileError}
            />
          )
        )}
      </ScrollArea>
      {!activeWs && (
        <div className="border-t p-2">
          <Button size="sm" className="w-full" onClick={onPickDirectory} disabled={picking}>
            <FolderPlus className="h-3.5 w-3.5" />
            {picking ? '选择中…' : '添加项目'}
          </Button>
        </div>
      )}
      {fileError && (
        <div className="border-t border-destructive/30 bg-destructive/10 px-3 py-1.5 text-xs text-destructive">
          {fileError}
        </div>
      )}
    </aside>
  );
}
