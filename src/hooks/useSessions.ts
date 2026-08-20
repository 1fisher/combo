import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createSession,
  deleteSession,
  getSessionHistory,
  listSessions,
  renameSession,
  setCurrentSession,
} from '../lib/api';
import { useAgentStore } from '../stores/agentStore';

/**
 * 模块级集合:记录最近创建的会话 ID。
 * useSessions 被多个组件同时调用(AgentPanel / ConversationList / WorkspaceSidebar),
 * 每个实例有自己的 lastCreated ref,无法互相感知。
 * 用共享集合确保任一实例创建的会话都不会被其他实例的 stale-guard 清除。
 */
const recentlyCreated = new Set<string>();
/** 标记后 5 秒内不被 stale-guard 清除(足够 sessions 列表 refetch 完成) */
export function markCreated(id: string) {
  recentlyCreated.add(id);
  setTimeout(() => recentlyCreated.delete(id), 5000);
}

/**
 * 最近刚在本端发起 run 的会话(时间戳)。
 * 会话列表的 is_busy 对账会跳过这几秒内的会话:发送后列表 refetch 可能
 * 抢在 serve 的 busy=true 广播前返回旧的 is_busy=false,过早把乐观标记的
 * running 收敛掉会造成输入坞闪烁解锁。
 */
const recentlyRan = new Map<string, number>();
const RECENT_RUN_WINDOW_MS = 5000;

/** 发送消息前调用:标记该会话刚刚发起 run(供对账逻辑跳过)。 */
export function markRunStarted(id: string) {
  recentlyRan.set(id, Date.now());
  setTimeout(() => recentlyRan.delete(id), RECENT_RUN_WINDOW_MS);
}

/** 该会话是否刚在本端发起 run(对账逻辑跳过,避免被旧的 is_busy=false 误收敛)。 */
export function isRecentlyRan(id: string): boolean {
  return Date.now() - (recentlyRan.get(id) ?? 0) < RECENT_RUN_WINDOW_MS;
}

/**
 * 会话列表 → 本地 run 状态对账(纯函数,便于测试):
 * 服务端 is_busy=false 而本地仍 running 的会话,说明 run 已在未订阅期间
 * 结束(如切换到其它项目),收敛为 done,解除输入坞封锁。
 */
export function reconcileRunsFromSessions(
  store: { bySession: Record<string, { run?: { status: string; runId: string } | null }> },
  markRun: (sessionId: string, runId: string, status: 'done') => void,
  sessions: { id: string; is_busy?: boolean }[]
) {
  for (const s of sessions) {
    if (s.is_busy !== false) continue;
    const rt = store.bySession[s.id];
    if (rt?.run?.status !== 'running') continue;
    if (isRecentlyRan(s.id)) continue;
    markRun(s.id, rt.run.runId, 'done');
  }
}

/**
 * 切回项目时挑选要直接打开的会话(纯函数,便于测试):
 * 有正在处理(is_busy)的会话 → 打开最近有活动的那个;否则不选中任何会话。
 */
export function pickAutoOpenSession(
  sessions: { id: string; is_busy?: boolean; created_at?: number; updated_at?: number }[],
  activeSessionId: string | null
): string | null {
  if (activeSessionId != null) return null;
  const busy = sessions.filter((s) => s.is_busy === true);
  if (busy.length === 0) return null;
  const toMs = (ts?: number) => (ts ? (ts > 1e12 ? ts : ts * 1000) : 0);
  // 多个在处理时取最近有活动的(无时间戳时保持列表顺序)
  let best = busy[0];
  let bestTs = Math.max(toMs(best.updated_at), toMs(best.created_at));
  for (const s of busy.slice(1)) {
    const ts = Math.max(toMs(s.updated_at), toMs(s.created_at));
    if (ts > bestTs) {
      best = s;
      bestTs = ts;
    }
  }
  return best.id;
}

/**
 * 「切回项目自动打开 busy 会话」的去重键存放在 agentStore.autoOpenDecidedKey
 * (内存态):每次项目切换(workspaceSwitchSeq)只决策一次,避免后台新起的
 * run(自动化等)打断用户正在进行的操作。
 */

