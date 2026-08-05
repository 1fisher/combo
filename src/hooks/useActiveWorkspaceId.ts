import { useEffect } from 'react';
import { useAgentStore } from '../stores/agentStore';
import { useWorkspaces } from './useWorkspaces';

/**
 * 返回经过 workspace 列表验证的 activeWorkspaceId。
 *
 * localStorage 恢复的 activeWorkspaceId 可能指向已被删除的项目
 * (crush 重启后 ID 变化等)。在 workspace 列表加载完成并确认其存在前,
 * 返回 null,避免子组件对失效 ID 发请求。
 *
 * 同时在检测到 stale ID 时自动清除持久化选中态。
 */
export function useActiveWorkspaceId(): string | null {
  const activeRaw = useAgentStore((s) => s.activeWorkspaceId);
  const setActiveWorkspace = useAgentStore((s) => s.setActiveWorkspace);
  const { workspaces } = useWorkspaces();

  const workspaceId =
    workspaces && activeRaw && workspaces.some((w) => w.id === activeRaw)
      ? activeRaw
      : null;

  useEffect(() => {
    if (workspaces && activeRaw && !workspaces.some((w) => w.id === activeRaw)) {
      setActiveWorkspace(null);
    }
  }, [workspaces, activeRaw, setActiveWorkspace]);

  return workspaceId;
}
