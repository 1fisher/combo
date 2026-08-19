import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { listLspServers, removeLspServer, upsertLspServer } from '../lib/api';

export function useLspServers() {
  return useQuery({
    queryKey: ['lsp-servers'],
    queryFn: () => listLspServers(),
  });
}

/** LSP server 的增删操作,成功后自动刷新列表。 */
export function useLspActions() {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: ['lsp-servers'] });

  const upsert = useMutation({
    mutationFn: upsertLspServer,
    onSuccess: invalidate,
  });

  const remove = useMutation({
    mutationFn: removeLspServer,
    onSuccess: invalidate,
  });

  return {
    upsert: upsert.mutateAsync,
    upserting: upsert.isPending,
    remove: remove.mutateAsync,
    removing: remove.isPending,
  };
}
