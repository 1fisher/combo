import { create } from 'zustand';
import { useAgentStore } from './agentStore';

/**
 * 主内容区视图;automation/search/skills/mcp/lsp/stats/graph/shortcuts 为
 * 全页独立视图(侧边栏可导航)。类型定义在此处、由 AppShell re-export:
 * 后退/前进需要把「视图 + 项目 + 会话」三元组一起记入路由历史。
 */
export type AppView =
  | 'agent'
  | 'terminal'
  | 'editor'
  | 'automation'
  | 'search'
  | 'skills'
  | 'mcp'
  | 'lsp'
  | 'stats'
  | 'graph'
  | 'shortcuts';

/** 侧边栏导航按钮对应的全页视图 */
export type SideView = Extract<
  AppView,
  'automation' | 'search' | 'skills' | 'mcp' | 'lsp' | 'stats' | 'graph' | 'shortcuts'
>;

/** 一条路由历史:当前视图 + 项目 + 会话 */
export interface NavEntry {
  view: AppView;
  workspaceId: string | null;
  sessionId: string | null;
}

/** 历史栈上限,长时间使用不无限增长 */
const HISTORY_MAX = 100;

interface NavState {
  /** 当前主内容区视图(AppShell 消费) */
  view: AppView;
  setView: (v: AppView) => void;
  entries: NavEntry[];
  /** 当前所处条目下标(entries[index] 即当前路由) */
  index: number;
  /** 后退一步;无历史时为 no-op */
  back: () => void;
  /** 前进一步;无前进历史时为 no-op */
  forward: () => void;
}

function sameEntry(a: NavEntry, b: NavEntry): boolean {
  return a.view === b.view && a.workspaceId === b.workspaceId && a.sessionId === b.sessionId;
}

/** 后退/前进恢复期间 >0:抑制 agentStore 订阅把「恢复动作」再次记为新历史 */
let applying = 0;

/** 追加一条历史(浏览器语义:截断游标之后的条目),带去重与中间态合并 */
function pushEntry(entry: NavEntry) {
  const st = useNavStore.getState();
  const entries = st.entries.slice(0, st.index + 1);
  const last = entries[entries.length - 1];
  if (last && sameEntry(last, entry)) return;
  // 同视图同项目:会话从「未选中」升级为「选中」合并为同一步。
  // 切换项目会先清空会话,列表加载后自动选中首个/busy 会话——不合并的话,
  // 历史里会多一条无意义的「无会话」中间态,后退会先退到它再被自动选中顶掉。
  if (
    last &&
    last.view === entry.view &&
    last.workspaceId === entry.workspaceId &&
    last.sessionId == null &&
    entry.sessionId != null
  ) {
    entries[entries.length - 1] = entry;
    useNavStore.setState({ entries });
    return;
  }
  entries.push(entry);
  const overflow = entries.length - HISTORY_MAX;
  const next = overflow > 0 ? entries.slice(overflow) : entries;
  useNavStore.setState({ entries: next, index: next.length - 1 });
}

/** 把一条历史真实应用到界面状态(view + agentStore 的项目/会话) */
function applyEntry(entry: NavEntry) {
  applying += 1;
  try {
    const agent = useAgentStore.getState();
    if (entry.workspaceId !== agent.activeWorkspaceId) {
      // 切项目会清空会话,恢复顺序必须是「先项目后会话」
      agent.setActiveWorkspace(entry.workspaceId);
    }
    const after = useAgentStore.getState();
    if (entry.sessionId !== after.activeSessionId) {
      after.setActiveSessionId(entry.sessionId);
    }
    useNavStore.setState({ view: entry.view });
  } finally {
    applying -= 1;
  }
}

export const useNavStore = create<NavState>()((set, get) => ({
  view: 'agent',
  entries: [],
  index: 0,
  setView: (v) => {
    const st = get();
    if (st.view === v) return;
    const agent = useAgentStore.getState();
    if (st.entries.length === 0) {
      // 首次导航:先把起始状态落为第一步,「后退」才能回到这里
      pushEntry({
        view: st.view,
        workspaceId: agent.activeWorkspaceId,
        sessionId: agent.activeSessionId,
      });
    }
    set({ view: v });
    pushEntry({
      view: v,
      workspaceId: agent.activeWorkspaceId,
      sessionId: agent.activeSessionId,
    });
  },
  back: () => {
    const st = get();
    if (st.index <= 0) return;
    set({ index: st.index - 1 });
    applyEntry(st.entries[st.index - 1]);
  },
  forward: () => {
    const st = get();
    if (st.index >= st.entries.length - 1) return;
    set({ index: st.index + 1 });
    applyEntry(st.entries[st.index + 1]);
  },
}));

// 项目/会话变化(用户点击、自动选中、后端纠正等)记入路由历史;
// 视图切换经 setView 记录。两条防线:
// - applying>0(back/forward 恢复中)不记录,避免恢复被再次当成新导航;
// - 首次变化先把「变化前」状态落为第一步(后退可用),但启动期项目还是
//   null 时不落——避免刚打开应用就出现「后退回到空首页」的死历史。
useAgentStore.subscribe((state, prev) => {
  if (
    state.activeWorkspaceId === prev.activeWorkspaceId &&
    state.activeSessionId === prev.activeSessionId
  )
    return;
  if (applying > 0) return;
  const nav = useNavStore.getState();
  if (nav.entries.length === 0 && prev.activeWorkspaceId != null) {
    pushEntry({
      view: nav.view,
      workspaceId: prev.activeWorkspaceId,
      sessionId: prev.activeSessionId,
    });
  }
  pushEntry({
    view: nav.view,
    workspaceId: state.activeWorkspaceId,
    sessionId: state.activeSessionId,
  });
});
