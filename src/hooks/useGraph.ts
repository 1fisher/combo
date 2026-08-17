import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getWorkspaceGraph } from '../lib/api';

/**
 * 当前项目的知识图谱(文件依赖图)。图随代码变化,给 60s staleTime
 * 避免频繁全量扫描,并暴露手动刷新。
 */
export function useWorkspaceGraph(workspaceId: string | null) {
  const query = useQuery({
    queryKey: ['workspace-graph', workspaceId],
    queryFn: () => getWorkspaceGraph(workspaceId!),
    enabled: !!workspaceId,
    staleTime: 60_000,
  });
  const qc = useQueryClient();
  return {
    ...query,
    /** 手动重新扫描(失效缓存后重取)。 */
    refetchGraph: () =>
      qc.invalidateQueries({ queryKey: ['workspace-graph', workspaceId] }),
  };
}
