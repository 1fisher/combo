import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getCommitModel, setCommitModel } from '../lib/api';
import type { Api } from '../lib/api/types';

/**
 * 「git 提交全局模型」配置(服务端配置,持久化在 combo-cli.toml `[git]` 段)。
 * 开启后所有项目的 AI 生成提交信息统一用所选模型;关闭时用会话(workspace)模型。
 */
export function useCommitModel() {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: ['commit-model'],
    queryFn: () => getCommitModel(),
    staleTime: 30_000,
    retry: false,
  });
  const mutation = useMutation({
    mutationFn: (cfg: Api.CommitModelConfig) => setCommitModel(cfg),
    onSuccess: (data) => {
      qc.setQueryData(['commit-model'], data);
    },
  });
  return {
    /** 当前配置(加载中或失败时按关闭处理,与后端缺省一致)。 */
    config: query.data ?? { enabled: false, provider: null, model: null },
    isLoading: query.isLoading,
    /** 保存配置;provider/model 传 null/空串表示清除。 */
    save: (cfg: Api.CommitModelConfig) => mutation.mutate(cfg),
    isPending: mutation.isPending,
    error: mutation.error instanceof Error ? mutation.error.message : null,
  };
}
