import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  BarChart3,
  Boxes,
  CalendarClock,
  ChevronDown,
  ChevronRight,
  FileCode2,
  Folder,
  FolderInput,
  GripVertical,
  Hash,
  Keyboard,
  ListFilter,
  Loader2,
  Maximize2,
  MessageCirclePlus,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  Settings,
  Smartphone,
  Trash2,
  WandSparkles,
  Waypoints,
  X,
} from 'lucide-react';
import { Button } from '../ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import { cn } from '../../lib/utils';
import { useQueryClient } from '@tanstack/react-query';
import { useWorkspaces } from '../../hooks/useWorkspaces';
import { useDirPermission } from '../../hooks/useDirPermission';
import { useSessions, markCreated } from '../../hooks/useSessions';
import { useActiveWorkspaceId } from '../../hooks/useActiveWorkspaceId';
import { useAgentStore } from '../../stores/agentStore';
import { useConnectionStore } from '../../stores/connectionStore';
import { isTauri } from '../../lib/connection';
import {
  comboToLabel,
  comboToParts,
  resolveShortcut,
  type ShortcutAction,
} from '../../lib/shortcuts';
import { useShortcutStore } from '../../stores/shortcutStore';
import { createSession as createSessionApi } from '../../lib/api';
import type { Api } from '../../lib/api/types';
import { useSessionSummary } from '../../hooks/useSessionSummary';
import { useRelayStatus } from '../../hooks/useRelayStatus';
import {
  ConversationList,
  FILTER_MODES,
  type FilterMode,
} from './ConversationList';
import { DirectoryPicker } from './DirectoryPicker';
import { SettingsDialog } from './SettingsDialog';
import type { AppView, SideView } from './AppShell';
// qrcode 依赖较大,首次打开二维码前不加载
const MobileConnectDialog = lazy(() =>
  import('./MobileConnectDialog').then((m) => ({ default: m.MobileConnectDialog })),
);

function basename(p: string): string {
  const clean = p.replace(/[\\/]+$/, '');
  const idx = Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\'));
  return idx >= 0 ? clean.slice(idx + 1) : clean;
}

/** 侧边栏全页视图导航项(渲染与快捷键、托盘事件共用同一份配置) */
const SIDE_NAV_ITEMS = [
  { view: 'search', label: '搜索', icon: Search, title: '搜索' },
  { view: 'automation', label: '自动化', icon: CalendarClock, title: '自动化' },
  { view: 'skills', label: '技能', icon: WandSparkles, title: '技能' },
  { view: 'mcp', label: 'MCP', icon: Boxes, title: 'MCP 工具' },
  { view: 'lsp', label: 'LSP', icon: FileCode2, title: 'LSP 服务' },
  { view: 'stats', label: '统计', icon: BarChart3, title: '用量统计' },
  { view: 'graph', label: '图谱', icon: Waypoints, title: '知识图谱' },
] as const;

/** 合法的侧边栏视图名(托盘事件 payload 校验用) */
const SIDE_VIEWS: readonly string[] = SIDE_NAV_ITEMS.map((i) => i.view);

/** sidebar 全局监听负责分派的动作(⌘N 与视图切换;语音输入由 Composer 分派) */
const SIDEBAR_ACTION_IDS = [
  'newTask',
  'view:search',
  'view:automation',
  'view:skills',
  'view:mcp',
  'view:lsp',
  'view:stats',
  'view:graph',
] as const satisfies readonly ShortcutAction[];

/** 项目名:优先后端返回的 name,回退到目录 basename。 */
function projectName(w: { name?: string; path: string }): string {
  return w.name && w.name.trim() ? w.name : basename(w.path);
}

/** token 数紧凑格式化(与任务行徽章一致:1.2K / 3.4M)。 */
function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

/** 汇总数据的空值兜底(汇总未加载完成时按 0 处理)。 */
const EMPTY_SUMMARY: Api.SessionSummary = {
  prompt_tokens: 0,
  completion_tokens: 0,
  cost: 0,
  busy_sessions: 0,
  total_sessions: 0,
};

/**
 * 项目 token 消耗徽章:该项目全部任务的 输入+输出 token 总和,
 * 样式与任务行(SessionRow)上的 tokens 徽章一致;无消耗时不渲染。
 * 数据来自 /sessions/summary(任务列表分页加载后不能再遍历列表求和,
 * 否则只统计到已加载页)。
 */
function WorkspaceTokenBadge({ summary }: { summary?: Api.SessionSummary }) {
  const s = summary ?? EMPTY_SUMMARY;
  const tokens = s.prompt_tokens + s.completion_tokens;
  if (tokens === 0) return null;
  return (
    <span
      className="shrink-0 rounded bg-surface-hover px-1 text-[10px] tabular-nums text-foreground-subtlest"
      title={`该项目任务 token 消耗:输入 ${formatTokens(s.prompt_tokens)} / 输出 ${formatTokens(s.completion_tokens)}${s.cost > 0 ? ` · 花费 $${s.cost < 0.01 ? s.cost.toFixed(4) : s.cost.toFixed(2)}` : ''}`}
    >
      {formatTokens(tokens)}
    </span>
  );
}

/**
 * 「项目」视图行的 token 徽章:读项目级会话汇总。
 * useSessionSummary 的 key 挂在 ['sessions', wsId, 'summary'],
 * 凡是 invalidate ['sessions', wsId] 的地方都会连带刷新(不产生额外
 * 失效逻辑),也不用 useSessions —— 它附带的全局副作用对徽章实例是误伤。
 */
function ProjectTokenBadge({ wsId }: { wsId: string }) {
  const { data: summary } = useSessionSummary(wsId);
  return <WorkspaceTokenBadge summary={summary} />;
}

