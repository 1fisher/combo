import { useEffect, useRef } from 'react';
import {
  useAgentStore,
  WRITE_TOOL_NAMES,
  type AgentMode,
} from '../../stores/agentStore';
import { answerQuestion, grantPermission } from '../../lib/api';
import { PermissionDialog } from './PermissionDialog';
import { QuestionDialog } from './QuestionDialog';

/**
 * 根据 agentMode 判断该权限请求是否应自动放行(不弹窗)。
 * - yolo:全部自动放行
 * - edit:写操作类工具自动放行
 * - build / plan:不自动放行(build 弹窗确认,plan 不应出现写请求)
 */
function shouldAutoApprove(mode: AgentMode, toolName: string): boolean {
  if (mode === 'yolo') return true;
  if (mode === 'edit') return WRITE_TOOL_NAMES.has(toolName);
  return false;
}

export function ModalQueue({ workspaceId }: { workspaceId: string }) {
  const permissionQueue = useAgentStore((s) => s.permissionQueue);
  const questionQueue = useAgentStore((s) => s.questionQueue);
  const agentMode = useAgentStore((s) => s.agentMode);
  const resolvePermission = useAgentStore((s) => s.resolvePermission);
  const dismissQuestion = useAgentStore((s) => s.dismissQuestionBatch);

  // 记录已处理的 tool_call_id,避免重复 auto-approve
  const processed = useRef<Set<string>>(new Set());

  const activeQuestion = questionQueue[0];
  const activePermission = !activeQuestion ? permissionQueue[0] : undefined;

  // 自动放行:yolo / edit 模式下,权限请求到达后立即 grant 而不弹窗
  useEffect(() => {
    if (!workspaceId || permissionQueue.length === 0) return;
    const st = useAgentStore.getState();
    for (const p of st.permissionQueue) {
      if (processed.current.has(p.tool_call_id)) continue;
      if (shouldAutoApprove(agentMode, p.tool_name)) {
        processed.current.add(p.tool_call_id);
        void grantPermission(workspaceId, p, 'allow')
          .then(() => st.resolvePermission(p.tool_call_id))
          .catch(() => processed.current.delete(p.tool_call_id));
      }
    }
  }, [workspaceId, permissionQueue, agentMode]);

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
      {activeQuestion && (
        <QuestionDialog
          batch={activeQuestion}
          onResolve={async (answer) => {
            await answerQuestion(workspaceId, answer);
            dismissQuestion(activeQuestion.id);
          }}
        />
      )}
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
