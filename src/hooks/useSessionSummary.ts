import { useQuery } from '@tanstack/react-query';
import { getSessionSummary } from '../lib/api';
import type { Api } from '../lib/api/types';

/** refetchInterval 选项:与 TanStack 的函数形式兼容(按汇总数据决定轮询间隔)。 */
export type SummaryRefetchInterval =
  | number
  | false
  | ((query: { state: { data?: Api.SessionSummary } }) => number | false);

/**
 * 项目级会话汇总(token/花费总和、busy 会话数、会话总数)。
 * query key 挂在 `['sessions', wsId, 'summary']`:凡是 invalidate
 * `['sessions', wsId]` 的地方(会话增删改、run 开始/结束的 SSE 等)
 * 都会按前缀连带刷新本汇总。
 * 任务列表分页加载后,项目徽章/费用栏不能再遍历已加载页求和
 * (会漏掉未加载页),改用本汇总拿到整项目准确口径。
 */
export function useSessionSummary(
  workspaceId: string | null,
  opts: { refetchInterval?: SummaryRefetchInterval } = {},
) {
  return useQuery({
    queryKey: ['sessions', workspaceId, 'summary'],
    queryFn: () => getSessionSummary(workspaceId!),
    enabled: !!workspaceId,
    refetchInterval: opts.refetchInterval,
  });
}
