import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WorkspaceSidebar } from './WorkspaceSidebar';

const workspaces: { id: string; path: string }[] = [
  { id: 'w1', path: '/proj/a' },
  { id: 'w2', path: '/proj/b' },
];

vi.mock('../../lib/api', () => ({
  listWorkspaces: vi.fn(async () => [...workspaces]),
  createWorkspace: vi.fn(async (path: string) => {
    const w = { id: `w${workspaces.length + 1}`, path };
    workspaces.push(w);
    return w;
  }),
}));

function wrap() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <WorkspaceSidebar />
    </QueryClientProvider>
  );
}

describe('WorkspaceSidebar', () => {
  it('renders workspaces from API', async () => {
    wrap();
    expect(await screen.findByText('/proj/a')).toBeTruthy();
    expect(screen.getByText('/proj/b')).toBeTruthy();
  });

  it('creates a workspace from path input', async () => {
    wrap();
    const input = await screen.findByPlaceholderText('输入项目路径');
    await userEvent.type(input, '/proj/c{Enter}');
    expect(await screen.findByText('/proj/c')).toBeTruthy();
  });
});
