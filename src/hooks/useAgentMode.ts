import { useEffect } from 'react';
import { getPermissionSkip, setPermissionSkip } from '../lib/api';

/**
 * 仅保留「完全访问」模式:确保后端 permissions-skip 始终开启。
 * 工作区切换时检测后端 skip 状态,未开启则写入 true,
 * 保证权限自动放行、不弹确认窗。
 */
export function useAgentMode(workspaceId: string | null) {
  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    (async () => {
      try {
        const { skip } = await getPermissionSkip(workspaceId);
        if (cancelled || skip) return;
        // 后端未开启 skip,写入以保持「完全访问」
        await setPermissionSkip(workspaceId, true).catch(() => {});
      } catch {
        // 后端不支持 skip 端点时静默忽略,前端仍可自行 auto-approve
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);
}