export function useSessions(workspaceId: string | null) {
  const qc = useQueryClient();
  const setActiveSessionId = useAgentStore((s) => s.setActiveSessionId);
  const activeSessionId = useAgentStore((s) => s.activeSessionId);
  const q = useQuery({
    queryKey: ['sessions', workspaceId],
    queryFn: () => listSessions(workspaceId!),
    enabled: !!workspaceId,
  });
  const create = useMutation({
    mutationFn: (title: string) => createSession(workspaceId!, title),
    onSuccess: (s) => {
      markCreated(s.id);
      qc.invalidateQueries({ queryKey: ['sessions', workspaceId] });
    },
  });
  async function activate(sessionId: string) {
    setActiveSessionId(sessionId);
    if (workspaceId) {
      qc.invalidateQueries({ queryKey: ['history', workspaceId, sessionId] });
      try {
        await setCurrentSession(workspaceId, sessionId);
      } catch {
        /* 后端离线时不阻塞前端切换 */
      }
    }
  }
  const remove = useMutation({
    mutationFn: (sessionId: string) => deleteSession(workspaceId!, sessionId),
    onSuccess: (_data, deletedId) => {
      // 删除会话:未读角标与 busy 跟踪一并清理
      useAgentStore.getState().clearSessionRuntime(deletedId);
      qc.invalidateQueries({ queryKey: ['sessions', workspaceId] });
      if (activeSessionId === deletedId) {
        setActiveSessionId(null);
      }
    },
  });
  const rename = useMutation({
    mutationFn: (vars: { id: string; title: string }) =>
      renameSession(workspaceId!, vars.id, vars.title),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sessions', workspaceId] }),
  });
  // 持久化恢复的会话不属于当前项目(或已被删除)时清除,不主动选第一个。
  // 跳过最近创建的会话(列表 refetch 可能尚未完成)。
  useEffect(() => {
    if (!workspaceId || !q.data || activeSessionId == null) return;
    if (recentlyCreated.has(activeSessionId)) return;
    if (!q.data.some((s) => s.id === activeSessionId)) {
      setActiveSessionId(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, q.data, activeSessionId]);
  // 服务端 is_busy 对账:切回项目/列表刷新时收敛错过的 run 结束信号。
  useEffect(() => {
    if (!q.data) return;
    const st = useAgentStore.getState();
    reconcileRunsFromSessions(st, st.markRun, q.data);
    // 观察 busy 状态:run 在切走会话/项目期间结束(本地已无运行态)时,
    // 由 store 的 busy 集合检测「busy → 空闲」转变并标记未读。
    // 刚发起 run 的会话跳过(列表可能带回旧的 is_busy=false)。
    for (const s of q.data) {
      if (s.is_busy === true) st.observeSessionBusy(s.id, true);
      else if (s.is_busy === false && !isRecentlyRan(s.id)) st.observeSessionBusy(s.id, false);
    }
    // 播种各会话的累计 API 调用次数(rig turns 计数,后端 sqlite 持久)。
    // setApiCalls 取单调较大值,run 进行中列表 refetch 带回的旧基数
    // 不会覆盖实时 usage 事件已推送的新值。
    for (const s of q.data) {
      if (typeof s.api_calls === 'number') st.setApiCalls(s.id, s.api_calls);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q.data]);
  // 切回项目时:若有正在处理的会话则直接打开它,否则保持不选中
  // (切换项目时 activeSessionId 已清空)。每次项目切换只决策一次,
  // 且等列表拉取 settle(避免缓存的旧 is_busy 误判)。
  useEffect(() => {
    if (!workspaceId || !q.data || q.isFetching) return;
    const st = useAgentStore.getState();
    const key = `${workspaceId}#${st.workspaceSwitchSeq}`;
    if (st.autoOpenDecidedKey === key) return;
    useAgentStore.setState({ autoOpenDecidedKey: key });
    const target = pickAutoOpenSession(q.data, st.activeSessionId);
    if (target) {
      const ts = new Date().toISOString().slice(11, 23);
      console.debug(`[${ts}][sessions] 切回项目自动打开处理中的会话 session="${target}"`);
      void activate(target);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, q.data, q.isFetching]);
  return { sessions: q.data, isLoading: q.isLoading, create: create.mutateAsync, activate, remove: remove.mutateAsync, rename: rename.mutateAsync };
}

export function useSessionHistory(workspaceId: string | null, sessionId: string | null) {
  return useQuery({
    queryKey: ['history', workspaceId, sessionId],
    queryFn: () => getSessionHistory(workspaceId!, sessionId!),
    enabled: !!workspaceId && !!sessionId,
  });
}
