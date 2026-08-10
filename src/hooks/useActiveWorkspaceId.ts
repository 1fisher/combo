import { useEffect } from 'react';
import { useAgentStore } from '../stores/agentStore';
import { useWorkspaces } from './useWorkspaces';

/**
 * 返回经过 workspace 列表验证的 activeWorkspaceId。
 *
 * localStorage 恢复的 activeWorkspaceId 可能指向已被删除的项目
 * (后端重启后 ID 变化等)。在 workspace 列表加载完成并确认其存在前,
 * 返回 null,避免子组件对失效 ID 发请求。
 *
 * 恢复策略:
 * 1. ID 匹配 → 直接返回
 * 2. ID 失效但 lastWorkspacePath 能匹配到项目 → 自动切换到该项目
 * 3. 无选中项 → 自动选中第一个项目(如果有)
 */
export function useActiveWorkspaceId(): string | null {
  const activeRaw = useAgentStore((s) => s.activeWorkspaceId);
  const lastWorkspacePath = useAgentStore((s) => s.lastWorkspacePath);
  const setActiveWorkspace = useAgentStore((s) => s.setActiveWorkspace);
  const setLastWorkspacePath = useAgentStore((s) => s.setLastWorkspacePath);
  const { workspaces } = useWorkspaces();

  const workspaceId =
    workspaces && activeRaw && workspaces.some((w) => w.id === activeRaw)
      ? activeRaw
      : null;

  // 记录当前有效 workspace 的路径(后端重启后 ID 会变,用路径恢复)
  useEffect(() => {
    if (workspaceId && workspaces) {
      const ws = workspaces.find((w) => w.id === workspaceId);
      if (ws && ws.path !== lastWorkspacePath) {
        setLastWorkspacePath(ws.path);
      }
    }
  }, [workspaceId, workspaces, lastWorkspacePath, setLastWorkspacePath]);

  // ID 失效或无选中:尝试按路径恢复,否则自动选第一个项目
  useEffect(() => {
    if (!workspaces || workspaces.length === 0) return;
    const idValid = activeRaw && workspaces.some((w) => w.id === activeRaw);
    if (idValid) return;

    if (activeRaw) {
      // ID 失效(后端重启后 ID 变了):先清,再恢复
      setActiveWorkspace(null);
    }

    // 按 lastWorkspacePath 匹配,否则选第一个
    const match = lastWorkspacePath
      ? workspaces.find((w) => w.path === lastWorkspacePath)
      : null;
    setActiveWorkspace(match ? match.id : workspaces[0].id);
  }, [workspaces, activeRaw, lastWorkspacePath, setActiveWorkspace]);

  return workspaceId;
}
