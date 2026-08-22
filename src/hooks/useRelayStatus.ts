import { useQuery } from '@tanstack/react-query';
import { getRelayStatus } from '../lib/api';

/**
 * 移动端远程访问状态(桌面端 → combo-relay 隧道)。
 *
 * 轮询 `/v1/relay/status`:用户开启过「移动端远程控制」后,隧道配置持久化
 * 在 sqlite,serve 重启会自动恢复,手机端可随时访问。侧边栏据此在移动端
 * 按钮上显示「已开启」状态点;隧道连接失败/令牌失效时自动熄灭。
 *
 * 复用场景:
 * - MobileConnectDialog 打开时一次性调用 `getRelayStatus` 复用现有令牌,
 *   不依赖本 hook(避免对话框与侧边栏两套轮询)。
 */
export function useRelayStatus() {
  return useQuery({
    queryKey: ['relay-status'],
    queryFn: () => getRelayStatus(),
    // 30s 轮询 + 页面恢复可见立即刷新,保持状态点实时
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
    staleTime: 10_000,
  });
}
