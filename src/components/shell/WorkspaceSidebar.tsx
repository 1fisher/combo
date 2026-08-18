import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Archive,
  BarChart3,
  Boxes,
  CalendarClock,
  ChevronDown,
  ChevronRight,
  Folder,
  FolderInput,
  GripVertical,
  Hash,
  ListFilter,
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
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useWorkspaces } from '../../hooks/useWorkspaces';
import { useDirPermission } from '../../hooks/useDirPermission';
import { useSessions, markCreated } from '../../hooks/useSessions';
import { useActiveWorkspaceId } from '../../hooks/useActiveWorkspaceId';
import { useAgentStore } from '../../stores/agentStore';
import { useConnectionStore } from '../../stores/connectionStore';
import { isTauri } from '../../lib/connection';
import { createSession as createSessionApi, listSessions } from '../../lib/api';
import type { Api } from '../../lib/api/types';
import { ConversationList } from './ConversationList';
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

/** 汇总一组会话的 token 消耗(输入+输出)与花费。 */
function sumSessionUsage(sessions: Api.Session[] | undefined) {
  return (sessions ?? []).reduce(
    (acc, s) => ({
      tokens: acc.tokens + (s.prompt_tokens ?? 0) + (s.completion_tokens ?? 0),
      prompt: acc.prompt + (s.prompt_tokens ?? 0),
      completion: acc.completion + (s.completion_tokens ?? 0),
      cost: acc.cost + (s.cost ?? 0),
    }),
    { tokens: 0, prompt: 0, completion: 0, cost: 0 },
  );
}

/**
 * 项目 token 消耗徽章:该项目全部任务的 输入+输出 token 总和,
 * 样式与任务行(SessionRow)上的 tokens 徽章一致;无消耗时不渲染。
 */
function WorkspaceTokenBadge({ sessions }: { sessions: Api.Session[] | undefined }) {
  const totals = sumSessionUsage(sessions);
  if (totals.tokens === 0) return null;
  return (
    <span
      className="shrink-0 rounded bg-surface-hover px-1 text-[10px] tabular-nums text-foreground-subtlest"
      title={`该项目任务 token 消耗:输入 ${formatTokens(totals.prompt)} / 输出 ${formatTokens(totals.completion)}${totals.cost > 0 ? ` · 花费 $${totals.cost < 0.01 ? totals.cost.toFixed(4) : totals.cost.toFixed(2)}` : ''}`}
    >
      {formatTokens(totals.tokens)}
    </span>
  );
}

/**
 * 「项目」视图行的 token 徽章:按 workspace 拉会话列表求和。
 * 直接用 useQuery 复用 useSessions 的 ['sessions', wsId] 缓存(同 key 去重,
 * 不产生额外请求),但**不用** useSessions —— 它附带的
 * 「activeSessionId 不属于该项目时清除」副作用对徽章实例是误伤。
 */
