import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Api } from '../lib/api/types';

/** 统一归一化秒/毫秒时间戳为毫秒。 */
function toMs(ts: number): number {
  return ts > 1e12 ? ts : ts * 1000;
}

export interface MessageVM {
  id: string;
  role: 'user' | 'assistant' | 'tool' | 'system';
  parts: Api.ContentPart[];
  createdAt: number;
  updatedAt: number;
  streaming: boolean;
  /** 已全部完成的任务清单(上一轮 todo_write 的结果),归档为消息流中的一张任务卡片 */
  todoItems?: Api.TodoItem[];
}

export interface SessionRuntime {
  messages: MessageVM[];
  /** startedAt:run 进入 running 的时刻(执行耗时展示);done 后保留原值 */
  run: {
    runId: string;
    status: 'running' | 'done';
    error?: string;
    startedAt?: number;
  } | null;
  queued: boolean;
  /** provider 流被截断自动重试的提示(retry_notice SSE 事件写入,run 期间展示) */
  retryNotice?: string;
}

/** 用户选中的模型(workspaceId → { model, provider }),持久化到 localStorage */
export interface ModelSelection {
  model: string;
  provider: string;
  /** 推理强度: nothink / high / max */
  reasoningEffort?: string;
}

/** 最近使用过的模型(全局共享,provider+model 唯一),用于模型菜单顶部快速切换 */
export interface RecentModel {
  model: string;
  provider: string;
}

/** 最近使用模型最多保留条数 */
export const RECENT_MODELS_MAX = 6;

interface AgentState {
  activeWorkspaceId: string | null;
  /** 上次选中项目的路径(后端重启后 ID 可能变化,用路径做恢复) */
  lastWorkspacePath: string | null;
  setActiveWorkspace: (id: string | null) => void;
  setLastWorkspacePath: (path: string | null) => void;
  activeSessionId: string | null;
  setActiveSessionId: (id: string | null) => void;
  /**
   * 项目切换计数:每次 setActiveWorkspace 变化 +1(内存态,不持久化)。
   * 供「切回项目时若有正在处理的会话则直接打开」按次一次性决策,
   * 区分「同一项目列表刷新」与「切走再切回」。
   */
  workspaceSwitchSeq: number;
  /**
   * 「切回项目自动打开 busy 会话」已决策的去重键(`${wsId}#${切换序号}`,
   * 内存态):每次项目切换只决策一次,避免后台新起的 run(自动化等)
   * 打断用户当前操作。useSessions 的 effect 读写。
   */
  autoOpenDecidedKey: string | null;
  /** 每个 workspace 用户手动选中的模型,跨重启保留 */
  modelSelections: Record<string, ModelSelection>;
  setModelSelection: (workspaceId: string, sel: ModelSelection) => void;
  clearModelSelection: (workspaceId: string) => void;
  /** 最近使用的模型(全局,最近在前,最多 RECENT_MODELS_MAX 个),跨重启保留 */
  recentModels: RecentModel[];
  pushRecentModel: (entry: RecentModel) => void;
  /** 从最近使用列表中删除单条(provider+model 唯一定位) */
  removeRecentModel: (entry: RecentModel) => void;

  bySession: Record<string, SessionRuntime>;
  permissionQueue: Api.PermissionRequest[];
  questionQueue: Api.QuestionRequest[];
  /** 每个 session 的任务列表(todo_write 工具推送,实时更新) */
  todos: Record<string, Api.TodoItem[]>;
  /** 每个 session 的子 agent 任务进度(agent 工具派发,subagent_update 推送) */
  subagents: Record<string, Api.SubAgentTask[]>;
  /** 每个 session 的累计 API 调用次数(rig turns 计数:usage SSE 事件实时
   * 推送、会话列表 api_calls 播种;内存态,切项目时回收) */
  apiCallsBySession: Record<string, number>;

