import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect } from 'react';
import { connectLoop } from '../../lib/connection';
import { WorkspaceSidebar } from './WorkspaceSidebar';

const qc = new QueryClient();

export function AppShell() {
  useEffect(() => {
    void connectLoop();
  }, []);

  return (
    <QueryClientProvider client={qc}>
      <div className="flex h-screen w-screen overflow-hidden">
        <WorkspaceSidebar />
        <main className="flex-1">（Agent 面板将在这里）</main>
      </div>
    </QueryClientProvider>
  );
}
