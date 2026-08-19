import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { FileEdit, Folder, Loader2, CircleAlert } from 'lucide-react';
import { randomUUID } from '../../lib/clientId';
import { useAgentStore } from '../../stores/agentStore';
import { formatContextPrompt, type ContextItem } from '../../stores/contextStore';
import { cancelAgent, sendAgentMessage, answerQuestion, clearSession } from '../../lib/api';
import type { Api } from '../../lib/api/types';
import type { SlashCommandDef } from '../../lib/slashCommands';
import { useSessionHistory } from '../../hooks/useSessions';
import { useWorkspaceEvents } from '../../hooks/useWorkspaceEvents';
import { useAgentMode } from '../../hooks/useAgentMode';
import { useWorkspaces } from '../../hooks/useWorkspaces';
import { useSessions, markRunStarted } from '../../hooks/useSessions';
import { MessageList } from './MessageList';
import { Composer } from './Composer';
import { RunningIndicator } from './RunningIndicator';
import { ComboOverlay, nextCombo, settleCombo } from './ComboOverlay';
import { ChatEmptyState } from './ChatEmptyState';
import { FileChangesPanel, type ChangeStatus } from './FileChangesPanel';
import { TodoList } from './TodoList';
import { SubAgentPanel } from './SubAgentPanel';
import { QuestionCard } from './QuestionCard';
import { extractFileToolCalls } from '../../lib/fileChanges';
import { autoTitleFor, titleFromPrompt } from './autoTitle';
import { ensureNotifyPermission } from '../../lib/notify';
import { cn } from '../../lib/utils';

function basename(p: string): string {
  const clean = p.replace(/[\\/]+$/, '');
  const idx = Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\'));
  return idx >= 0 ? clean.slice(idx + 1) : clean;
}

const EMPTY_TODOS: Api.TodoItem[] = [];
const EMPTY_SUBAGENTS: Api.SubAgentTask[] = [];