  /**
   * 每个 session 当前 run 的起点记忆({runId, startedAt}):跨项目切换保留
   * (与 busySessions 同理)并随 localStorage 持久化。忙碌快照恢复(切回
   * 项目/SSE 重连/刷新页面)会以服务端广播的同一 runId 重放 markRun running,
   * 此时复用最初记录的起点,保证「正在执行」耗时在**一次 run 内不重置**。
   * runId 为全局唯一 UUID(客户端生成或服务端自动化生成),匹配即同一 run。
   * run 结束(done,含无本地运行态的迟到收尾)与会话清空时移除条目。
   */
  runStarts: Record<string, { runId: string; startedAt: number }>;

  upsertMessage: (sessionId: string, m: Api.Message) => void;
  removeOptimisticMessages: (sessionId: string) => void;
  hydrateMessages: (sessionId: string, msgs: Api.Message[]) => void;
  deleteMessage: (sessionId: string, messageId: string) => void;
  markRun: (
    sessionId: string,
    runId: string,
    status: 'running' | 'done',
    error?: string
  ) => void;
  setQueued: (sessionId: string, queued: boolean) => void;
  /** 记录「provider 流被截断自动重试」提示(run 期间显示,下次 run 启动时清空) */
  setRetryNotice: (sessionId: string, text: string) => void;
  enqueuePermission: (p: Api.PermissionRequest) => void;
  resolvePermission: (toolCallId: string) => void;
  enqueueQuestionBatch: (b: Api.QuestionRequest) => void;
  dismissQuestionBatch: (batchId: string) => void;
  setTodos: (sessionId: string, todos: Api.TodoItem[]) => void;
  clearTodos: (sessionId: string) => void;
  /** 设置会话的子 agent 任务进度(全量快照替换,后端按节流间隔推送) */
  setSubAgents: (sessionId: string, tasks: Api.SubAgentTask[]) => void;
  /** 清空会话的子 agent 进度(run 收尾 / 清空会话) */
  clearSubAgents: (sessionId: string) => void;
  /**
   * 设置会话的累计 API 调用次数(取单调较大值:实时事件与会话列表播种
   * 可能乱序到达,旧值不应覆盖新值;计数只增不减)。
   */
  setApiCalls: (sessionId: string, n: number) => void;
  /** 清空会话(/clear 命令)后把调用计数归零——与 setApiCalls 的单调递增互补 */
  resetApiCalls: (sessionId: string) => void;
  /** 把已全部完成的任务清单作为一张卡片消息插入消息流末尾(归档,不再占用输入坞上方) */
  insertTodoCard: (sessionId: string, runId: string, todos: Api.TodoItem[]) => void;
  clearSessionRuntime: (sessionId: string) => void;

  /**
   * 会话未读标记(内存态):run 在用户未查看该会话期间结束(状态由处理中
   * 变为完成/出错/取消)时置位;点开该会话(或 /clear、删除)时清除。
   * 跨项目保留 —— 切走项目再切回仍能看到未读角标。
   */
  unreadSessions: Record<string, true>;
  /** 清除单个会话的未读标记 */
  clearSessionUnread: (sessionId: string) => void;
  /**
   * 已知处于 busy(处理中)的会话集合(内存态,跨项目保留)。
   * 来源:本地 run 启动(markRun running)、会话事件与会话列表的 is_busy。
   * 检测 busy → 空闲 的状态转变:切走会话/项目后 run 在后台结束时,
   * 本地可能已无运行态(切项目时回收),靠该集合补上「错过结束信号」的未读判定。
   */
  busySessions: Record<string, true>;
  /**
   * 观察会话的服务端 busy 状态(is_busy):
   * - true:记入 busySessions;
   * - false:若此前记为 busy(状态发生转变)且用户当前未在查看该会话,
   *   标记为未读并移出集合;正在查看则视为已读,仅移出集合。
   * - undefined/null:忽略。
   */
  observeSessionBusy: (sessionId: string, busy: boolean | null | undefined) => void;
}

