import { useState } from 'react';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { ScrollArea } from '../ui/scroll-area';
import { useWorkspaces } from '../../hooks/useWorkspaces';
import { useAgentStore } from '../../stores/agentStore';
import { cn } from '../../lib/utils';

export function WorkspaceSidebar() {
  const { workspaces, isLoading, create } = useWorkspaces();
  const [path, setPath] = useState('');
  const active = useAgentStore((s) => s.activeWorkspaceId);
  const setActive = useAgentStore((s) => s.setActiveWorkspace);

  async function onCreate() {
    if (!path.trim()) return;
    await create(path.trim());
    setPath('');
  }

  return (
    <aside className="flex h-full w-60 flex-col border-r bg-muted/30">
      <div className="p-2 text-xs font-semibold uppercase text-muted-foreground">
        项目
      </div>
      <ScrollArea className="flex-1">
        {isLoading && <div className="p-2 text-xs text-muted-foreground">加载中…</div>}
        {workspaces?.map((w) => (
          <button
            key={w.id}
            onClick={() => setActive(w.id)}
            className={cn(
              'block w-full px-3 py-2 text-left text-sm hover:bg-accent',
              active === w.id && 'bg-accent text-accent-foreground'
            )}
          >
            <div className="truncate font-mono text-xs">{w.path}</div>
            <div className="truncate text-xs text-muted-foreground">{w.id}</div>
          </button>
        ))}
      </ScrollArea>
      <div className="border-t p-2">
        <Input
          placeholder="输入项目路径"
          value={path}
          onChange={(e) => setPath(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && onCreate()}
          className="mb-2 h-7 text-xs"
        />
        <Button size="sm" className="w-full" onClick={onCreate} disabled={!path.trim()}>
          添加项目
        </Button>
      </div>
    </aside>
  );
}
