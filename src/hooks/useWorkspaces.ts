import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Api } from '../lib/api/types';
import {
  changeWorkspacePath,
  createWorkspace,
  deleteWorkspace,
  listWorkspaces,
  renameWorkspace,
  reorderWorkspaces,
} from '../lib/api';

export function useWorkspaces() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['workspaces'],
    queryFn: listWorkspaces,
  });
  const create = useMutation({
    mutationFn: (vars: { path: string }) => createWorkspace(vars.path),
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
  // 拖动排序:先乐观更新缓存(拖拽即时生效),失败回滚,结束后以服务端为准
  const reorder = useMutation({
    mutationFn: (order: string[]) => reorderWorkspaces(order),
    onMutate: async (order) => {
      await qc.cancelQueries({ queryKey: ['workspaces'] });
      const prev = qc.getQueryData<Api.Workspace[]>(['workspaces']);
      if (prev) {
        const rank = (id: string) => {
          const i = order.indexOf(id);
          return i === -1 ? order.length : i;
        };
        qc.setQueryData(
          ['workspaces'],
          [...prev].sort((a, b) => rank(a.id) - rank(b.id))
        );
      }
      return { prev };
    },
    onError: (_e, _order, ctx) => {
      if (ctx?.prev) qc.setQueryData(['workspaces'], ctx.prev);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['workspaces'] }),
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
    reorder: reorder.mutateAsync,
  };
}
