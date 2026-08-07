import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Archive,
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
  RefreshCw,
  Search,
  Settings,
  Smartphone,
  Trash2,
  WandSparkles,
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
import { useWorkspaces } from '../../hooks/useWorkspaces';
import { useSessions } from '../../hooks/useSessions';
import { useActiveWorkspaceId } from '../../hooks/useActiveWorkspaceId';
import { useAgentStore } from '../../stores/agentStore';
import { useConnectionStore } from '../../stores/connectionStore';
import { ensureCrush } from '../../lib/api';
import { isTauri } from '../../lib/connection';
import { confirmDialog } from '../../lib/confirm';
import { ConversationList } from './ConversationList';
import { SessionRow } from './SessionRow';
import { SkillsPanel } from './SkillsPanel';
import { DirectoryPicker } from './DirectoryPicker';
import { SettingsDialog } from './SettingsDialog';

function basename(p: string): string {
  const clean = p.replace(/[\\/]+$/, '');
  const idx = Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\'));
  return idx >= 0 ? clean.slice(idx + 1) : clean;
}

/** 项目名:优先后端返回的 name,回退到目录 basename。 */
function projectName(w: { name?: string; path: string }): string {
  return w.name && w.name.trim() ? w.name : basename(w.path);
}

const BACKEND_LABEL: Record<string, string> = {
  crush: 'Crush',
  opencode: 'OpenCode',
  claude_code: 'Claude Code',
  codex: 'Codex',
};

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

/** 分组视图:每个项目一个分区,展开其下的任务 */
function WorkspaceGroup({
  ws,
  onContextMenu,
  onContextMenuAt,
  onNavigate,
}: {
  ws: { id: string; name?: string; path: string };
  onContextMenu: (e: React.MouseEvent, ws: { id: string; name?: string; path: string }) => void;
  onContextMenuAt: (x: number, y: number, ws: { id: string; name?: string; path: string }) => void;
  onNavigate?: () => void;
}) {
  const [open, setOpen] = useState(true);
  const { sessions, activate, remove, rename } = useSessions(ws.id);
  const setActive = useAgentStore((s) => s.setActiveWorkspace);
  const activeSessionId = useAgentStore((s) => s.activeSessionId);

  return (
    <section className="group/section" aria-label={projectName(ws)}>
      <div className="flex h-7 min-w-0 items-center">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          onContextMenu={(e) => onContextMenu(e, ws)}
          aria-expanded={open}
          className="flex h-7 min-w-0 flex-1 items-center gap-1.5 px-2.5 text-left text-[13px] font-medium text-foreground-subtlest outline-none transition-colors hover:text-foreground"
        >
          <Folder className="size-3.5 shrink-0 text-foreground-subtlest" />
          <span className="min-w-0 truncate">{projectName(ws)}</span>
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            onContextMenuAt(
              Math.min(r.right - 140, window.innerWidth - 150),
              r.bottom + 4,
              ws
            );
          }}
          aria-label="更多操作"
          title="更多操作"
          className="shrink-0 rounded-md p-1 text-foreground-subtle md:hidden hover:bg-surface-hover hover:text-foreground"
        >
          <MoreHorizontal className="size-3.5" />
        </button>
      </div>
      {open && (
        <div className="pb-1">
          {sessions?.map((s) => (
            <SessionRow
              key={s.id}
              session={s}
              isActive={activeSessionId === s.id}
              rowClassName="pl-7"
              showTime={false}
              iconClassName="text-foreground-subtlest"
              onActivate={() => {
                setActive(ws.id);
                void activate(s.id);
                onNavigate?.();
              }}
              onRename={(title) => rename({ id: s.id, title })}
              onDelete={() =>
                void confirmDialog('确定删除此会话?').then((ok) => {
                  if (ok) void remove(s.id);
                })
              }
            />
          ))}
          {!sessions?.length && (
            <div className="px-7 py-1.5 text-[13px] text-foreground-subtle">还没有任务</div>
          )}
        </div>
      )}
    </section>
  );
}

