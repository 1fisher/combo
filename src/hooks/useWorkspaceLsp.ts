import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getWorkspaceLanguages } from '../lib/api';
import { useLspServers } from './useLsp';
import { computeLspIssues, type LspIssue } from '../lib/lspStatus';

/**
 * 当前 workspace 的 LSP 检测状态(会话界面横幅数据源):
 * - 语言统计:`GET /v1/workspaces/:id/languages`(只遍历文件名,60s 内视为
 *   新鲜,切换项目回来不重扫);
 * - server 列表:与 LSP 视图共用 `['lsp-servers']` 缓存(实时检测可执行状态,
 *   一键安装终态会 invalidate,横幅随之收敛)。
 *
 * loading 期间不展示横幅,避免布局抖动;后端离线时查询失败同样不展示。
 */
export function useWorkspaceLspStatus(workspaceId: string | null): {
  issues: LspIssue[];
  loading: boolean;
} {
  const langs = useQuery({
    queryKey: ['workspace-languages', workspaceId],
    queryFn: () => getWorkspaceLanguages(workspaceId!),
    enabled: !!workspaceId,
    staleTime: 60_000,
  });
  const servers = useLspServers();
  const issues = useMemo(
    () => computeLspIssues(langs.data?.languages ?? [], servers.data ?? []),
    [langs.data, servers.data],
  );
  return { issues, loading: langs.isPending || servers.isPending };
}
