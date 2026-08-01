import { Tabs, TabsList, TabsTrigger } from '../ui/tabs';
import { useSessions } from '../../hooks/useSessions';
import { useAgentStore } from '../../stores/agentStore';

export function SessionTabs() {
  const workspaceId = useAgentStore((s) => s.activeWorkspaceId);
  const active = useAgentStore((s) => s.activeSessionId);
  const { sessions, create, activate } = useSessions(workspaceId);

  if (!workspaceId) return null;

  async function onNew() {
    const base = `会话 ${(sessions?.length ?? 0) + 1}`;
    await create(base);
  }

  return (
    <Tabs
      value={active ?? undefined}
      onValueChange={(v) => activate(v)}
      className="border-b px-2 pt-2"
    >
      <TabsList>
        {sessions?.map((s) => (
          <TabsTrigger key={s.id} value={s.id}>
            {s.title}
          </TabsTrigger>
        ))}
        <button
          onClick={onNew}
          title="新建会话"
          className="ml-1 rounded px-2 text-sm hover:bg-accent"
        >
          ＋
        </button>
      </TabsList>
    </Tabs>
  );
}