export function WorkspaceSidebar({ onNavigate }: { onNavigate?: () => void } = {}) {
  const { workspaces, isLoading, create, rename, changePath, remove } = useWorkspaces();
  const active = useActiveWorkspaceId();
  const setActive = useAgentStore((s) => s.setActiveWorkspace);
  const connStatus = useConnectionStore((s) => s.status);
  const {
    sessions: activeSessions,
    create: createSessionIn,
    activate: activateSession,
  } = useSessions(active);

  const [tab, setTab] = useState<'grouped' | 'project'>('project');
  const [projOpen, setProjOpen] = useState(true);
  const [taskOpen, setTaskOpen] = useState(true);

  const [backend, setBackend] = useState<'crush' | 'opencode' | 'claude_code' | 'codex'>('crush');
  // 服务器目录选择器(浏览器/移动端):add=添加项目,change=更换目录
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerMode, setPickerMode] = useState<'add' | 'change'>('add');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState('');
  const [sidebarError, setSidebarError] = useState<string | null>(null);
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
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
  // 手动重启 crush
  const [restarting, setRestarting] = useState(false);
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

  // ⌘/Ctrl+N 新建任务
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        onNewTaskRef.current();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  async function onAddProjectClick() {
    setSidebarError(null);
    if (isTauri()) {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const dir = await open({ directory: true, multiple: false });
      if (typeof dir === 'string') {
        try {
          await create({ path: dir, backend });
        } catch (e) {
          setSidebarError(e instanceof Error ? e.message : String(e));
        }
      }
      return;
    }
    // 浏览器/移动端:打开服务器目录选择器(内含手动输入兑底)
    setPickerMode('add');
    setPickerOpen(true);
  }

  async function onNewTask() {
    setSidebarError(null);
    if (!active) {
      setSidebarError('请先在「项目」分区添加/选择一个项目');
      return;
    }
    const base = `会话 ${(activeSessions?.length ?? 0) + 1}`;
    try {
      const s = await createSessionIn(base);
      void activateSession(s.id);
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

  async function restartCrush() {
    setRestarting(true);
    setSidebarError(null);
    try {
      const r = await ensureCrush();
      if (!r.healthy) {
        setSidebarError('crush 重启后仍不可用,请检查 crush 是否已安装');
      }
    } catch (e) {
      setSidebarError(e instanceof Error ? e.message : String(e));
    } finally {
      setRestarting(false);
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
      await changePath({ id: pathTarget.id, path: p });
      setPathTarget(null);
      setPathDraft2('');
    } catch (e) {
      setSidebarError(e instanceof Error ? e.message : String(e));
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

  const connLabel =
    connStatus === 'connected' ? '已连接' : connStatus === 'connecting' ? '连接中' : '离线';

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
          <button
            type="button"
            className="flex h-8 w-full shrink-0 cursor-pointer items-center gap-2 overflow-hidden rounded-lg pl-2.5 pr-2.5 text-left transition-colors hover:bg-surface-hover hover:text-foreground"
            title="搜索 (⌘ K)"
          >
            <Search className="size-4 shrink-0" />
            <span className="min-w-0 flex-1 truncate text-[13px]">搜索</span>
            <span className="shrink-0 text-xs font-normal text-foreground-subtlest">⌘ K</span>
          </button>
          <button
            type="button"
            className="flex h-8 w-full shrink-0 cursor-pointer items-center gap-2 overflow-hidden rounded-lg pl-2.5 pr-2.5 text-left transition-colors hover:bg-surface-hover hover:text-foreground"
            title="自动化"
          >
            <CalendarClock className="size-4 shrink-0" />
            <span className="min-w-0 flex-1 truncate text-[13px]">自动化</span>
          </button>
          <button
            type="button"
            onClick={() => setSkillsOpen(true)}
            className="flex h-8 w-full shrink-0 cursor-pointer items-center gap-2 overflow-hidden rounded-lg pl-2.5 pr-2.5 text-left transition-colors hover:bg-surface-hover hover:text-foreground"
            title="技能"
          >
            <WandSparkles className="size-4 shrink-0" />
            <span className="min-w-0 flex-1 truncate text-[13px]">技能</span>
          </button>
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
                tab === 'grouped' ? 'left-0.5 w-[58px]' : 'left-[62px] w-[58px]'
              )}
            />
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'grouped'}
              onClick={() => setTab('grouped')}
              className={cn(
                'relative z-10 flex h-6 flex-none items-center gap-1 rounded-full py-0 pl-1.5 pr-2 text-[13px] font-medium transition-colors',
                tab === 'grouped' ? 'text-foreground' : 'text-foreground-subtle hover:text-foreground'
              )}
            >
              <Hash className="size-3 shrink-0" />
              <span>分组</span>
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
              aria-label="展开全部"
              title="展开全部"
            >
              <Maximize2 className="size-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              className="shrink-0 text-foreground-subtle hover:text-foreground"
              aria-label="筛选和排序"
              title="筛选和排序"
            >
              <ListFilter className="size-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              className="shrink-0 text-foreground-subtle hover:text-foreground"
              aria-label="归档"
              title="归档"
            >
              <Archive className="size-3.5" />
            </Button>
          </div>
        </div>
        {/* 分区列表 */}
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-2 pt-3">
          {tab === 'project' ? (
            <>
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
                        <span className="shrink-0 rounded-full border border-border bg-surface px-1.5 py-px text-[11px] leading-normal text-foreground-subtle">
                          {BACKEND_LABEL[w.backend ?? 'crush'] ?? w.backend}
                        </span>
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
              <Section
                title="任务"
                open={taskOpen}
                onToggle={() => setTaskOpen((o) => !o)}
                onAdd={() => {
                  void onNewTask();
                }}
                addLabel="新建任务"
              >
                <ConversationList onNavigate={onNavigate} />
              </Section>
            </>
          ) : (
            workspaces?.map((w) => (
              <WorkspaceGroup
                key={w.id}
                ws={w}
                onContextMenu={openContextMenu}
                onContextMenuAt={openContextMenuAt}
                onNavigate={onNavigate}
              />
            ))
          )}
          {!isLoading && tab === 'grouped' && workspaces?.length === 0 && (
            <div className="px-3 py-2 text-[13px] leading-relaxed text-foreground-subtle">
              还没有项目,切换到「项目」视图添加。
            </div>
          )}
          {sidebarError && (
            <div className="mx-2 rounded-lg bg-destructive/10 px-2.5 py-1.5 text-xs text-destructive">
              {sidebarError}
            </div>
          )}
        </div>
      </div>
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
              combo
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
          {connStatus !== 'connected' && (
            <Button
              variant="ghost"
              size="icon-sm"
              className="shrink-0 text-foreground-subtle hover:bg-surface-hover hover:text-foreground"
              aria-label="重启 crush 服务"
              title="重启 crush 服务"
              onClick={() => void restartCrush()}
              disabled={restarting}
            >
              <RefreshCw className={cn('size-4', restarting && 'animate-spin')} />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon-sm"
            className="shrink-0 text-foreground-subtle hover:bg-surface-hover hover:text-foreground"
            aria-label="移动端远程控制"
            title="移动端远程控制"
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
      <SkillsPanel open={skillsOpen} onOpenChange={setSkillsOpen} />
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
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
        <DialogContent showCloseButton={false}>
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
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>更换目录</DialogTitle>
            <DialogDescription>
              为「{pathTarget?.name}」指定新的绑定目录。更换后,将重新注册到 crush;
              会话记录会保留并迁移到新 workspace。
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
        backend={pickerMode === 'add' ? backend : undefined}
        onBackendChange={(b) =>
          setBackend(b as 'crush' | 'opencode' | 'claude_code' | 'codex')
        }
        onOpenChange={setPickerOpen}
        onSelect={(path) => {
          setPickerOpen(false);
          if (pickerMode === 'add') {
            setSidebarError(null);
            void create({ path, backend })
              .then((w) => {
                setActive(w.id);
                onNavigate?.();
              })
              .catch((e) => setSidebarError(e instanceof Error ? e.message : String(e)));
          } else {
            setPathDraft2(path);
          }
        }}
      />
    </aside>
  );
}
