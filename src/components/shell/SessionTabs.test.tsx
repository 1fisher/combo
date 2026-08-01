import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SessionTabs } from './SessionTabs';
import { useAgentStore } from '../../stores/agentStore';

const sessions: { id: string; title: string }[] = [
  { id: 's1', title: '会话一' },
  { id: 's2', title: '会话二' },
];

vi.mock('../../lib/api', () => ({
  listSessions: vi.fn(async () => [...sessions]),
  createSession: vi.fn(async (_w: string, title: string) => {
    const s = { id: `s${sessions.length + 1}`, title };
    sessions.push(s);
    return s;
  }),
  setCurrentSession: vi.fn(async () => {}),
  getSessionHistory: vi.fn(async () => []),
}));

describe('SessionTabs', () => {
  it('lists sessions and creates a new one', async () => {
    useAgentStore.setState({ activeWorkspaceId: 'w1', activeSessionId: null });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <SessionTabs />
      </QueryClientProvider>
    );
    expect(await screen.findByText('会话一')).toBeTruthy();
    await userEvent.click(screen.getByText('＋'));
    expect(await screen.findByText('会话 3')).toBeTruthy();
    expect(useAgentStore.getState().activeSessionId).toBe('s3');
  });
});
