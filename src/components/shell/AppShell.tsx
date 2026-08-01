import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect } from 'react';
import { connectLoop } from '../../lib/connection';
import { WorkspaceSidebar } from './WorkspaceSidebar';
import { SessionTabs } from './SessionTabs';
import { StatusBar } from './StatusBar';
import { AgentPanel } from '../agent/AgentPanel';
import { EditorPane } from '../editor/EditorPane';
import { ModalQueue } from '../agent/ModalQueue';
import { useAgentStore } from '../../stores/agentStore';
import { useEditorStore } from '../../stores/editorStore';

const qc = new QueryClient();

export function AppShell() {
  useEffect(() => {
    void connectLoop();
  }, []);

  const workspaceId = useAgentStore((s) => s.activeWorkspaceId);
  const sessionId = useAgentStore((s) => s.activeSessionId);
  const resetOpenFiles = useEditorStore((s) => s.resetOpenFiles);

  // 切换项目时清空编辑器里打开的文件
  useEffect(() => {
    resetOpenFiles();
  }, [workspaceId, resetOpenFiles]);

  return (
    <QueryClientProvider client={qc}>
      <div className="flex h-screen w-screen flex-col overflow-hidden">
        <div className="flex min-h-0 flex-1">
          <WorkspaceSidebar />
          <main className="flex min-w-0 flex-1 flex-col">
            <SessionTabs />
            {workspaceId && sessionId ? (
              <AgentPanel workspaceId={workspaceId} sessionId={sessionId} />
            ) : (
              <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
                {workspaceId ? '选择或新建一个会话' : '先添加/选择项目'}
              </div>
            )}
          </main>
          {workspaceId && <EditorPane workspaceId={workspaceId} />}
        </div>
        <StatusBar />
      </div>
      {workspaceId && <ModalQueue workspaceId={workspaceId} />}
    </QueryClientProvider>
  );
}
