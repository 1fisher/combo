import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  changeWorkspacePath,
  createWorkspace,
  deleteWorkspace,
  listWorkspaces,
  renameWorkspace,
} from '../lib/api';

export function useWorkspaces() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['workspaces'],
    queryFn: listWorkspaces,
  });
  const create = useMutation({
    mutationFn: (vars: {
      path: string;
      backend?: 'combo-cli' | 'crush' | 'opencode' | 'claude_code' | 'codex';
    }) => createWorkspace(vars.path, vars.backend),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['workspaces'] }),
  });
  const rename = useMutation({
    mutationFn: (vars: { id: string; name: string }) =>
      renameWorkspace(vars.id, vars.name),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['workspaces'] }),
  });
  const changePath = useMutation({
    mutationFn: (vars: { id: string; path: string }) =>
      changeWorkspacePath(vars.id, vars.path),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['workspaces'] }),
  });
  const remove = useMutation({
    mutationFn: (id: string) => deleteWorkspace(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['workspaces'] }),
  });
  return {
    workspaces: q.data,
    isLoading: q.isLoading,
    error: q.error,
    refresh: () => q.refetch(),
    create: create.mutateAsync,
    rename: rename.mutateAsync,
    changePath: changePath.mutateAsync,
    remove: remove.mutateAsync,
  };
}
