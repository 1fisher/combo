import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { FileEdit, Folder, Loader2 } from 'lucide-react';
import { randomUUID } from '../../lib/clientId';
import { useAgentStore } from '../../stores/agentStore';
import { cancelAgent, sendAgentMessage } from '../../lib/api';
import { useSessionHistory } from '../../hooks/useSessions';
import { useWorkspaceEvents } from '../../hooks/useWorkspaceEvents';
import { useAgentMode } from '../../hooks/useAgentMode';
import { useWorkspaces } from '../../hooks/useWorkspaces';
import { useSessions } from '../../hooks/useSessions';
import { MessageList } from './MessageList';
import { Composer } from './Composer';
import { ChatEmptyState } from './ChatEmptyState';
import { FileChangesPanel } from './FileChangesPanel';
import { extractFileToolCalls } from '../../lib/fileChanges';
import { cn } from '../../lib/utils';

const BACKEND_LABEL: Record<string, string> = {
  crush: 'Crush',
  opencode: 'OpenCode',
  claude_code: 'Claude Code',
  codex: 'Codex',
};

function basename(p: string): string {
  const clean = p.replace(/[\\/]+$/, '');
  const idx = Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\'));
  return idx >= 0 ? clean.slice(idx + 1) : clean;
}

export function AgentPanel({ workspaceId }: { workspaceId: string | null }) {
  useWorkspaceEvents(workspaceId);
  useAgentMode(workspaceId);
  const qc = useQueryClient();
  const sessionId = useAgentStore((s) => s.activeSessionId);
  const setActiveWorkspace = useAgentStore((s) => s.setActiveWorkspace);
  const { workspaces } = useWorkspaces();
  const { create: createSessionIn, activate: activateSession, remove: removeSession } = useSessions(workspaceId);

  const rt = useAgentStore((s) => (sessionId ? s.bySession[sessionId] : undefined));
  const hydrateMessages = useAgentStore((s) => s.hydrateMessages);
  const setQueued = useAgentStore((s) => s.setQueued);
  const [postError, setPostError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [wsMenuOpen, setWsMenuOpen] = useState(false);
  const [showChanges, setShowChanges] = useState(false);

  // 切换到某会话时,若 store 里没有该会话的消息,从后端拉取历史灌入
  const { data: history, isLoading: historyLoading } = useSessionHistory(workspaceId, sessionId);
  useEffect(() => {
    if (sessionId && history && history.length > 0) {
      hydrateMessages(sessionId, history);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, history]);

  const messages = rt?.messages ?? [];
  const running = rt?.run?.status === 'running' && messages.some((m) => m.streaming);
  // [stream-debug] 每次 render 的运行状态(仅在有会话时打日志)
  if (sessionId) {
    console.debug(
      `[${new Date().toISOString().slice(11, 23)}][agent] render run="${rt?.run?.status ?? 'none'}" running=${running} msgs=${messages.length} streaming=${messages.filter((m) => m.streaming).length}`
    );
  }
  const historyFetching = !!sessionId && messages.length === 0 && historyLoading;

  const changedFileCount = useMemo(() => {
    const calls = extractFileToolCalls(messages);
    return new Set(calls.map((c) => c.path)).size;
  }, [messages]);

  // 切换会话时关闭变更面板
  useEffect(() => {
    setShowChanges(false);
  }, [sessionId]);
  const ws = workspaces?.find((w) => w.id === workspaceId) ?? null;
  const wsName = ws ? (ws.name?.trim() ? ws.name : basename(ws.path)) : undefined;
  const backend = ws ? (BACKEND_LABEL[ws.backend ?? 'crush'] ?? ws.backend) : 'Crush';

  async function discardCreatedSession(sid: string | null) {
    if (!sid) return;
    const st = useAgentStore.getState();
    st.clearSessionRuntime(sid);
    if (st.activeSessionId === sid) {
      st.setActiveSessionId(null);
    }
    qc.invalidateQueries({ queryKey: ['sessions', workspaceId] });
    try {
      await removeSession(sid);
    } catch {
      /* rune 离线时删除可能失败,本地状态已清理 */
    }
  }

  async function doSend(prompt: string) {
    if (!workspaceId) {
      setPostError('请先在侧边栏添加/选择一个项目');
      return;
    }
    setPostError(null);
    setDraft('');
    let sid = sessionId;
    let reused = !!sid;
    // 本次发送新建的会话:发送失败时需删除,避免侧边栏残留空会话
    let createdSid: string | null = null;
    if (!sid) {
      // 首个消息:先创建会话,发送成功后才保留(失败时自动删除)
      try {
        const s = await createSessionIn(prompt.slice(0, 20) || '新任务');
        sid = s.id;
        createdSid = s.id;
      } catch (e) {
        setPostError(e instanceof Error ? e.message : String(e));
        return;
      }
    }
    const runId = randomUUID();
    const st = useAgentStore.getState();
    // 先插入用户消息,再激活会话 — 确保 React 渲染时消息已就绪,
    // 避免空会话视图(加载中/欢迎页)闪烁
    st.upsertMessage(sid!, {
      id: `local-${runId}`,
      session_id: sid!,
      role: 'user',
      parts: [{ type: 'text', data: { text: prompt } }],
      model: '',
      provider: '',
      created_at: Date.now(),
      updated_at: Date.now(),
    } as never);
    if (!reused) {
      void activateSession(sid!);
    }
    setQueued(sid!, true);
    try {
      await sendAgentMessage(workspaceId, { sessionId: sid!, runId, prompt });
      console.debug(`[agent] 发送成功 markRun running sid="${sid}" runId="${runId}"`);
      st.markRun(sid!, runId, 'running');
    } catch (e) {
      const err = e as { status?: number; message?: string };
      // crush 重启后会话丢失(404):若是复用的旧会话则自动重建后重试一次
      if (reused && err?.status === 404) {
        st.deleteMessage(sid!, `local-${runId}`);
        try {
          const s = await createSessionIn(prompt.slice(0, 20) || '新任务');
          sid = s.id;
          createdSid = s.id;
          const retryRunId = randomUUID();
          st.upsertMessage(sid, {
            id: `local-${retryRunId}`,
            session_id: sid,
            role: 'user',
            parts: [{ type: 'text', data: { text: prompt } }],
            model: '',
            provider: '',
            created_at: Date.now(),
            updated_at: Date.now(),
          } as never);
          void activateSession(sid);
          setQueued(sid, true);
          await sendAgentMessage(workspaceId, { sessionId: sid, runId: retryRunId, prompt });
          st.markRun(sid, retryRunId, 'running');
          return;
        } catch (e2) {
          await discardCreatedSession(createdSid);
          setPostError(e2 instanceof Error ? e2.message : String(e2));
          return;
        } finally {
          if (sid) setQueued(sid, false);
        }
      }
      const msg = e instanceof Error ? e.message : String(e);
      setPostError(msg);
      st.deleteMessage(sid!, `local-${runId}`);
      await discardCreatedSession(createdSid);
    } finally {
      setQueued(sid!, false);
    }
  }

  async function cancel() {
    if (!workspaceId || !sessionId) return;
    try {
      await cancelAgent(workspaceId, sessionId);
    } catch {
      /* 忽略取消失败 */
    }
  }

  return (
    <div className="relative flex h-full min-h-0 w-full flex-1 flex-col">
      {postError && (
        <div className="shrink-0 border-t border-destructive/30 bg-destructive/10 px-4 py-2 text-xs text-destructive">
          发送失败:{postError}
        </div>
      )}
      {/* 变更栏 */}
      {changedFileCount > 0 && !showChanges && (
        <button
          onClick={() => setShowChanges(true)}
          className="flex shrink-0 items-center gap-2 border-b border-border bg-surface/40 px-4 py-1.5 text-xs transition-colors hover:bg-surface-hover"
        >
          <FileEdit className="size-3.5 text-brand" />
          <span className="text-muted-foreground">{changedFileCount} 个文件已变更</span>
          <span className="ml-auto text-brand">审查变更</span>
        </button>
      )}
      {/* 时间线 / 变更面板 */}
      <div className={cn('min-h-0 flex-1', showChanges ? 'overflow-hidden' : 'overflow-y-auto')}>
        {showChanges && workspaceId ? (
          <FileChangesPanel
            messages={messages}
            workspaceId={workspaceId}
            onClose={() => setShowChanges(false)}
          />
        ) : historyFetching ? (
          <div className="flex h-full items-center justify-center">
            <div className="flex items-center gap-2 text-[13px] text-foreground-subtle">
              <Loader2 className="size-4 animate-spin" />
              加载会话…
            </div>
          </div>
        ) : messages.length === 0 ? (
          <ChatEmptyState
            onPickTemplate={(p) => {
              setDraft(p);
            }}
          />
        ) : (
          <MessageList messages={messages} workspaceId={workspaceId ?? undefined} />
        )}
      </div>
      {/* 输入区 */}
      <div className="relative z-20 w-full shrink-0">
        {wsMenuOpen && (
          <div className="absolute bottom-full left-1/2 z-30 mb-2 w-64 -translate-x-1/2 rounded-xl border border-border bg-popover p-1.5 shadow-xl">
            <div className="px-2 py-1 text-xs font-medium text-foreground-subtlest">选择项目</div>
            {workspaces?.map((w) => {
              const name = w.name?.trim() ? w.name : basename(w.path);
              return (
                <button
                  key={w.id}
                  type="button"
                  onClick={() => {
                    setActiveWorkspace(w.id);
                    setWsMenuOpen(false);
                    void qc.invalidateQueries({ queryKey: ['sessions', w.id] });
                  }}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] transition-colors hover:bg-surface-hover',
                    w.id === workspaceId && 'bg-surface-hover'
                  )}
                >
                  <Folder className="size-4 shrink-0 text-foreground-subtlest" />
                  <span className="min-w-0 flex-1 truncate">{name}</span>
                </button>
              );
            })}
            {!workspaces?.length && (
              <div className="px-2 py-1.5 text-[13px] text-foreground-subtle">
                还没有项目,请在侧边栏「项目」分区添加。
              </div>
            )}
          </div>
        )}
        <Composer
          workspaceName={wsName}
          backend={backend}
          value={draft}
          onChange={setDraft}
          onSend={() => void doSend(draft)}
          running={running}
          onStop={cancel}
          onPickWorkspace={() => setWsMenuOpen((o) => !o)}
        />
      </div>
    </div>
  );
}