/**
 * 「项目」视图行的运行中标记:该项目下有任务正在处理时显示旋转图标。
 * - 以 /sessions/summary 的 busy_sessions 为准(服务端 RunState 口径,
 *   覆盖未加载页里的 busy 会话);非当前项目收不到 SSE 事件,
 *   存在 busy 会话时短间隔轮询,让后台结束的 run 在几秒内熄灭标记。
 * - 当前项目的 run 启动广播(session 事件)会 invalidate
 *   ['sessions', wsId] 前缀,汇总随之刷新点亮标记。
 */
function ProjectBusyIndicator({ wsId }: { wsId: string }) {
  const { data } = useSessionSummary(wsId, {
    refetchInterval: (query) =>
      (query.state.data?.busy_sessions ?? 0) > 0 ? 5000 : false,
  });
  if ((data?.busy_sessions ?? 0) === 0) return null;
  return (
    <Loader2
      className="size-3 shrink-0 animate-spin text-brand"
      aria-label="该项目有任务正在处理中"
    />
  );
}

/** 可折叠分区:标题 + 折叠箭头 + 悬停操作(+ 等) */
function Section({
  title,
  open,
  onToggle,
  onAdd,
  addLabel,
  children,
}: {
  title: string;
  open: boolean;
  onToggle: () => void;
  onAdd?: () => void;
  addLabel?: string;
  children: ReactNode;
}) {
  return (
    <section className="group/section" aria-label={title}>
      <div className="flex h-7 min-w-0 items-center">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          className="flex h-7 min-w-0 flex-1 items-center gap-1 px-2.5 text-left text-[13px] font-medium text-foreground-subtlest outline-none transition-colors hover:text-foreground focus-visible:text-foreground"
        >
          <span className="min-w-0 truncate">{title}</span>
          {open ? (
            <ChevronDown className="size-3.5 shrink-0 opacity-0 transition-opacity group-hover/section:opacity-100 group-focus-within/section:opacity-100" />
          ) : (
            <ChevronRight className="size-3.5 shrink-0 opacity-0 transition-opacity group-hover/section:opacity-100 group-focus-within/section:opacity-100" />
          )}
        </button>
        <div className="flex shrink-0 items-center pr-1.5 transition-opacity">
          {onAdd && (
            <Button
              variant="ghost"
              size="icon-xs"
              className="shrink-0 text-foreground-subtle hover:bg-surface-hover hover:text-foreground"
              onClick={onAdd}
              aria-label={addLabel ?? `添加${title}`}
              title={addLabel ?? `添加${title}`}
            >
              <Plus className="size-3.5" />
            </Button>
          )}
        </div>
      </div>
      {open && <div className="pb-1">{children}</div>}
    </section>
  );
}

