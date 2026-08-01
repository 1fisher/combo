import { useAgentStore } from '../../stores/agentStore';
import { answerQuestion, grantPermission } from '../../lib/api';
import { PermissionDialog } from './PermissionDialog';
import { QuestionDialog } from './QuestionDialog';

export function ModalQueue({ workspaceId }: { workspaceId: string }) {
  const permissionQueue = useAgentStore((s) => s.permissionQueue);
  const questionQueue = useAgentStore((s) => s.questionQueue);
  const resolvePermission = useAgentStore((s) => s.resolvePermission);
  const dismissQuestion = useAgentStore((s) => s.dismissQuestionBatch);

  // 模态优先:先提问批次,后权限
  const activeQuestion = questionQueue[0];
  const activePermission = !activeQuestion ? permissionQueue[0] : undefined;

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
      {activePermission && (
        <PermissionDialog
          permission={activePermission}
          onResolve={async (action) => {
            await grantPermission(workspaceId, activePermission, action);
            resolvePermission(activePermission.tool_call_id);
          }}
        />
      )}
    </>
  );
}
