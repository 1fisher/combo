import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createWorkspace, listWorkspaces, renameWorkspace } from '../lib/api';

export function useWorkspaces() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['workspaces'],
    queryFn: listWorkspaces,
  });
  const create = useMutation({
    mutationFn: (vars: {
      path: string;
      backend?: 'crush' | 'opencode' | 'claude_code' | 'codex';
    }) => createWorkspace(vars.path, vars.backend),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['workspaces'] }),
  });
  const rename = useMutation({
    mutationFn: (vars: { id: string; name: string }) =>
      renameWorkspace(vars.id, vars.name),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['workspaces'] }),
  });
  return {
    workspaces: q.data,
    isLoading: q.isLoading,
    error: q.error,
    refresh: () => q.refetch(),
    create: create.mutateAsync,
    rename: rename.mutateAsync,
  };
}