export function WorkspaceSidebar({
  onNavigate,
  onOpenView,
  activeView,
}: {
  onNavigate?: () => void;
  /** 打开主内容区全页视图(自动化/搜索/技能/MCP/统计) */
  onOpenView?: (v: SideView) => void;
  /** 当前主内容区视图,用于高亮导航项 */
  activeView?: AppView;
} = {}) {
  const qc = useQueryClient();
  const { workspaces, isLoading, create, rename, changePath, remove, reorder } =
    useWorkspaces();
  const active = useActiveWorkspaceId();
  const setActive = useAgentStore((s) => s.setActiveWorkspace);
  const setActiveSessionId = useAgentStore((s) => s.setActiveSessionId);
  const connStatus = useConnectionStore((s) => s.status);
  const connTransport = useConnectionStore((s) => s.transport);
  const {
    sessions: activeSessions,
    /** 项目全部会话数(服务端 total;分页加载后 loaded 长度 ≠ 总数,新建任务命名用它避免撞名) */
    total: activeTotal,
    create: createSessionIn,
    activate: activateSession,
  } = useSessions(active);
  // 底部「累计花费」:项目级汇总(分页后不能只对已加载页求和)
  const { data: activeSummary } = useSessionSummary(active);
  // 移动端远程访问状态(桌面端 → combo-relay 隧道;30s 轮询)
  const { data: relayStatus } = useRelayStatus();
  const relayActive =
    !!relayStatus?.persisted &&
    !!relayStatus?.token_valid &&
    !!relayStatus?.connected;

  const [tab, setTab] = useState<'tasks' | 'project'>('project');
  const [projOpen, setProjOpen] = useState(true);
  const [taskOpen, setTaskOpen] = useState(true);
  // 服务器目录选择器(浏览器/移动端):add=添加项目,change=更换目录
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerMode, setPickerMode] = useState<'add' | 'change'>('add');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState('');
  const [sidebarError, setSidebarError] = useState<string | null>(null);
  // 敏感目录(桌面/文稿/下载、移动硬盘等)首次访问前的授权询问:允许一次后持久记住
  const { run: runDirPerm, dialog: dirPermDialog } = useDirPermission((msg) =>
    setSidebarError(msg),
  );
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [mobileConnectOpen, setMobileConnectOpen] = useState(false);
  // 首次打开后才挂载,之后保持以保留关闭动画
  const [mobileConnectLoaded, setMobileConnectLoaded] = useState(false);
  useEffect(() => {
    if (mobileConnectOpen && !mobileConnectLoaded) setMobileConnectLoaded(true);
  }, [mobileConnectOpen, mobileConnectLoaded]);
  // 会话列表排序 & 筛选
  const [sortMode, setSortMode] = useState<'recent' | 'name'>('recent');
  // 任务搜索 + 筛选栏(点「筛选和排序」在任务列表顶部展开)
  const [filterBarOpen, setFilterBarOpen] = useState(false);
  const [taskQuery, setTaskQuery] = useState('');
  // 搜索框右侧的筛选项下拉
  const [filterMenuOpen, setFilterMenuOpen] = useState(false);
  // 弹出方向:下方空间不足时向上翻(矮窗口下避免被视口裁掉)
  const [filterMenuUp, setFilterMenuUp] = useState(false);
  const filterInputRef = useRef<HTMLInputElement | null>(null);
  // 任务筛选(状态/时间)
  const [filter, setFilter] = useState<FilterMode>('all');
  // 项目拖拽排序(Pointer Events 原生实现,触摸+鼠标统一):
  // dragId/dropTarget 只驱动渲染;拖拽会话与最新落点放 ref,避免高频 move 全量重渲染
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{
    id: string;
    edge: 'before' | 'after';
  } | null>(null);
  const dragSessionRef = useRef<{
    id: string;
    startX: number;
    startY: number;
    active: boolean;
  } | null>(null);
  // dropTarget 最新值镜像:pointerup 结算时读(setState 异步,直接读 state 可能是旧值)
  const dropTargetRef = useRef<{ id: string; edge: 'before' | 'after' } | null>(null);
  dropTargetRef.current = dropTarget;
  // 项目行 DOM 登记表:命中测试用(jsdom 等环境没有 elementFromPoint)
  const rowRefs = useRef(new Map<string, HTMLElement>());
  // 右键上下文菜单位置 + 目标 workspace
  const [ctxMenu, setCtxMenu] = useState<{
    x: number;
    y: number;
    ws: { id: string; name?: string; path: string };
  } | null>(null);
  // 删除确认对话框
  const [deleteTarget, setDeleteTarget] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const [deleting, setDeleting] = useState(false);
  // 更换目录对话框
  const [pathTarget, setPathTarget] = useState<{
    id: string;
    name: string;
    path: string;
  } | null>(null);
  const [pathDraft2, setPathDraft2] = useState('');
  const [changingPath, setChangingPath] = useState(false);
  // 供 ⌘/Ctrl+N 快捷键调用的最新 onNewTask(避免闭包过期)
  const onNewTaskRef = useRef<() => void>(() => {});
  // 供 ⌘/Ctrl+K 快捷键调用的最新 onOpenView(同上)
  const onOpenViewRef = useRef(onOpenView);
  onOpenViewRef.current = onOpenView;

  // 全局快捷键(⌘/Ctrl+N 新建任务、视图切换)走 shortcutStore 的绑定:
  // 键位可在「快捷键」视图自定义;分派规则(编辑区让位等)见 resolveShortcut
  const shortcutBindings = useShortcutStore((s) => s.bindings);
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const action = resolveShortcut(e, shortcutBindings, SIDEBAR_ACTION_IDS);
      if (!action) return;
      e.preventDefault();
      if (action === 'newTask') onNewTaskRef.current();
      else onOpenViewRef.current?.(action.slice('view:'.length) as SideView);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [shortcutBindings]);

  // 托盘菜单事件(仅 Tauri 桌面端;后端已先唤起主窗口):
  // 「新建任务」新建会话;「打开视图」切换到对应全页视图
  useEffect(() => {
    if (!isTauri()) return;
    const unlistens: (() => void)[] = [];
    let disposed = false;
    void import('@tauri-apps/api/event')
      .then(({ listen }) => {
        const subs = [
          listen('tray-new-task', () => onNewTaskRef.current()),
          listen('tray-open-view', (ev) => {
            const v = ev.payload;
            if (typeof v === 'string' && SIDE_VIEWS.includes(v)) {
              onOpenViewRef.current?.(v as SideView);
            }
          }),
        ].map((p) =>
          p.then((fn) => {
            if (disposed) fn();
            else unlistens.push(fn);
          }),
        );
        return Promise.all(subs);
      })
      // Tauri 内部 API 不可用(测试环境/旧版本)时静默跳过
      .catch(() => {});
    return () => {
      disposed = true;
      unlistens.forEach((fn) => fn());
    };
  }, []);

  // 筛选项下拉外部点击关闭
  useEffect(() => {
    if (!filterMenuOpen) return;
    const close = () => setFilterMenuOpen(false);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [filterMenuOpen]);

  // 展开筛选栏时自动聚焦搜索框
  useEffect(() => {
    if (filterBarOpen) filterInputRef.current?.focus();
  }, [filterBarOpen]);

  // 收起任务搜索/筛选栏并重置条件
  const closeTaskFilterBar = () => {
    setFilterBarOpen(false);
    setTaskQuery('');
    setFilter('all');
    setFilterMenuOpen(false);
  };

  // 展开/全部收起:同步两个折叠分区
  function toggleExpandAll() {
    const bothOpen = projOpen && taskOpen;
    setProjOpen(!bothOpen);
    setTaskOpen(!bothOpen);
  }

  async function onAddProjectClick() {
    setSidebarError(null);
    if (isTauri()) {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const dir = await open({ directory: true, multiple: false });
      if (typeof dir === 'string') {
        await runDirPerm(() => create({ path: dir }).then(() => undefined));
      }
      return;
    }
    // 浏览器/移动端:打开服务器目录选择器(内含手动输入兑底)
    setPickerMode('add');
    setPickerOpen(true);
  }

  async function onNewTask() {
    setSidebarError(null);
    // active 可能在首屏渲染(useActiveWorkspaceId 的 auto-select effect 尚未执行)时为 null
    // 此处兜底:若 workspaces 已加载,直接用第一个项目创建会话
    let wsId = active;
    if (!wsId && workspaces?.length) {
      wsId = workspaces[0].id;
      setActive(wsId);
    }
    if (!wsId) {
      setSidebarError('请先在「项目」分区添加一个项目');
      return;
    }
    const base = `会话 ${(activeTotal ?? activeSessions?.length ?? 0) + 1}`;
    try {
      if (wsId === active) {
        const s = await createSessionIn(base);
        void activateSession(s.id);
      } else {
        // active 为 null 时走原生 API,手动管理状态
        const s = await createSessionApi(wsId, base);
        markCreated(s.id);
        setActiveSessionId(s.id);
        qc.invalidateQueries({ queryKey: ['sessions', wsId] });
      }
      onNavigate?.();
    } catch (e) {
      setSidebarError(e instanceof Error ? e.message : String(e));
    }
  }
  onNewTaskRef.current = () => void onNewTask();

  function startRename(w: { id: string; name?: string; path: string }) {
    setEditingId(w.id);
    setDraftName(projectName(w));
  }

  async function commitRename(id: string) {
    const name = draftName.trim();
    setEditingId(null);
    if (!name) return;
    try {
      await rename({ id, name });
    } catch (e) {
      setSidebarError(e instanceof Error ? e.message : String(e));
    }
  }

  function openContextMenu(
    e: React.MouseEvent,
    ws: { id: string; name?: string; path: string }
  ) {
    e.preventDefault();
    e.stopPropagation();
    openContextMenuAt(e.clientX, e.clientY, ws);
  }

  function openContextMenuAt(
    x: number,
    y: number,
    ws: { id: string; name?: string; path: string }
  ) {
    setCtxMenu({ x, y, ws });
  }

  /** 拖拽落点结算:把 dragId 移动到 targetId 的 before/after,乐观更新 + 落库 */
  function commitReorder(dragId: string, targetId: string, edge: 'before' | 'after') {
    if (!workspaces || dragId === targetId) return;
    const ids = workspaces.map((w) => w.id).filter((id) => id !== dragId);
    const idx = ids.indexOf(targetId);
    if (idx === -1) return;
    ids.splice(edge === 'before' ? idx : idx + 1, 0, dragId);
    reorder(ids).catch((e) =>
      setSidebarError(e instanceof Error ? e.message : String(e))
    );
  }

  /** 命中测试:指针落在哪个项目行上。优先 elementFromPoint,不可用时按行矩形回退 */
  function hitTestRow(x: number, y: number): string | null {
    let el: Element | null = null;
    try {
      el = document.elementFromPoint(x, y);
    } catch {
      el = null; // jsdom 等环境未实现
    }
    const row = (el as HTMLElement | null)?.closest?.('[data-project-row]') as
      | HTMLElement
      | null;
    if (row?.dataset.projectRow) return row.dataset.projectRow;
    for (const [id, el2] of rowRefs.current) {
      const r = el2.getBoundingClientRect();
      if (r.bottom > r.top && y >= r.top && y <= r.bottom) return id;
    }
    return null;
  }

  /** 拖到滚动容器上下缘时自动滚动,长列表也能把项目拖到可视区外 */
  function autoScrollDuringDrag(y: number) {
    const first = rowRefs.current.values().next().value as HTMLElement | undefined;
    if (!first) return;
    let p: HTMLElement | null = first.parentElement;
    while (p) {
      const style = window.getComputedStyle(p);
      if (
        (style.overflowY === 'auto' || style.overflowY === 'scroll') &&
        p.scrollHeight > p.clientHeight + 1
      )
        break;
      p = p.parentElement;
    }
    if (!p) return;
    const rect = p.getBoundingClientRect();
    const EDGE = 40;
    if (y < rect.top + EDGE) p.scrollTop -= 8;
    else if (y > rect.bottom - EDGE) p.scrollTop += 8;
  }

  /** 手柄按下:记录起点并捕获指针(触摸+鼠标统一);移动超阈值才真正进入拖拽 */
  function projectDragPointerDown(e: React.PointerEvent, id: string) {
    if (editingId === id) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    dragSessionRef.current = { id, startX: e.clientX, startY: e.clientY, active: false };
    // setPointerCapture:拖出小窗口/移出元素后 move 事件仍派发到手柄
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      // 合成事件/jsdom 下可能抛 NotFoundError,忽略
    }
  }

  /** 拖拽移动:超 5px 阈值激活;实时计算悬停目标行与插入边,并驱动边缘自动滚动 */
  function projectDragPointerMove(e: React.PointerEvent) {
    const d = dragSessionRef.current;
    if (!d) return;
    if (!d.active) {
      // 阈值内视为点击/误触,不进入拖拽
      if (Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < 5) return;
      d.active = true;
      setDragId(d.id);
      e.preventDefault();
    }
    autoScrollDuringDrag(e.clientY);
    const id = hitTestRow(e.clientX, e.clientY);
    if (!id || id === d.id) {
      setDropTarget(null);
      return;
    }
    const row = rowRefs.current.get(id);
    if (!row) return;
    const rect = row.getBoundingClientRect();
    const edge = e.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
    setDropTarget((prev) =>
      prev?.id === id && prev.edge === edge ? prev : { id, edge }
    );
  }

  /** 抬起/取消:结算排序(取消不结算)并清理拖拽状态 */
  function projectDragPointerUp(e: React.PointerEvent, cancel = false) {
    const d = dragSessionRef.current;
    dragSessionRef.current = null;
    if (!d?.active) return;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
    } catch {
      // 忽略
    }
    const t = dropTargetRef.current;
    if (!cancel && t && t.id !== d.id) commitReorder(d.id, t.id, t.edge);
    setDragId(null);
    setDropTarget(null);
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    setSidebarError(null);
    try {
      await remove(deleteTarget.id);
      setDeleteTarget(null);
    } catch (e) {
      setSidebarError(e instanceof Error ? e.message : String(e));
    } finally {
      setDeleting(false);
    }
  }

  async function pickDirectory(): Promise<string | null> {
    if (isTauri()) {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const dir = await open({ directory: true, multiple: false });
      return typeof dir === 'string' ? dir : null;
    }
    return null;
  }

  async function commitChangePath() {
    if (!pathTarget) return;
    const p = pathDraft2.trim();
    if (!p) return;
    setChangingPath(true);
    setSidebarError(null);
    try {
      await runDirPerm(async () => {
        await changePath({ id: pathTarget.id, path: p });
        setPathTarget(null);
        setPathDraft2('');
      });
    } finally {
      setChangingPath(false);
    }
  }

  // 点击外部 / Escape 关闭右键菜单
  useEffect(() => {
    if (!ctxMenu) return;
    function close() {
      setCtxMenu(null);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setCtxMenu(null);
    }
    window.addEventListener('click', close);
    window.addEventListener('contextmenu', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('contextmenu', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [ctxMenu]);

  const transportLabel =
    connTransport === 'lan'
      ? ' · 局域网直连'
      : connTransport === 'p2p'
        ? ' · P2P'
        : connTransport === 'relay'
          ? ' · 中转'
          : '';
  const connLabel =
    (connStatus === 'connected'
      ? '已连接'
      : connStatus === 'connecting'
        ? '连接中'
        : '离线') + transportLabel;
  // 「任务」视图标题:当前项目名(无选中项目时回退「任务」),标识列表归属
  const activeWs = workspaces?.find((w) => w.id === active);

  return (
    <aside className="flex h-full select-none flex-col overflow-hidden">
      <div className="h-12 shrink-0" />
      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
        {/* 顶部操作按钮 */}
        <div className="flex flex-col gap-1 px-2 py-3">
          <button
            type="button"
            onClick={onNewTask}
            className="flex h-8 w-full shrink-0 cursor-pointer items-center gap-2 overflow-hidden rounded-lg pl-2.5 pr-2.5 text-left transition-colors hover:bg-surface-hover hover:text-foreground"
          >
            <MessageCirclePlus className="size-4 shrink-0" />
            <span className="min-w-0 flex-1 truncate text-[13px]">新建任务</span>
            <span className="shrink-0 text-xs font-normal text-foreground-subtlest">
              {comboToLabel(shortcutBindings.newTask)}
            </span>
          </button>
          {/* 主内容区全页视图导航:自动化/搜索/技能/MCP/统计/图谱(键位可在快捷键视图自定义) */}
          {SIDE_NAV_ITEMS.map((item) => {
            const combo = shortcutBindings[`view:${item.view}` as ShortcutAction];
            return (
              <button
                key={item.view}
                type="button"
                onClick={() => onOpenView?.(item.view)}
                className={cn(
                  'flex h-8 w-full shrink-0 cursor-pointer items-center gap-2 overflow-hidden rounded-lg pl-2.5 pr-2.5 text-left transition-colors hover:bg-surface-hover hover:text-foreground',
                  activeView === item.view && 'bg-surface-hover text-brand'
                )}
                title={`${item.title}(${comboToParts(combo).join('+') || '未绑定'})`}
              >
                <item.icon className="size-4 shrink-0" />
                <span className="min-w-0 flex-1 truncate text-[13px]">{item.label}</span>
                <span className="shrink-0 text-xs font-normal text-foreground-subtlest">
                  {comboToLabel(combo)}
                </span>
              </button>
            );
          })}
        </div>
        {/* 视图切换 + 工具按钮 */}
        <div className="flex min-w-0 items-center justify-between gap-2 pl-2.5 pr-3">
          <div
            role="tablist"
            aria-label="视图"
            className="relative inline-flex h-7 w-fit items-center overflow-hidden rounded-full bg-surface p-0.5"
          >
            <span
              aria-hidden
              className={cn(
                'pointer-events-none absolute inset-y-0.5 rounded-full bg-background transition-[opacity,transform,width] duration-200 ease-out',
                tab === 'tasks' ? 'left-0.5 w-[58px]' : 'left-[62px] w-[58px]'
              )}
            />
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'tasks'}
              onClick={() => setTab('tasks')}
              className={cn(
                'relative z-10 flex h-6 flex-none items-center gap-1 rounded-full py-0 pl-1.5 pr-2 text-[13px] font-medium transition-colors',
                tab === 'tasks' ? 'text-foreground' : 'text-foreground-subtle hover:text-foreground'
              )}
            >
              <Hash className="size-3 shrink-0" />
              <span>任务</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'project'}
              onClick={() => setTab('project')}
              className={cn(
                'relative z-10 flex h-6 flex-none items-center gap-1 rounded-full py-0 pl-1.5 pr-2 text-[13px] font-medium transition-colors',
                tab === 'project' ? 'text-foreground' : 'text-foreground-subtle hover:text-foreground'
              )}
            >
              <Folder className="size-3 shrink-0" />
              <span>项目</span>
            </button>
          </div>
          {/* 当前选中项目名:展示在「任务/项目」页卡右侧,超长截断,悬停见完整路径 */}
          {activeWs && (
            <span
              className="min-w-0 flex-1 truncate text-xs text-foreground-subtle"
              title={activeWs.path}
              data-testid="active-project-name"
            >
              {projectName(activeWs)}
            </span>
          )}
          <div className="flex shrink-0 items-center gap-1">
            <Button
              variant="ghost"
              size="icon-xs"
              className="shrink-0 text-foreground-subtle hover:text-foreground"
              aria-label={projOpen && taskOpen ? '全部收起' : '展开全部'}
              title={projOpen && taskOpen ? '全部收起' : '展开全部'}
              onClick={toggleExpandAll}
            >
              <Maximize2 className={cn('size-3.5 transition-transform', projOpen && taskOpen && 'rotate-180')} />
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              className={cn(
                'shrink-0 text-foreground-subtle hover:text-foreground',
                (filterBarOpen || filter !== 'all' || taskQuery) && 'text-brand'
              )}
              aria-label="筛选和排序"
              title="筛选和排序"
              onClick={(e) => {
                e.stopPropagation();
                if (tab !== 'tasks') setTab('tasks');
                if (filterBarOpen) {
                  // 再次点击收起并清空搜索与筛选条件
                  closeTaskFilterBar();
                } else {
                  setFilterBarOpen(true);
                }
              }}
            >
              <ListFilter className="size-3.5" />
            </Button>
          </div>
        </div>
        {/* 分区列表 */}
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-2 pt-3">
          {sidebarError && (
            <div className="flex items-start gap-2 rounded-lg bg-destructive/10 px-2.5 py-1.5 text-xs text-destructive">
              <span className="flex-1">{sidebarError}</span>
              <button
                type="button"
                onClick={() => setSidebarError(null)}
                className="shrink-0 text-destructive/70 hover:text-destructive"
                aria-label="关闭"
              >
                ✕
              </button>
            </div>
          )}
          {tab === 'project' ? (
            <Section
              title="项目"
              open={projOpen}
              onToggle={() => setProjOpen((o) => !o)}
              onAdd={onAddProjectClick}
              addLabel="添加项目"
            >
              {isLoading && (
                <div className="px-2.5 py-1.5 text-[13px] text-foreground-subtle">加载中…</div>
              )}
              {workspaces?.map((w) => (
                <div
                  key={w.id}
                  ref={(el) => {
                    if (el) rowRefs.current.set(w.id, el);
                    else rowRefs.current.delete(w.id);
                  }}
                  data-project-row={w.id}
                  className={cn(
                    'group relative flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] transition-colors hover:bg-surface-hover',
                    active === w.id && 'bg-surface-hover',
                    dragId === w.id && 'opacity-40'
                  )}
                  onClick={() => {
                    setActive(w.id);
                    onNavigate?.();
                  }}
                  onContextMenu={(e) => openContextMenu(e, w)}
                >
                  {/* 拖拽插入位置指示线(上半=插到本行前,下半=插到本行后) */}
                  {dropTarget?.id === w.id && (
                    <span
                      aria-hidden
                      className={cn(
                        'pointer-events-none absolute inset-x-1 z-10 h-0.5 rounded-full bg-brand',
                        dropTarget.edge === 'before' ? 'top-0' : 'bottom-0'
                      )}
                    />
                  )}
                  {/* 拖动排序手柄:只有从这里才能拖起项目(行本体不可拖,避免误拖) */}
                  <span
                    aria-label={`拖动排序 ${projectName(w)}`}
                    title="拖动排序"
                    onPointerDown={(e) => projectDragPointerDown(e, w.id)}
                    onPointerMove={projectDragPointerMove}
                    onPointerUp={projectDragPointerUp}
                    onPointerCancel={(e) => projectDragPointerUp(e, true)}
                    onClick={(e) => e.stopPropagation()}
                    className="-ml-1 flex shrink-0 touch-none cursor-grab items-center rounded p-0.5 text-foreground-subtlest transition-colors hover:text-foreground active:cursor-grabbing md:-ml-1.5"
                  >
                    <GripVertical className="size-3.5" />
                  </span>
                  <Folder
                    className={cn(
                      'size-4 shrink-0',
                      active === w.id ? 'text-foreground' : 'text-foreground-subtlest'
                    )}
                  />
                  {editingId === w.id ? (
                    <input
                      autoFocus
                      value={draftName}
                      onChange={(e) => setDraftName(e.target.value)}
                      onBlur={() => commitRename(w.id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') commitRename(w.id);
                        if (e.key === 'Escape') setEditingId(null);
                      }}
                      onClick={(e) => e.stopPropagation()}
                      className="w-full min-w-0 flex-1 rounded border border-input-border bg-background px-1.5 py-0.5 text-[13px] outline-none"
                    />
                  ) : (
                    <>
                      <span className="min-w-0 flex-1 truncate font-medium" title={w.path}>
                        {projectName(w)}
                      </span>
                      <ProjectBusyIndicator wsId={w.id} />
                      <ProjectTokenBadge wsId={w.id} />
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          startRename(w);
                        }}
                        title="重命名项目"
                        className="shrink-0 rounded-md p-1 text-foreground-subtle opacity-100 transition-opacity hover:bg-surface-hover hover:text-foreground md:opacity-0 md:group-hover:opacity-100"
                      >
                        <Pencil className="size-3" />
                      </button>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                          openContextMenuAt(
                            Math.min(r.right - 140, window.innerWidth - 150),
                            r.bottom + 4,
                            w
                          );
                        }}
                        aria-label="更多操作"
                        title="更多操作"
                        className="shrink-0 rounded-md p-1 text-foreground-subtle md:hidden hover:bg-surface-hover hover:text-foreground"
                      >
                        <MoreHorizontal className="size-3.5" />
                      </button>
                    </>
                  )}
                </div>
              ))}
              {!isLoading && workspaces?.length === 0 && (
                <div className="px-2.5 py-1.5 text-[13px] leading-relaxed text-foreground-subtle">
                  还没有项目,点击右上角「+」添加。
                </div>
              )}
            </Section>
          ) : (
            <>
              {/* 任务搜索 + 筛选栏:点「筛选和排序」展开;输入按标题过滤,chip 下拉选筛选项/排序 */}
              {filterBarOpen && (
                <div
                  className="mb-1 flex flex-none items-center gap-1 px-2.5"
                  onClick={(e) => e.stopPropagation()}
                >
                  <div className="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md border border-border bg-surface px-2 focus-within:border-brand">
                    <Search className="size-3 shrink-0 text-foreground-subtlest" />
                    <input
                      ref={filterInputRef}
                      value={taskQuery}
                      onChange={(e) => setTaskQuery(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Escape') closeTaskFilterBar();
                      }}
                      placeholder="搜索任务…"
                      aria-label="搜索任务"
                      data-testid="task-search-input"
                      className="h-full min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-foreground-subtlest"
                    />
                  </div>
                  <div className="relative shrink-0">
                    <button
                      type="button"
                      className={cn(
                        'flex h-7 items-center gap-1 rounded-md border px-2 text-xs transition-colors',
                        filter !== 'all'
                          ? 'border-brand text-brand'
                          : 'border-border text-foreground-subtle hover:text-foreground'
                      )}
                      aria-label="筛选项"
                      title="筛选项"
                      onClick={(e) => {
                        e.stopPropagation();
                        // 注意:e.currentTarget 在事件处理返回后会被 React 置空,先取好矩形
                        const rect = e.currentTarget.getBoundingClientRect();
                        setFilterMenuUp(window.innerHeight - rect.bottom < 240);
                        setFilterMenuOpen((o) => !o);
                      }}
                    >
                      {FILTER_MODES.find(([m]) => m === filter)?.[1] ?? '全部'}
                      <ChevronDown className={cn('size-3 transition-transform', filterMenuOpen && 'rotate-180')} />
                    </button>
                    {filterMenuOpen && (
                      <div
                        className={cn(
                          'absolute right-0 z-50 min-w-[140px] rounded-lg border border-border bg-popover p-1 text-[13px] text-popover-foreground shadow-lg',
                          filterMenuUp ? 'bottom-full mb-2' : 'top-full mt-2'
                        )}
                      >
                        {FILTER_MODES.map(([mode, label]) => (
                          <button
                            key={mode}
                            type="button"
                            className={cn(
                              'flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left transition-colors hover:bg-surface-hover',
                              filter === mode && 'text-brand'
                            )}
                            onClick={() => {
                              setFilter(mode);
                              setFilterMenuOpen(false);
                            }}
                          >
                            {label}
                            {filter === mode && <ChevronDown className="size-3.5 -rotate-90" />}
                          </button>
                        ))}
                        <div className="mt-1 border-t border-border px-2 pb-1 pt-1.5 text-xs font-medium text-foreground-subtlest">排序方式</div>
                        {([['recent', '最近优先'], ['name', '按名称']] as const).map(([mode, label]) => (
                          <button
                            key={mode}
                            type="button"
                            className={cn(
                              'flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left transition-colors hover:bg-surface-hover',
                              sortMode === mode && 'text-brand'
                            )}
                            onClick={() => {
                              setSortMode(mode);
                              setFilterMenuOpen(false);
                            }}
                          >
                            {label}
                            {sortMode === mode && <ChevronDown className="size-3.5 -rotate-90" />}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className="shrink-0 text-foreground-subtle hover:text-foreground"
                    aria-label="关闭筛选"
                    title="关闭筛选"
                    onClick={closeTaskFilterBar}
                  >
                    <X className="size-3.5" />
                  </Button>
                </div>
              )}
              <Section
                title={activeWs ? projectName(activeWs) : '任务'}
                open={taskOpen}
                onToggle={() => setTaskOpen((o) => !o)}
                onAdd={() => {
                  void onNewTask();
                }}
                addLabel="新建任务"
              >
                <ConversationList onNavigate={onNavigate} sortMode={sortMode} filter={filter} query={taskQuery} />
              </Section>
            </>
          )}
        </div>
      </div>
      {/* 花费统计(右侧;token 用量不再在此显示,任务行/项目徽章/Composer 用量环仍保留)。
          数据来自 /sessions/summary:任务列表分页加载后,只对已加载页求和会漏掉未加载页的花费。 */}
      {(() => {
        const cost = activeSummary?.cost ?? 0;
        if (cost <= 0) return null;
        const fmtCost = cost < 0.01
          ? `$${cost.toFixed(4)}`
          : `$${cost.toFixed(2)}`;
        return (
          <div className="flex items-center justify-end px-4 pb-1 text-[10px] tabular-nums text-foreground-subtlest">
            <span title="累计花费(USD)">
              {fmtCost}
            </span>
          </div>
        );
      })()}
      {/* 底部用户区 */}
      <div className="flex min-w-0 items-center gap-2 p-4 pt-2">
        <button
          type="button"
          className="flex h-8 min-w-0 flex-1 items-center gap-2 overflow-hidden rounded-tl-2xl rounded-bl-2xl border-0 pl-0 text-left transition-colors hover:bg-surface-hover"
          title={connStatus}
        >
          <span className="relative flex size-8 shrink-0 select-none items-center justify-center rounded-full bg-linear-to-br from-[#5EB1FF] via-[#4C7DFF] to-[#7C3AED] text-[13px] font-semibold text-white after:absolute after:inset-0 after:rounded-full after:border after:border-border">
            C
          </span>
          <span className="min-w-0 flex-1 overflow-hidden">
            <span className="block min-w-0 truncate text-[13px] font-semibold text-foreground">
              Combo
              <span className="ml-1.5 align-baseline text-[11px] font-normal text-foreground-subtlest">
                v{__APP_VERSION__}
              </span>
            </span>
            <span
              className={cn(
                'mt-0.5 flex items-center gap-1 text-[11px]',
                connStatus === 'connected'
                  ? 'text-success'
                  : connStatus === 'connecting'
                    ? 'text-warning'
                    : 'text-foreground-subtlest'
              )}
            >
              <span
                className={cn(
                  'inline-block size-1.5 rounded-full',
                  connStatus === 'connected'
                    ? 'bg-success'
                    : connStatus === 'connecting'
                      ? 'bg-warning'
                      : 'bg-foreground-subtlest'
                )}
              />
              {connLabel}
            </span>
          </span>
        </button>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button
            variant="ghost"
            size="icon-sm"
            className="shrink-0 text-foreground-subtle hover:bg-surface-hover hover:text-foreground"
            aria-label="快捷键管理"
            title="快捷键管理"
            onClick={() => onOpenViewRef.current?.('shortcuts')}
          >
            <Keyboard className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            className={cn(
              'shrink-0 text-foreground-subtle hover:bg-surface-hover hover:text-foreground',
              relayActive && 'text-brand',
            )}
            aria-label="移动端远程控制"
            title={relayActive ? '移动端远程控制(已开启,重启后自动恢复)' : '移动端远程控制'}
            onClick={() => setMobileConnectOpen(true)}
          >
            <span className="relative inline-flex">
              <Smartphone className="size-4" />
              {relayActive && (
                <span
                  className="absolute -right-0.5 -top-0.5 size-1.5 rounded-full bg-success"
                  title="远程访问已开启"
                />
              )}
            </span>
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            className="shrink-0 text-foreground-subtle hover:bg-surface-hover hover:text-foreground"
            aria-label="设置"
            title="设置"
            onClick={() => setSettingsOpen(true)}
          >
            <Settings className="size-4" />
          </Button>
        </div>
      </div>
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
      {mobileConnectLoaded && (
        <Suspense fallback={null}>
          <MobileConnectDialog open={mobileConnectOpen} onOpenChange={setMobileConnectOpen} />
        </Suspense>
      )}
      {/* 右键上下文菜单 */}
      {ctxMenu && (
        <div
          className="fixed z-50 min-w-[140px] rounded-lg border border-border bg-popover p-1 text-[13px] text-popover-foreground shadow-lg"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
          onClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.preventDefault()}
        >
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left transition-colors hover:bg-surface-hover"
            onClick={() => {
              startRename(ctxMenu.ws);
              setCtxMenu(null);
            }}
          >
            <Pencil className="size-3.5 shrink-0 text-foreground-subtle" />
            <span>重命名</span>
          </button>
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left transition-colors hover:bg-surface-hover"
            onClick={() => {
              setPathTarget({
                id: ctxMenu.ws.id,
                name: projectName(ctxMenu.ws),
                path: ctxMenu.ws.path,
              });
              setPathDraft2(ctxMenu.ws.path);
              setCtxMenu(null);
            }}
          >
            <FolderInput className="size-3.5 shrink-0 text-foreground-subtle" />
            <span>更换目录</span>
          </button>
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-destructive transition-colors hover:bg-destructive/10"
            onClick={() => {
              setDeleteTarget({
                id: ctxMenu.ws.id,
                name: projectName(ctxMenu.ws),
              });
              setCtxMenu(null);
            }}
          >
            <Trash2 className="size-3.5 shrink-0" />
            <span>删除项目</span>
          </button>
        </div>
      )}
      {/* 删除确认对话框 */}
      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open && !deleting) setDeleteTarget(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>删除项目</DialogTitle>
            <DialogDescription>
              确定删除「{deleteTarget?.name}」吗?该操作会移除项目及其所有会话记录,且不可撤销。磁盘文件不会被删除。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setDeleteTarget(null)}
              disabled={deleting}
            >
              取消
            </Button>
            <Button
              variant="destructive"
              onClick={() => void confirmDelete()}
              disabled={deleting}
            >
              {deleting ? '删除中…' : '删除'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {/* 更换目录对话框 */}
      <Dialog
        open={pathTarget !== null}
        onOpenChange={(open) => {
          if (!open && !changingPath) {
            setPathTarget(null);
            setPathDraft2('');
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>更换目录</DialogTitle>
            <DialogDescription>
              为「{pathTarget?.name}」指定新的绑定目录;会话记录会保留并迁移到新 workspace。
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <div className="text-[13px] text-foreground-subtle">
              当前:{pathTarget?.path}
            </div>
            <div className="flex items-center gap-1.5">
              <input
                autoFocus
                value={pathDraft2}
                onChange={(e) => setPathDraft2(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void commitChangePath();
                }}
                placeholder="/path/to/new/project"
                className="h-9 min-w-0 flex-1 rounded-lg border border-input-border bg-background px-2.5 text-[13px] outline-none focus-visible:border-input-border-focused"
              />
              {isTauri() ? (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-9 shrink-0 px-2.5 text-[13px]"
                  onClick={async () => {
                    const dir = await pickDirectory();
                    if (dir) setPathDraft2(dir);
                  }}
                >
                  选择…
                </Button>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-9 shrink-0 px-2.5 text-[13px]"
                  onClick={() => {
                    setPickerMode('change');
                    setPickerOpen(true);
                  }}
                >
                  浏览…
                </Button>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => {
                setPathTarget(null);
                setPathDraft2('');
              }}
              disabled={changingPath}
            >
              取消
            </Button>
            <Button
              onClick={() => void commitChangePath()}
              disabled={changingPath || !pathDraft2.trim()}
            >
              {changingPath ? '更换中…' : '更换'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {/* 目录访问授权弹窗(敏感目录首次访问时询问一次) */}
      {dirPermDialog}
      {/* 服务器目录选择器(浏览器/移动端) */}
      <DirectoryPicker
        open={pickerOpen}
        title={pickerMode === 'add' ? '添加项目' : '更换目录'}
        confirmLabel={pickerMode === 'add' ? '选择此目录' : '选择'}
        description={
          pickerMode === 'add'
            ? '在服务器上选择项目目录(服务器上的绝对路径)。'
            : '在服务器上选择新的绑定目录。'
        }
        onOpenChange={setPickerOpen}
        onSelect={(path) => {
          setPickerOpen(false);
          if (pickerMode === 'add') {
            setSidebarError(null);
            void runDirPerm(async () => {
              const w = await create({ path });
              setActive(w.id);
              onNavigate?.();
            });
          } else {
            setPathDraft2(path);
          }
        }}
      />
    </aside>
  );
}
