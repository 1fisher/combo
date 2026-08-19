import { useEffect, useRef } from 'react';
import { useAgentStore } from '../../stores/agentStore';
import { grantPermission } from '../../lib/api';
import { PermissionDialog } from './PermissionDialog';

/**
 * 权限请求队列(question 工具已改为非模态卡片,在输入坞上方由
 * AgentPanel 渲染 QuestionCard,不再占用此处模态弹窗)。
 */
export function ModalQueue({ workspaceId }: { workspaceId: string }) {
  const permissionQueue = useAgentStore((s) => s.permissionQueue);
  const resolvePermission = useAgentStore((s) => s.resolvePermission);

  // 记录已处理的 tool_call_id,避免重复 auto-approve
  const processed = useRef<Set<string>>(new Set());

  const activePermission = permissionQueue[0];

  // 自动放行:仅保留「完全访问」模式,权限请求到达后立即 grant 而不弹窗
  useEffect(() => {
    if (!workspaceId || permissionQueue.length === 0) return;
    const st = useAgentStore.getState();
    for (const p of st.permissionQueue) {
      if (processed.current.has(p.tool_call_id)) continue;
      processed.current.add(p.tool_call_id);
      void grantPermission(workspaceId, p, 'allow')
        .then(() => st.resolvePermission(p.tool_call_id))
        .catch(() => processed.current.delete(p.tool_call_id));
    }
  }, [workspaceId, permissionQueue]);

  // 清理已不在队列中的 processed 记录,防止 Set 无限增长
  useEffect(() => {
    const ids = new Set(permissionQueue.map((p) => p.tool_call_id));
    for (const id of [...processed.current]) {
      if (!ids.has(id)) processed.current.delete(id);
    }
  }, [permissionQueue]);

  // 经过 auto-approve 后,如果队列头部已被处理则不渲染
  const renderPermission =
    activePermission && !processed.current.has(activePermission.tool_call_id);

  return (
    <>
      {renderPermission && (
        <PermissionDialog
          permission={activePermission}
          onResolve={async (action) => {
            processed.current.add(activePermission.tool_call_id);
            await grantPermission(workspaceId, activePermission, action);
            resolvePermission(activePermission.tool_call_id);
          }}
        />
      )}
    </>
  );
}