const emptyRuntime = (): SessionRuntime => ({ messages: [], run: null, queued: false });

export const useAgentStore = create<AgentState>()(
  persist(
    (set) => ({
  activeWorkspaceId: null,
  lastWorkspacePath: null,
  workspaceSwitchSeq: 0,
  autoOpenDecidedKey: null,
  setActiveWorkspace: (id) =>
    set((st) => {
      if (id === st.activeWorkspaceId) return { activeWorkspaceId: id };
      // 切换项目时清空会话,避免把上一个项目的会话带到新项目;
      // 同时回收全部会话运行态与任务清单(SSE 只订阅当前项目,旧项目的
      // 运行态不会再更新;消息已持久化在服务端,切回时由 busy 快照 +
      // 历史拉取恢复),防止内存随浏览的项目/会话只增不减。
      // unreadSessions / busySessions / runStarts 特意保留:切走项目的会话
      // 在后台结束后,切回时仍要能展示未读角标;仍在跑的会话切回时,
      // busy 快照以同一 runId 恢复运行态并复用原计时起点(不重置)。
      return {
        activeWorkspaceId: id,
        activeSessionId: null,
        bySession: {},
        todos: {},
        subagents: {},
        apiCallsBySession: {},
        workspaceSwitchSeq: st.workspaceSwitchSeq + 1,
      };
    }),
  setLastWorkspacePath: (path) => set({ lastWorkspacePath: path }),
  modelSelections: {},
  setModelSelection: (workspaceId, sel) =>
    set((st) => ({
      modelSelections: { ...st.modelSelections, [workspaceId]: sel },
    })),
  clearModelSelection: (workspaceId) =>
    set((st) => {
      const { [workspaceId]: _drop, ...rest } = st.modelSelections;
      return { modelSelections: rest };
    }),
  recentModels: [],
  pushRecentModel: (entry) =>
    set((st) => {
      // 去重(provider+model 唯一),最新放到最前,超出上限丢弃最旧的
      const rest = st.recentModels.filter(
        (m) => !(m.model === entry.model && m.provider === entry.provider)
      );
      return { recentModels: [entry, ...rest].slice(0, RECENT_MODELS_MAX) };
    }),
  removeRecentModel: (entry) =>
    set((st) => ({
      recentModels: st.recentModels.filter(
        (m) => !(m.model === entry.model && m.provider === entry.provider)
      ),
    })),
  activeSessionId: null,
  setActiveSessionId: (id) =>
    set((st) => {
      const prev = st.activeSessionId;
      if (prev === id) return st;
      // 打开会话即视为已读:清掉未读角标
      const { [id as string]: _u, ...unreadSessions } = st.unreadSessions;
      const unreadPatch =
        id != null && st.unreadSessions[id] ? { unreadSessions } : {};
      // 切走会话:已结束(且未排队)的运行态就地回收,防止多会话
      // 并发/浏览时消息只增不减;running 中的保留(继续接收 SSE 更新,
      // 结束后由 markRun 的回收路径处理)
      const prevRt = prev ? st.bySession[prev] : undefined;
      if (prev && prevRt && prevRt.run?.status !== 'running' && !prevRt.queued) {
        const { [prev]: _drop, ...bySession } = st.bySession;
        return { activeSessionId: id, bySession, ...unreadPatch };
      }
      return { activeSessionId: id, ...unreadPatch };
    }),

  bySession: {},
  permissionQueue: [],
  questionQueue: [],
  todos: {},
  subagents: {},
  apiCallsBySession: {},
  runStarts: {},
  unreadSessions: {},
  busySessions: {},

  clearSessionUnread: (sessionId) =>
    set((st) => {
      if (!st.unreadSessions[sessionId]) return st;
      const { [sessionId]: _drop, ...rest } = st.unreadSessions;
      return { unreadSessions: rest };
    }),

  observeSessionBusy: (sessionId, busy) =>
    set((st) => {
      if (busy === true) {
        if (st.busySessions[sessionId]) return st;
        return { busySessions: { ...st.busySessions, [sessionId]: true } };
      }
      if (busy !== false) return st;
      if (!st.busySessions[sessionId]) return st;
      // busy → 空闲的状态转变:用户没在看这个会话 → 标记未读
      const { [sessionId]: _drop, ...busySessions } = st.busySessions;
      if (st.activeSessionId === sessionId) return { busySessions };
      return {
        busySessions,
        unreadSessions: { ...st.unreadSessions, [sessionId]: true },
      };
    }),

  upsertMessage: (sessionId, m) =>
    set((st) => {
      const rt = st.bySession[sessionId] ?? emptyRuntime();
      const idx = rt.messages.findIndex((x) => x.id === m.id);
      // 收到 finish part 的消息视为该条流式结束,
      // 不再依赖 run_complete 事件(可能延迟或丢失)
      // 后端返回的消息可能缺少 parts 字段(生成类型为 parts?: unknown[]),需兜底
      const parts = m.parts ?? [];
      const hasFinish = parts.some((p) => p.type === 'finish');
      const vm: MessageVM = {
        id: m.id,
        role: m.role,
        parts,
        createdAt: toMs(m.created_at),
        updatedAt: toMs(m.updated_at),
        streaming: hasFinish ? false : true,
      };
      // 新消息抵达时,更早的消息都已结束流式(同一时刻只有一条在流)。
      // 仅对流式中的消息做解构更新(保留其余消息的对象引用),
      // 让 React.memo(MessageItem) 在流式期间跳过未变化消息的重渲染。
      const messages =
        idx >= 0
          ? rt.messages.map((x, i) =>
              i === idx ? vm : x.streaming ? { ...x, streaming: false } : x
            )
          : [...rt.messages.map((x) => (x.streaming ? { ...x, streaming: false } : x)), vm];
      return { bySession: { ...st.bySession, [sessionId]: { ...rt, messages } } };
    }),

  removeOptimisticMessages: (sessionId) =>
    set((st) => {
      const rt = st.bySession[sessionId];
      if (!rt) return st;
      return {
        bySession: {
          ...st.bySession,
          [sessionId]: {
            ...rt,
            messages: rt.messages.filter((x) => !x.id.startsWith('local-')),
          },
        },
      };
    }),

  hydrateMessages: (sessionId, msgs) =>
    set((st) => {
      const rt = st.bySession[sessionId];
      const historyIds = new Set(msgs.map((m) => m.id));
      // 保留 store 中不在历史里的消息(SSE 实时推送的新消息),
      // 避免因 SSE 部分灌入导致完整历史被跳过
      const liveMessages = rt?.messages.filter((m) => !historyIds.has(m.id)) ?? [];
      const messages: MessageVM[] = [
        ...msgs.map((m) => ({
          id: m.id,
          role: m.role,
          parts: m.parts ?? [],
          createdAt: toMs(m.created_at),
          updatedAt: toMs(m.updated_at),
          streaming: false,
        })),
        ...liveMessages,
      ];
      // 消息 id 与 updatedAt 均未变化时跳过更新,避免不必要的渲染。
      // 必须比较 updatedAt:run 在未订阅期间结束时(run 于服务端收尾),
      // 同 id 消息的内容已更新(流式快照 → 最终版),仅比 id 会漏刷新。
      if (
        rt &&
        rt.messages.length === messages.length &&
        rt.messages.every((m, i) => m.id === messages[i].id && m.updatedAt === messages[i].updatedAt)
      ) {
        return st;
      }
      return {
        bySession: {
          ...st.bySession,
          [sessionId]: { ...(rt ?? emptyRuntime()), messages },
        },
      };
    }),

  deleteMessage: (sessionId, messageId) =>
    set((st) => {
      const rt = st.bySession[sessionId];
      if (!rt) return st;
      return {
        bySession: {
          ...st.bySession,
          [sessionId]: {
            ...rt,
            messages: rt.messages.filter((x) => x.id !== messageId),
          },
        },
      };
    }),

  markRun: (sessionId, runId, status, error) =>
    set((st) => {
      const rt = st.bySession[sessionId];
      const ts = new Date().toISOString().slice(11, 23);
      // run 结束时移除起点记忆:条目只在 run 进行中有意义(同 runId 的
      // busy 快照重放才复用),结束后留着只会让 map 随会话数只增不减
      const dropRunStart = (map: Record<string, { runId: string; startedAt: number }>) => {
        if (!map[sessionId]) return map;
        const { [sessionId]: _rs, ...rest } = map;
        return rest;
      };
      // 仅有收尾事件而无本地运行态(如重连后的过期收尾):不再新建条目,
      // 避免会话 map 只增不减
      if (!rt && status === 'done') {
        const runStarts = dropRunStart(st.runStarts);
        if (runStarts === st.runStarts) return st;
        return { runStarts };
      }
      const cur = rt ?? emptyRuntime();
      console.debug(
        `[${ts}][store] markRun status="${status}" prev="${cur.run?.status ?? 'none'}" session="${sessionId}" msgCount=${cur.messages.length}`
      );
      // 非当前会话的 run 结束:回收其运行态与任务清单(消息已持久化在
      // 服务端,切回时按需重新拉取),防止多会话并发时内存只增不减;
      // 同时移出 busy 集合并标记未读 —— 状态变了但用户还没看过这次结果
      if (status === 'done' && st.activeSessionId !== sessionId) {
        const { [sessionId]: _drop, ...bySession } = st.bySession;
        const { [sessionId]: _td, ...todos } = st.todos;
        const { [sessionId]: _bs, ...busySessions } = st.busySessions;
        return {
          bySession,
          todos,
          busySessions,
          runStarts: dropRunStart(st.runStarts),
          unreadSessions: { ...st.unreadSessions, [sessionId]: true },
        };
      }
      const messages =
        status === 'done'
          ? cur.messages.map((m) => ({ ...m, streaming: false }))
          : cur.messages;
      // 进入 running 记录起点(输入坞上方「正在执行」耗时展示);收尾为
      // done 时保留原起点,便于需要时回看本轮耗时。
      // 同一 runId 的重复标记(切换项目/会话后 busy 快照恢复、SSE 重连、
      // 刷新页面重放)复用最初记录的起点 —— runId 全局唯一,匹配即同一次
      // run,保证一次 run 的计时不因切换而重置;不同 runId 记新起点。
      const prevStart = st.runStarts[sessionId];
      let startedAt: number | undefined;
      let runStarts = st.runStarts;
      if (status === 'running') {
        startedAt = prevStart?.runId === runId ? prevStart.startedAt : Date.now();
        runStarts = { ...st.runStarts, [sessionId]: { runId, startedAt } };
      } else {
        startedAt = cur.run?.startedAt;
        runStarts = dropRunStart(st.runStarts);
      }
      // busy 集合维护:run 启动时记入(供切走后检测「错过结束信号」);
      // 当前会话的 run 结束视为已读,仅移出集合、不打未读标
      let busySessions = st.busySessions;
      if (status === 'running' && !st.busySessions[sessionId]) {
        busySessions = { ...st.busySessions, [sessionId]: true };
      } else if (status === 'done' && st.busySessions[sessionId]) {
        const { [sessionId]: _bs, ...rest } = st.busySessions;
        busySessions = rest;
      }
      return {
        busySessions,
        runStarts,
        bySession: {
          ...st.bySession,
          [sessionId]: {
            ...cur,
            run: {
              runId,
              status,
              ...(startedAt != null ? { startedAt } : {}),
              ...(error ? { error } : {}),
            },
            messages,
            // 新 run 启动时清掉上一次的截断重试提示(done 时保留,便于用户看到)
            ...(status === 'running' ? { retryNotice: undefined } : {}),
          },
        },
      };
    }),

  setQueued: (sessionId, queued) =>
    set((st) => {
      const rt = st.bySession[sessionId] ?? emptyRuntime();
      return { bySession: { ...st.bySession, [sessionId]: { ...rt, queued } } };
    }),

  setRetryNotice: (sessionId, text) =>
    set((st) => {
      const rt = st.bySession[sessionId] ?? emptyRuntime();
      return {
        bySession: { ...st.bySession, [sessionId]: { ...rt, retryNotice: text } },
      };
    }),

  enqueuePermission: (p) => set((st) => ({ permissionQueue: [...st.permissionQueue, p] })),
  resolvePermission: (toolCallId) =>
    set((st) => ({
      permissionQueue: st.permissionQueue.filter((p) => p.tool_call_id !== toolCallId),
    })),
  enqueueQuestionBatch: (b) => set((st) => ({ questionQueue: [...st.questionQueue, b] })),
  dismissQuestionBatch: (batchId) =>
    set((st) => ({ questionQueue: st.questionQueue.filter((b) => b.id !== batchId) })),
  setTodos: (sessionId, todos) =>
    set((st) => ({ todos: { ...st.todos, [sessionId]: todos } })),
  setApiCalls: (sessionId, n) =>
    set((st) => {
      const cur = st.apiCallsBySession[sessionId] ?? 0;
      if (n <= cur) return st;
      return { apiCallsBySession: { ...st.apiCallsBySession, [sessionId]: n } };
    }),
  resetApiCalls: (sessionId) =>
    set((st) => ({ apiCallsBySession: { ...st.apiCallsBySession, [sessionId]: 0 } })),
  clearTodos: (sessionId) =>
    set((st) => {
      const { [sessionId]: _drop, ...rest } = st.todos;
      return { todos: rest };
    }),
  setSubAgents: (sessionId, tasks) =>
    set((st) => ({ subagents: { ...st.subagents, [sessionId]: tasks } })),
  clearSubAgents: (sessionId) =>
    set((st) => {
      const { [sessionId]: _drop, ...rest } = st.subagents;
      return { subagents: rest };
    }),
  insertTodoCard: (sessionId, runId, todos) =>
    set((st) => {
      const rt = st.bySession[sessionId] ?? emptyRuntime();
      const card: MessageVM = {
        id: `todo-${runId}`,
        role: 'system',
        parts: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
        streaming: false,
        todoItems: todos,
      };
      return {
        bySession: {
          ...st.bySession,
          [sessionId]: { ...rt, messages: [...rt.messages, card] },
        },
      };
    }),
  clearSessionRuntime: (sessionId) =>
    set((st) => {
      const { [sessionId]: _drop, ...rest } = st.bySession;
      // /clear、删除会话等路径复用:未读角标、busy 跟踪与 run 起点记忆一并清理
      const { [sessionId]: _u, ...unread } = st.unreadSessions;
      const { [sessionId]: _b, ...busy } = st.busySessions;
      const { [sessionId]: _rs, ...runStarts } = st.runStarts;
      return { bySession: rest, unreadSessions: unread, busySessions: busy, runStarts };
    }),
    }),
    {
      name: 'combo.agent',
      // 只持久化选中态与 run 起点记忆,SSE 实时状态(消息/队列)不入库。
      // runStarts 持久化是为了刷新页面后同一 run 的 busy 快照恢复仍能续上
      // 真实起点(runId 匹配才会复用,条目极小且随 run 结束清理,无泄漏)。
      partialize: (s) => ({
        activeWorkspaceId: s.activeWorkspaceId,
        lastWorkspacePath: s.lastWorkspacePath,
        activeSessionId: s.activeSessionId,
        modelSelections: s.modelSelections,
        recentModels: s.recentModels,
        runStarts: s.runStarts,
      }),
    }
  )
);
