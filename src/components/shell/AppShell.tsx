import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect } from 'react';
import { connectLoop } from '../../lib/connection';
import { WorkspaceSidebar } from './WorkspaceSidebar';
import { SessionTabs } from './SessionTabs';
import { AgentPanel } from '../agent/AgentPanel';
import { useAgentStore } from '../../stores/agentStore';

const qc = new QueryClient();

export function AppShell() {
  useEffect(() => {
    void connectLoop();
  }, []);

  const workspaceId = useAgentStore((s) => s.activeWorkspaceId);
  const sessionId = useAgentStore((s) => s.activeSessionId);

  return (
    <QueryClientProvider client={qc}>
      <div className="flex h-screen w-screen overflow-hidden">
        <WorkspaceSidebar />
        <main className="flex flex-1 flex-col">
          <SessionTabs />
          {workspaceId && sessionId ? (
            <AgentPanel workspaceId={workspaceId} sessionId={sessionId} />
          ) : (
            <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
              {workspaceId ? '选择或新建一个会话' : '先添加/选择项目'}
            </div>
          )}
        </main>
      </div>
    </QueryClientProvider>
  );
}
