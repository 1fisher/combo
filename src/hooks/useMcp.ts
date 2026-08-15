import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { listMcpServers, removeMcpServer, upsertMcpServer } from '../lib/api';

export function useMcpServers() {
  return useQuery({
    queryKey: ['mcp-servers'],
    queryFn: () => listMcpServers(),
  });
}

/** MCP server 的增删操作,成功后自动刷新列表。 */
export function useMcpActions() {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: ['mcp-servers'] });

  const upsert = useMutation({
    mutationFn: upsertMcpServer,
    onSuccess: invalidate,
  });

  const remove = useMutation({
    mutationFn: removeMcpServer,
    onSuccess: invalidate,
  });

  return {
    upsert: upsert.mutateAsync,
    upserting: upsert.isPending,
    remove: remove.mutateAsync,
    removing: remove.isPending,
  };
}
