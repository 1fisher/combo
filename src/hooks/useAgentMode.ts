import { useEffect } from 'react';
import { getPermissionSkip, setPermissionSkip } from '../lib/api';
import { useAgentStore } from '../stores/agentStore';

/**
 * 根据 crush workspace 的 yolo / permissions-skip 状态同步前端 agentMode。
 * 工作区切换时自动检测:若后端已 skip(等同 yolo),前端也保持 yolo;
 * 否则根据已有 agentMode 向后端写入对应的 skip 状态。
 */
export function useAgentMode(workspaceId: string | null) {
  const agentMode = useAgentStore((s) => s.agentMode);
  const setAgentMode = useAgentStore((s) => s.setAgentMode);

  // 工作区切换时从后端拉取 skip 状态,初始化前端模式
  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    (async () => {
      try {
        const { skip } = await getPermissionSkip(workspaceId);
        if (cancelled) return;
        // 后端 skip=true → yolo;否则保持当前模式
        if (skip && agentMode !== 'yolo') {
          setAgentMode('yolo');
        } else if (!skip && agentMode === 'yolo') {
          // 后端没 skip 但前端是 yolo,向前端写入 skip
          await setPermissionSkip(workspaceId, true).catch(() => {});
        }
      } catch {
        // 后端不支持 skip 端点时静默忽略,前端仍可自行 auto-approve
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  // agentMode 变化时同步后端 skip 状态
  useEffect(() => {
    if (!workspaceId) return;
    const shouldSkip = agentMode === 'yolo';
    setPermissionSkip(workspaceId, shouldSkip).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentMode, workspaceId]);
}