function ProjectTokenBadge({ wsId }: { wsId: string }) {
  const q = useQuery({
    queryKey: ['sessions', wsId],
    queryFn: () => listSessions(wsId),
  });
  return <WorkspaceTokenBadge sessions={q.data} />;
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
        <div
          className={cn(
            'flex shrink-0 items-center pr-1.5 transition-opacity',
            open
              ? 'opacity-100'
              : 'opacity-0 group-hover/section:opacity-100 group-focus-within/section:opacity-100'
          )}
        >
          <button
            type="button"
            aria-label={`移动${title}分区`}
            className="flex size-6 cursor-grab touch-none items-center justify-center rounded-md text-foreground-subtlest outline-none hover:bg-surface-hover hover:text-foreground"
          >
            <GripVertical className="size-3.5" />
          </button>
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
  const { workspaces, isLoading, create, rename, changePath, remove } = useWorkspaces();
  const active = useActiveWorkspaceId();
  const setActive = useAgentStore((s) => s.setActiveWorkspace);
  const setActiveSessionId = useAgentStore((s) => s.setActiveSessionId);
  const connStatus = useConnectionStore((s) => s.status);
  const connTransport = useConnectionStore((s) => s.transport);
  const {
    sessions: activeSessions,
    create: createSessionIn,
    activate: activateSession,
  } = useSessions(active);

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
  const [sortMenuOpen, setSortMenuOpen] = useState(false);
  // 会话归档筛选
  const [archiveOpen, setArchiveOpen] = useState(false);
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

  // ⌘/Ctrl+N 新建任务, ⌘/Ctrl+K 搜索
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        onNewTaskRef.current();
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        onOpenViewRef.current?.('search');
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // 托盘菜单「新建任务」(仅 Tauri 桌面端;后端已先唤起主窗口)
  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void import('@tauri-apps/api/event')
      .then(({ listen }) =>
        listen('tray-new-task', () => onNewTaskRef.current()).then((fn) => {
          if (disposed) fn();
          else unlisten = fn;
        })
      )
      // Tauri 内部 API 不可用(测试环境/旧版本)时静默跳过
      .catch(() => {});
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  // 排序菜单外部点击关闭
  useEffect(() => {
    if (!sortMenuOpen) return;
    const close = () => setSortMenuOpen(false);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [sortMenuOpen]);

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
    const base = `会话 ${(activeSessions?.length ?? 0) + 1}`;
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
            <span className="shrink-0 text-xs font-normal text-foreground-subtlest">⌘ N</span>
          </button>
          {/* 主内容区全页视图导航:自动化/搜索/技能/MCP/统计/图谱 */}
          {(
            [
              { view: 'search', label: '搜索', icon: Search, kbd: '⌘ K', title: '搜索 (⌘ K)' },
              { view: 'automation', label: '自动化', icon: CalendarClock, title: '自动化' },
              { view: 'skills', label: '技能', icon: WandSparkles, title: '技能' },
              { view: 'mcp', label: 'MCP', icon: Boxes, title: 'MCP 工具' },
              { view: 'stats', label: '统计', icon: BarChart3, title: '用量统计' },
              { view: 'graph', label: '图谱', icon: Waypoints, title: '知识图谱' },
            ] as const
          ).map((item) => (
            <button
              key={item.view}
              type="button"
              onClick={() => onOpenView?.(item.view)}
              className={cn(
                'flex h-8 w-full shrink-0 cursor-pointer items-center gap-2 overflow-hidden rounded-lg pl-2.5 pr-2.5 text-left transition-colors hover:bg-surface-hover hover:text-foreground',
                activeView === item.view && 'bg-surface-hover text-brand'
              )}
              title={item.title}
            >
              <item.icon className="size-4 shrink-0" />
              <span className="min-w-0 flex-1 truncate text-[13px]">{item.label}</span>
              {'kbd' in item && (
                <span className="shrink-0 text-xs font-normal text-foreground-subtlest">
                  {item.kbd}
                </span>
              )}
            </button>
          ))}
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
            <div className="relative">
              <Button
                variant="ghost"
                size="icon-xs"
                className="shrink-0 text-foreground-subtle hover:text-foreground"
                aria-label="筛选和排序"
                title="筛选和排序"
                onClick={(e) => {
                  e.stopPropagation();
                  setSortMenuOpen((o) => !o);
                }}
              >
                <ListFilter className="size-3.5" />
              </Button>
              {sortMenuOpen && (
                <div
                  className="fixed bottom-full left-0 z-50 mb-2 min-w-[160px] rounded-lg border border-border bg-popover p-1 text-[13px] text-popover-foreground shadow-lg"
                  onClick={(e) => e.stopPropagation()}
                >
                  <div className="px-2 py-1 text-xs font-medium text-foreground-subtlest">排序方式</div>
                  {([
                    ['recent', '最近优先'],
                    ['name', '按名称'],
                  ] as const).map(([mode, label]) => (
                    <button
                      key={mode}
                      type="button"
                      className={cn(
                        'flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left transition-colors hover:bg-surface-hover',
                        sortMode === mode && 'text-brand'
                      )}
                      onClick={() => {
                        setSortMode(mode);
                        setSortMenuOpen(false);
                      }}
                    >
                      {label}
                      {sortMode === mode && <ChevronDown className="size-3.5 -rotate-90" />}
                    </button>
                  ))
                  }
                </div>
              )}
            </div>
            <Button
              variant="ghost"
              size="icon-xs"
              className={cn(
                'shrink-0 text-foreground-subtle hover:text-foreground',
                archiveOpen && 'text-brand'
              )}
              aria-label="归档"
              title="归档"
              onClick={() => setArchiveOpen((o) => !o)}
            >
              <Archive className="size-3.5" />
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
                  className={cn(
                    'group flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] transition-colors hover:bg-surface-hover',
                    active === w.id && 'bg-surface-hover'
                  )}
                  onClick={() => {
                    setActive(w.id);
                    onNavigate?.();
                  }}
                  onContextMenu={(e) => openContextMenu(e, w)}
                >
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
            <Section
              title={activeWs ? projectName(activeWs) : '任务'}
              open={taskOpen}
              onToggle={() => setTaskOpen((o) => !o)}
              onAdd={() => {
                void onNewTask();
              }}
              addLabel="新建任务"
            >
              <ConversationList onNavigate={onNavigate} sortMode={sortMode} archiveOpen={archiveOpen} />
            </Section>
          )}
        </div>
      </div>
      {/* 花费统计(右侧;token 用量不再在此显示,任务行/项目徽章/Composer 用量环仍保留) */}
      {(() => {
        const totals = sumSessionUsage(activeSessions);
        if (totals.cost <= 0) return null;
        const fmtCost = totals.cost < 0.01
          ? `$${totals.cost.toFixed(4)}`
          : `$${totals.cost.toFixed(2)}`;
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
            aria-label="移动端远程控制"
            title="移动端远程控制"
            onClick={() => setMobileConnectOpen(true)}
          >
            <Smartphone className="size-4" />
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
