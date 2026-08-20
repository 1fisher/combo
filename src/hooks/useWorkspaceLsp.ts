import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchAllLspDiagnostics, getWorkspaceLanguages } from '../lib/api';
import { useLspServers } from './useLsp';
import { computeLspIssues, computeLspReady, type LspIssue, type LspReady } from '../lib/lspStatus';

/**
 * 当前 workspace 的 LSP 检测状态(会话界面横幅数据源):
 * - 语言统计:`GET /v1/workspaces/:id/languages`(只遍历文件名,60s 内视为
 *   新鲜,切换项目回来不重扫);
 * - server 列表:与 LSP 视图共用 `['lsp-servers']` 缓存(实时检测可执行状态,
 *   一键安装终态会 invalidate,横幅随之收敛)。
 *
 * - `issues`:主要语言中 LSP 未就绪的部分(未配置 / 可执行缺失),警示横幅;
 * - `ready`:已就绪的部分(已配置且可执行),无问题时正向展示「语言服务已就绪」。
 *
 * loading 期间不展示横幅,避免布局抖动;后端离线时查询失败同样不展示。
 */
export function useWorkspaceLspStatus(workspaceId: string | null): {
  issues: LspIssue[];
  ready: LspReady[];
  loading: boolean;
} {
  const langs = useQuery({
    queryKey: ['workspace-languages', workspaceId],
    queryFn: () => getWorkspaceLanguages(workspaceId!),
    enabled: !!workspaceId,
    staleTime: 60_000,
  });
  const servers = useLspServers();
  const languages = langs.data?.languages ?? [];
  const serverList = servers.data ?? [];
  const issues = useMemo(
    () => computeLspIssues(languages, serverList),
    [languages, serverList],
  );
  const ready = useMemo(
    () => computeLspReady(languages, serverList),
    [languages, serverList],
  );
  return { issues, ready, loading: langs.isPending || servers.isPending };
}

/**
 * 跨文件聚合的实时 LSP 诊断(LSP 状态 tooltip 的错误列表数据源):
 * `GET /v1/workspaces/:id/lsp/diagnostics/all`——编辑器打开过的文件 +
 * server 顺带推送的相关文件,只含 error/warning。
 *
 * `rev` 为「当前编辑文件的诊断计数」(对象引用):保存/编辑导致计数变化时
 * queryKey 随之改变、自动重取,保证 tooltip 列表与编辑器波浪线同步;
 * 其余时间 10s 内直接用缓存。查询失败静默回退为空列表(后端离线不打扰)。
 */
export function useLspAllDiagnostics(
  workspaceId: string | null | undefined,
  rev?: { errors: number; warnings: number } | null,
) {
  return useQuery({
    queryKey: ['lsp-all-diagnostics', workspaceId, rev?.errors ?? 0, rev?.warnings ?? 0],
    queryFn: () => fetchAllLspDiagnostics(workspaceId!),
    enabled: !!workspaceId,
    staleTime: 10_000,
    retry: 1,
  });
}
