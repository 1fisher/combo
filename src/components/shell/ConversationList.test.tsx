import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ConversationList } from './ConversationList';
import { useAgentStore } from '../../stores/agentStore';

const sessions: { id: string; title: string; created_at: number }[] = [
  { id: 's1', title: '会话一', created_at: 1_700_000_000 },
  { id: 's2', title: '会话二', created_at: 1_700_000_100 },
];

vi.mock('../../lib/api', () => ({
  listSessions: vi.fn(async () => [...sessions]),
  createSession: vi.fn(async (_w: string, title: string) => {
    const s = {
      id: `s${sessions.length + 1}`,
      title,
      created_at: 1_700_000_200,
    };
    sessions.push(s);
    return s;
  }),
  renameSession: vi.fn(async (_w: string, sid: string, title: string) => {
    const s = sessions.find((x) => x.id === sid);
    if (s) s.title = title;
    return { ...s, id: sid, title };
  }),
  setCurrentSession: vi.fn(async () => {}),
  getSessionHistory: vi.fn(async () => []),
  listWorkspaces: vi.fn(async () => [
    { id: 'w1', path: '/tmp/w1', name: 'w1', backend: 'combo-cli' },
  ]),
}));

describe('ConversationList', () => {
  it('lists sessions and creates a new one', async () => {
    useAgentStore.setState({ activeWorkspaceId: 'w1', activeSessionId: null });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <ConversationList />
      </QueryClientProvider>
    );
    expect(await screen.findByText('会话一')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: /新建会话/ }));
    expect(await screen.findByText('会话 3')).toBeTruthy();
    expect(useAgentStore.getState().activeSessionId).toBe('s3');
  });

  it('renames a session via inline edit', async () => {
    useAgentStore.setState({ activeWorkspaceId: 'w1', activeSessionId: 's1' });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <ConversationList />
      </QueryClientProvider>
    );
    await screen.findByText('会话一');
    // 找到包含「会话一」的行,再点击其中的重命名按钮(排序后顺序不确定)
    const sessionOneRow = screen.getByText('会话一').closest('div')!;
    const renameBtn = within(sessionOneRow).getByTitle('重命名会话');
    await userEvent.click(renameBtn);
    const input = screen.getByDisplayValue('会话一');
    await userEvent.clear(input);
    await userEvent.type(input, '新名称{Enter}');
    expect(sessions[0].title).toBe('新名称');
  });
});
