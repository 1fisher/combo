import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getCommitAttribution, setCommitAttribution } from '../lib/api';

/**
 * 「git 提交署名」全局开关(服务端配置,持久化在 combo-cli.toml)。
 * query 读取当前值(失败时回落开启,与后端缺省一致);toggle 即时写入。
 */
export function useCommitAttribution() {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: ['commit-attribution'],
    queryFn: () => getCommitAttribution(),
    staleTime: 30_000,
    retry: false,
  });
  const mutation = useMutation({
    mutationFn: (enabled: boolean) => setCommitAttribution(enabled),
    onSuccess: (data) => {
      qc.setQueryData(['commit-attribution'], data);
    },
  });
  return {
    /** 当前开关(加载中或失败时按默认开启处理)。 */
    enabled: query.data?.enabled ?? true,
    isLoading: query.isLoading,
    toggle: (enabled: boolean) => mutation.mutate(enabled),
    isPending: mutation.isPending,
  };
}