export function AgentPanel({ workspaceId }: { workspaceId: string | null }) {
  useWorkspaceEvents(workspaceId);
  useAgentMode(workspaceId);
  const qc = useQueryClient();
  const sessionId = useAgentStore((s) => s.activeSessionId);
  const setActiveWorkspace = useAgentStore((s) => s.setActiveWorkspace);
  const { workspaces } = useWorkspaces();
  const { sessions, create: createSessionIn, activate: activateSession, remove: removeSession, rename: renameSessionIn } = useSessions(workspaceId);

  const rt = useAgentStore((s) => (sessionId ? s.bySession[sessionId] : undefined));
  const todos = useAgentStore((s) => (sessionId ? s.todos[sessionId] : undefined) ?? EMPTY_TODOS);
  const subagents = useAgentStore(
    (s) => (sessionId ? s.subagents[sessionId] : undefined) ?? EMPTY_SUBAGENTS
  );
  const questionQueue = useAgentStore((s) => s.questionQueue);
  const dismissQuestionBatch = useAgentStore((s) => s.dismissQuestionBatch);
  const hydrateMessages = useAgentStore((s) => s.hydrateMessages);
  const setQueued = useAgentStore((s) => s.setQueued);
  const [postError, setPostError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [wsMenuOpen, setWsMenuOpen] = useState(false);
  const [showChanges, setShowChanges] = useState(false);
  const [changeStatuses, setChangeStatuses] = useState<Record<string, ChangeStatus>>({});
  // 连击(combo)计数:连续快速回复时累加,超时/切会话归零;
  // 流式期间每条内容更新也 +1(叠加,不封顶)。
  const [combo, setCombo] = useState(0);
  // 本轮发送时刻(pending 期间等待首 token);settledIds 记录已结算的 assistant 消息,
  // 防止快速连发时把「上一轮仍在流式的旧消息」误判为本轮回复
  const pendingRef = useRef<{ sid: string; sentAt: number } | null>(null);
  const settledIdsRef = useRef<Set<string>>(new Set());
  // 流式计数:assistant 流式消息每收到一次内容更新 +1;与上次更新间隔 ≥2s
  // 视为连击中断,先归零再 +1(从 ×1 重新开始)。parts 每次更新都是新引用;
  // 工具结果等新消息插入时,旧流式消息只是 streaming 翻 false,parts 引用不变,不会误计。
  const streamTicksRef = useRef<Map<string, { parts: Api.ContentPart[]; at: number }>>(new Map());

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

  // 每轮「发送 → 收到首个 assistant token」耗时 <2s → combo+1;超时归零
  useEffect(() => {
    const pending = pendingRef.current;
    if (!pending || pending.sid !== sessionId) return;
    const first = messages.find(
      (m) => m.role === 'assistant' && m.streaming && !settledIdsRef.current.has(m.id)
    );
    if (!first) return;
    settledIdsRef.current.add(first.id);
    const dt = Date.now() - pending.sentAt;
    setCombo((c) => settleCombo(c, dt));
  }, [messages, sessionId]);
  // 流式计数:assistant 流式消息每收到一次内容更新 +1;与上次更新间隔 ≥2s
  // 视为连击中断,先归零再 +1(从 ×1 重新开始)。
  useEffect(() => {
    const now = Date.now();
    for (const m of messages) {
      if (m.role !== 'assistant' || !m.streaming) continue;
      const prev = streamTicksRef.current.get(m.id);
      if (prev && prev.parts === m.parts) continue;
      streamTicksRef.current.set(m.id, { parts: m.parts, at: now });
      setCombo((c) => nextCombo(c, prev ? now - prev.at : null));
    }
  }, [messages, sessionId]);
  // [stream-debug] 每次 render 的运行状态(仅在有会话时打日志)
  if (sessionId) {
    console.debug(
      `[${new Date().toISOString().slice(11, 23)}][agent] render run="${rt?.run?.status ?? 'none'}" running=${running} msgs=${messages.length} streaming=${messages.filter((m) => m.streaming).length}`
    );
  }
  // 有会话但无消息时:
  // - 历史正在加载(historyLoading) → 显示 loading
  // - 历史已返回但 store 尚未 hydrate(useEffect 在渲染后才执行) → 也显示 loading
  // - 历史为空 → 显示空态
  const noMessages = !!sessionId && messages.length === 0;
  const waitingForHydrate = noMessages && !!history && history.length > 0;
  const historyFetching = noMessages && (historyLoading || waitingForHydrate);

  const changedFiles = useMemo(() => {
    const calls = extractFileToolCalls(messages);
    return new Set(calls.map((c) => c.path));
  }, [messages]);
  const pendingCount = useMemo(() => {
    let count = 0;
    for (const p of changedFiles) {
      if (changeStatuses[p] !== 'approved' && changeStatuses[p] !== 'rejected') count++;
    }
    return count;
  }, [changedFiles, changeStatuses]);

  // 切换会话时关闭变更面板并重置审查状态;连击计数归零
  useEffect(() => {
    setShowChanges(false);
    setChangeStatuses({});
    setCombo(0);
    pendingRef.current = null;
    settledIdsRef.current.clear();
    streamTicksRef.current.clear();
  }, [sessionId]);

  // 所有变更都已处理(批准/撤销)时，自动关闭审查视图
  useEffect(() => {
    if (showChanges && changedFiles.size > 0 && pendingCount === 0) {
      setShowChanges(false);
    }
  }, [showChanges, pendingCount, changedFiles]);
  const ws = workspaces?.find((w) => w.id === workspaceId) ?? null;
  const wsName = ws ? (ws.name?.trim() ? ws.name : basename(ws.path)) : undefined;

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
      /* 后端离线时删除可能失败,本地状态已清理 */
    }
  }

  /**
   * 复用「新建任务」创建的占位会话(标题为「会话 N」/「新任务」)发送消息时,
   * 自动把左侧任务名更新为首条需求内容(与直接输入发送创建会话时的命名一致)。
   * 用户手动重命名过的会话不会被覆盖。
   */
  async function autoTitleFromPrompt(sid: string, prompt: string) {
    const cur = sessions?.find((s) => s.id === sid);
    const title = autoTitleFor(prompt, cur?.title);
    if (!title) return;
    try {
      await renameSessionIn({ id: sid, title });
    } catch {
      /* 重命名失败不阻塞主流程,下次发送仍会尝试 */
    }
  }

  async function doSend(
    prompt: string,
    attachments: Api.Attachment[] = [],
    contextItems: ContextItem[] = [],
  ) {
    const fullPrompt = formatContextPrompt(prompt, contextItems);
    if (!workspaceId) {
      setPostError('发送失败:请先在侧边栏添加/选择一个项目');
      return;
    }
    setPostError(null);
    setDraft('');
    const sendPrompt = fullPrompt;
    let sid = sessionId;
    let reused = !!sid;
    // 本次发送新建的会话:发送失败时需删除,避免侧边栏残留空会话
    let createdSid: string | null = null;
    if (!sid) {
      // 首个消息:先创建会话,发送成功后才保留(失败时自动删除)
      try {
        const s = await createSessionIn(titleFromPrompt(sendPrompt));
        sid = s.id;
        createdSid = s.id;
      } catch (e) {
        setPostError(`发送失败:${e instanceof Error ? e.message : String(e)}`);
        return;
      }
    }
    const runId = randomUUID();
    const st = useAgentStore.getState();
    // 上一轮任务已全部完成(run 已结束)时,把 todo 清单归档进消息流,
    // 让「任务进度」从输入坞上方移入对话历史,不再一直占用输入区位置。
    // 时机:用户再次输入提示词发送 → 归档为消息流中的一张任务卡片。
    const curRun = st.bySession[sid!]?.run;
    const curTodos = st.todos[sid!];
    if (
      curTodos &&
      curTodos.length > 0 &&
      curTodos.every((t) => t.status === 'completed') &&
      curRun?.status === 'done'
    ) {
      st.insertTodoCard(sid!, runId, curTodos);
      st.clearTodos(sid!);
    }
    // 先插入用户消息,再激活会话 — 确保 React 渲染时消息已就绪,
    // 避免空会话视图(加载中/欢迎页)闪烁
    st.upsertMessage(sid!, {
      id: `local-${runId}`,
      session_id: sid!,
      role: 'user',
      parts: [{ type: 'text', data: { text: sendPrompt } }],
      model: '',
      provider: '',
      created_at: Date.now(),
      updated_at: Date.now(),
    } as never);
    if (!reused) {
      void activateSession(sid!);
    }
    setQueued(sid!, true);
    // 首次发送即请求通知权限:浏览器只允许在用户手势内弹权限框,
    // 点击「发送」正是一次手势;权限已 granted/denied 时幂等不弹。
    void ensureNotifyPermission();
    // 先标记 running 再发 POST:SSE 事件可能在 POST 响应之前到达
    // (agent 秒回/报错立即 finish),若此时 run 还不是 running,
    // finish/run_complete 的 wasRunning 判断会漏掉任务结束通知。
    markRunStarted(sid!);
    st.markRun(sid!, runId, 'running');
    try {
      await sendAgentMessage(workspaceId, { sessionId: sid!, runId, prompt: sendPrompt, attachments });
      console.debug(`[agent] 发送成功 run running sid="${sid}" runId="${runId}"`);
      // 记录本轮发送时刻,用于连击(combo)判定
      pendingRef.current = { sid: sid!, sentAt: Date.now() };
      // 复用「新建任务」创建的占位会话时,自动更新任务名为本次需求
      void autoTitleFromPrompt(sid!, sendPrompt);
    } catch (e) {
      const err = e as { status?: number; message?: string };
      // 后端重启后会话丢失(404):若是复用的旧会话则自动重建后重试一次
      if (reused && err?.status === 404) {
        st.deleteMessage(sid!, `local-${runId}`);
        // 旧会话已失效:收尾其 run,避免停留在 running
        st.markRun(sid!, runId, 'done', '会话已在后端重建');
        try {
          const s = await createSessionIn(titleFromPrompt(sendPrompt));
          sid = s.id;
          createdSid = s.id;
          const retryRunId = randomUUID();
          st.upsertMessage(sid, {
            id: `local-${retryRunId}`,
            session_id: sid,
            role: 'user',
            parts: [{ type: 'text', data: { text: sendPrompt } }],
            model: '',
            provider: '',
            created_at: Date.now(),
            updated_at: Date.now(),
          } as never);
          void activateSession(sid);
          setQueued(sid, true);
          markRunStarted(sid);
          st.markRun(sid, retryRunId, 'running');
          await sendAgentMessage(workspaceId, { sessionId: sid, runId: retryRunId, prompt: sendPrompt, attachments });
          pendingRef.current = { sid, sentAt: Date.now() };
          return;
        } catch (e2) {
          st.markRun(sid, randomUUID(), 'done', e2 instanceof Error ? e2.message : String(e2));
          await discardCreatedSession(createdSid);
          setPostError(`发送失败:${e2 instanceof Error ? e2.message : String(e2)}`);
          return;
        } finally {
          if (sid) setQueued(sid, false);
        }
      }
      const msg = e instanceof Error ? e.message : String(e);
      // POST 失败:回滚提前标记的 running,避免 run 悬挂
      st.markRun(sid!, runId, 'done', msg);
      setPostError(`发送失败:${msg}`);
      st.deleteMessage(sid!, `local-${runId}`);
      await discardCreatedSession(createdSid);
    } finally {
      setQueued(sid!, false);
    }
  }

  /**
   * 斜杠命令处理(Composer 发送拦截转发,见 lib/slashCommands):
   * - prompt 类:展开为固定提示词,复用 doSend 走正常发送流程(自动建会话/命名);
   * - `/new`:新建会话并切换(与侧边栏「新建任务」同路径);
   * - `/clear`:调后端清空消息 + 重置上下文计数,本地清内存并刷新列表。
   */
  async function handleCommand(command: SlashCommandDef, args: string) {
    setDraft('');
    setPostError(null);
    if (command.kind === 'prompt' && command.prompt) {
      await doSend(command.prompt(args));
      return;
    }
    if (command.id === 'new') {
      if (!workspaceId) {
        setPostError('请先在侧边栏添加/选择一个项目');
        return;
      }
      try {
        const s = await createSessionIn(`会话 ${(sessions?.length ?? 0) + 1}`);
        void activateSession(s.id);
      } catch (e) {
        setPostError(e instanceof Error ? e.message : String(e));
      }
      return;
    }
    if (command.id === 'clear') {
      if (!workspaceId || !sessionId) {
        setPostError('当前没有可清空的会话');
        return;
      }
      try {
        await clearSession(workspaceId, sessionId);
        const st = useAgentStore.getState();
        st.clearSessionRuntime(sessionId);
        st.resetApiCalls(sessionId);
        st.clearSubAgents(sessionId);
        qc.invalidateQueries({ queryKey: ['sessions', workspaceId] });
        qc.invalidateQueries({ queryKey: ['history', workspaceId, sessionId] });
      } catch (e) {
        setPostError(e instanceof Error ? e.message : String(e));
      }
      return;
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
    <div className="relative flex flex-col flex-1 w-full h-full min-h-0">
      {postError && (
        <div className="bg-destructive/10 px-4 py-2 border-destructive/30 border-t text-destructive text-xs shrink-0">
          {postError}
        </div>
      )}
      {/* 时间线 / 变更面板 */}
      <div className={cn('flex-1 min-h-0', showChanges ? 'overflow-hidden' : 'overflow-y-auto')}>
        {showChanges && workspaceId ? (
          <FileChangesPanel
            messages={messages}
            workspaceId={workspaceId}
            onClose={() => setShowChanges(false)}
            statuses={changeStatuses}
            onStatusesChange={setChangeStatuses}
          />
        ) : historyFetching ? (
          <div className="flex justify-center items-center h-full">
            <div className="flex items-center gap-2 text-[13px] text-foreground-subtle">
              <Loader2 className="size-4 animate-spin" />
              加载会话…
            </div>
          </div>
        ) : messages.length === 0 ? (
          <ChatEmptyState
            hasSession={!!sessionId}
            onPickTemplate={(p) => {
              setDraft(p);
            }}
          />
        ) : (
          <MessageList messages={messages} workspaceId={workspaceId ?? undefined} />
        )}
      </div>
      {/* 连击特效层(会话区中央,拳皇连招风) */}
      <ComboOverlay combo={combo} />
      {/* 输入区 */}
      <div className="z-20 relative w-full shrink-0">
        {rt?.run?.status === 'done' && rt?.run?.error && (
          <div className="flex items-start gap-2 bg-destructive/10 mx-4 mb-2 px-3 py-2 border border-destructive/30 rounded-xl text-destructive text-xs">
            <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
            <div className="min-w-0 break-all whitespace-pre-wrap">
              运行失败:{rt.run.error}
            </div>
          </div>
        )}
        {wsMenuOpen && (
          <div className="bottom-full left-1/2 z-30 absolute bg-popover shadow-xl mb-2 p-1.5 border border-border rounded-xl w-64 -translate-x-1/2">
            <div className="px-2 py-1 font-medium text-foreground-subtlest text-xs">选择项目</div>
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
                    'flex items-center gap-2 hover:bg-surface-hover px-2 py-1.5 rounded-lg w-full text-[13px] text-left transition-colors',
                    w.id === workspaceId && 'bg-surface-hover'
                  )}
                >
                  <Folder className="size-4 text-foreground-subtlest shrink-0" />
                  <span className="flex-1 min-w-0 truncate">{name}</span>
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
        {/* 问题卡片(question 工具):非模态,优先于任务列表显示在输入坞上方 */}
        {questionQueue[0] && workspaceId && (
          <QuestionCard
            batch={questionQueue[0]}
            onResolve={async (answer) => {
              await answerQuestion(workspaceId, answer);
              dismissQuestionBatch(questionQueue[0].id);
            }}
          />
        )}
        {/* 任务列表 */}
        {sessionId && todos.length > 0 && <TodoList todos={todos} />}
        {/* 子 agent 进度(multi-agent:agent 工具派发的子任务) */}
        {sessionId && subagents.length > 0 && <SubAgentPanel tasks={subagents} />}
        {/* 变更栏 */}
        {pendingCount > 0 && !showChanges && (
          <button
            onClick={() => setShowChanges(true)}
            className="flex items-center gap-2 bg-surface/40 hover:bg-surface-hover mx-4 mb-2 px-3 py-1.5 border border-border rounded-xl text-xs transition-colors"
          >
            <FileEdit className="size-3.5 text-brand" />
            <span className="text-muted-foreground">{pendingCount} 个文件待审查</span>
            <span className="ml-auto text-brand">审查变更</span>
          </button>
        )}
        <Composer
          workspaceName={wsName}
          workspaceId={workspaceId ?? undefined}
          value={draft}
          onChange={setDraft}
          onSend={(attachments, contextItems) => void doSend(draft, attachments, contextItems)}
          onCommand={(command, args) => void handleCommand(command, args)}
          running={running}
          onStop={cancel}
          banner={
            rt?.run?.status === 'running' ? (
              <RunningIndicator startedAt={rt.run.startedAt} />
            ) : undefined
          }
        />
      </div>
    </div>
  );
}
