import { useState } from 'react';
import { useAgentStore } from '../../stores/agentStore';
import { sendAgentMessage } from '../../lib/api';
import { useWorkspaceEvents } from '../../hooks/useWorkspaceEvents';
import { MessageList } from './MessageList';
import { Composer } from './Composer';

export function AgentPanel({
  workspaceId,
  sessionId,
}: {
  workspaceId: string;
  sessionId: string;
}) {
  useWorkspaceEvents(workspaceId);
  const rt = useAgentStore((s) => (sessionId ? s.bySession[sessionId] : undefined));
  const setQueued = useAgentStore((s) => s.setQueued);
  const [postError, setPostError] = useState<string | null>(null);

  const running = rt?.run?.status === 'running';

  async function onSend(prompt: string) {
    setPostError(null);
    const runId = crypto.randomUUID();
    // 乐观插入用户消息
    const st = useAgentStore.getState();
    st.upsertMessage(sessionId, {
      id: `local-${runId}`,
      session_id: sessionId,
      role: 'user',
      parts: [{ type: 'text', data: { text: prompt } }],
      model: '',
      provider: '',
      created_at: Date.now(),
      updated_at: Date.now(),
    } as never);
    setQueued(sessionId, true);
    try {
      await sendAgentMessage(workspaceId, { sessionId, runId, prompt });
      st.markRun(sessionId, runId, 'running');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setPostError(msg);
      st.deleteMessage(sessionId, `local-${runId}`);
    } finally {
      setQueued(sessionId, false);
    }
  }

  return (
    <div className="flex h-full flex-col">
      <MessageList messages={rt?.messages ?? []} />
      {postError && (
        <div className="border-t border-destructive/30 bg-destructive/10 px-4 py-2 text-xs text-destructive">
          发送失败:{postError}
        </div>
      )}
      <Composer onSend={onSend} disabled={running} />
    </div>
  );
}
