import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { lazy, Suspense, useEffect, useRef, useState, type PointerEvent } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  CalendarClock,
  CircleHelp,
  Loader2,
  PanelLeftClose,
  PanelRight,
  SquareTerminal,
  X,
} from 'lucide-react';
import { connectLoop } from '../../lib/connection';
import { useIsMobile } from '../../hooks/useIsMobile';
import { useSpeechOutput } from '../../hooks/useSpeechOutput';
import { WorkspaceSidebar } from './WorkspaceSidebar';
import { AutomationPanel } from './AutomationPanel';
import { SearchView } from './SearchView';
import { SkillsView } from './SkillsView';
import { McpView } from './McpView';
import { ShortcutsView } from './ShortcutsView';
import { AgentPanel } from '../agent/AgentPanel';
// xterm / CodeMirror / recharts 体量大,按需加载并各自独立成 chunk
const TerminalPanel = lazy(() =>
  import('./TerminalPanel').then((m) => ({ default: m.TerminalPanel })),
);
const EditorPane = lazy(() =>
  import('../editor/EditorPane').then((m) => ({ default: m.EditorPane })),
);
const StatsView = lazy(() => import('./StatsView').then((m) => ({ default: m.StatsView })));
const GraphView = lazy(() => import('./GraphView').then((m) => ({ default: m.GraphView })));
import { ModalQueue } from '../agent/ModalQueue';
import { useEditorStore } from '../../stores/editorStore';
import { useActiveWorkspaceId } from '../../hooks/useActiveWorkspaceId';
import { Button } from '../ui/button';
import { cn } from '../../lib/utils';
import { HelpDialog } from './HelpDialog';

const qc = new QueryClient();

/** lazy 面板加载期间的占位 */
function PanelLoading() {
  return (
    <div className="flex min-h-0 w-full flex-1 items-center justify-center text-sm text-foreground-subtle">
      加载中…
    </div>
  );
}

const SIDEBAR_MIN = 264;
const SIDEBAR_DEFAULT = 372;

/** 主内容区视图;automation/search/skills/mcp/stats/graph/shortcuts 为全页独立视图(侧边栏可导航) */
export type AppView =
  | 'agent'
  | 'terminal'
  | 'editor'
  | 'automation'
  | 'search'
  | 'skills'
  | 'mcp'
  | 'stats'
  | 'graph'
  | 'shortcuts';

/** 侧边栏导航按钮对应的全页视图 */
export type SideView = Extract<
  AppView,
  'automation' | 'search' | 'skills' | 'mcp' | 'stats' | 'graph' | 'shortcuts'
>;

export function AppShell() {
  useEffect(() => {
    void connectLoop();
  }, []);

  return (
    <QueryClientProvider client={qc}>
      <AppShellInner />
    </QueryClientProvider>
  );
}

function AppShellInner() {
  const { modelProgress } = useSpeechOutput();
  const workspaceId = useActiveWorkspaceId();
  const resetOpenFiles = useEditorStore((s) => s.resetOpenFiles);

  // 切换项目时清空编辑器里打开的文件
  useEffect(() => {
    resetOpenFiles();
  }, [workspaceId, resetOpenFiles]);

  const [width, setWidth] = useState(SIDEBAR_DEFAULT);
  // 移动端默认收起侧边栏(抽屉);桌面保持展开
  const [collapsed, setCollapsed] = useState(
    () => typeof window === 'undefined' || window.innerWidth < 768
  );
  const [view, setView] = useState<AppView>('agent');
  // 面板首次切换过去才挂载(lazy 按需拉取 + 查询延迟发起),挂载后保持不卸载以保留状态
  const [paneMounted, setPaneMounted] = useState<
    Record<'terminal' | 'editor' | SideView, boolean>
  >({
    terminal: false,
    editor: false,
    automation: false,
    search: false,
    skills: false,
    mcp: false,
    stats: false,
    graph: false,
    shortcuts: false,
  });
  const [helpOpen, setHelpOpen] = useState(false);

  useEffect(() => {
    if (view === 'agent') return;
    setPaneMounted((p) => (p[view] ? p : { ...p, [view]: true }));
  }, [view]);
  const dragRef = useRef<{ startX: number; startW: number } | null>(null);
  const isMobile = useIsMobile();

  // 进入移动端时自动收起,避免抽屉默认盖住内容
  useEffect(() => {
    if (isMobile) setCollapsed(true);
  }, [isMobile]);

  function onHandleDown(e: PointerEvent<HTMLDivElement>) {
    dragRef.current = { startX: e.clientX, startW: width };
    const onMove = (ev: globalThis.PointerEvent) => {
      if (!dragRef.current) return;
      const d = ev.clientX - dragRef.current.startX;
      const max = Math.round(window.innerWidth * 0.5);
      setWidth(Math.min(max, Math.max(SIDEBAR_MIN, dragRef.current.startW + d)));
    };
    const onUp = () => {
      dragRef.current = null;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  return (
    <div className="relative flex h-dvh flex-col overflow-hidden bg-background-alt text-foreground">
      <div className="relative flex min-h-0 flex-1">
        {/* 侧边栏:桌面为可拖拽宽度,移动端为全屏抽屉 */}
        {isMobile ? (
          !collapsed && (
            <>
              <div
                className="fixed inset-0 z-30 bg-black/50"
                onClick={() => setCollapsed(true)}
                aria-hidden
              />
              <div className="fixed inset-y-0 left-0 z-40 flex w-[86vw] max-w-[380px] flex-col border-r border-border bg-background-alt shadow-2xl">
                <div className="flex h-12 shrink-0 items-center justify-end pr-2">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="收起侧边栏"
                    title="收起侧边栏"
                    onClick={() => setCollapsed(true)}
                  >
                    <X className="size-4" />
                  </Button>
                </div>
                <div className="min-h-0 flex-1">
                  <WorkspaceSidebar
                    onNavigate={() => {
                      setCollapsed(true);
                      // 从任意全页视图(自动化/搜索/技能/MCP/统计/图谱)回到会话
                      if (view !== 'agent' && view !== 'terminal' && view !== 'editor')
                        setView('agent');
                    }}
                    onOpenView={(v) => {
                      setCollapsed(true);
                      setView(v);
                    }}
                    activeView={view}
                  />
                </div>
              </div>
            </>
          )
        ) : (
          <>
            <div
              data-panel="sidebar"
              className={cn(
                'flex-none overflow-hidden transition-[width,opacity] duration-200 ease-out',
                collapsed && 'w-0 opacity-0'
              )}
              style={{ width: collapsed ? undefined : width }}
            >
              <WorkspaceSidebar
                onNavigate={() => {
                  // 从任意全页视图(自动化/搜索/技能/MCP/统计/图谱)回到会话
                  if (view !== 'agent' && view !== 'terminal' && view !== 'editor')
                    setView('agent');
                }}
                onOpenView={(v) => setView(v)}
                activeView={view}
              />
            </div>
            {/* 调整侧边栏宽度 */}
            {!collapsed && (
              <div
                role="separator"
                tabIndex={0}
                aria-orientation="vertical"
                aria-label="调整侧边栏宽度"
                onPointerDown={onHandleDown}
                className="group/handle relative z-10 my-6 flex w-px shrink-0 cursor-ew-resize touch-none items-center justify-center bg-transparent outline-none transition-colors hover:bg-border-hover/60 focus-visible:bg-border-hover/60"
              />
            )}
          </>
        )}
        {/* 顶栏悬浮层:侧边栏开关 + 后退/前进 */}
        <div className="pointer-events-none absolute left-0 top-0 z-20 flex h-14 items-center pl-2 pt-1">
          <div className="pointer-events-auto flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => setCollapsed((c) => !c)}
              aria-label="切换侧边栏"
              title={collapsed ? '展开侧边栏' : '收起侧边栏'}
            >
              <PanelLeftClose className="size-4" />
            </Button>
            {!isMobile && !collapsed && (
              <>
                <Button variant="ghost" size="icon-sm" disabled aria-label="后退" title="后退">
                  <ArrowLeft className="size-4" />
                </Button>
                <Button variant="ghost" size="icon-sm" disabled aria-label="前进" title="前进">
                  <ArrowRight className="size-4" />
                </Button>
              </>
            )}
          </div>
        </div>
        {/* 主内容区 */}
        <div data-panel="content" className="flex min-w-0 flex-1 flex-col p-1 pl-0 pt-0">
          <div className="h-1 w-full" />
          <section className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-background">
            <header className="relative flex h-10 shrink-0 items-center justify-end gap-0.5 pr-2.5">
              {modelProgress != null && (
                <div
                  className="mr-auto flex items-center gap-1.5 pl-2 text-[11px] tabular-nums text-foreground-subtle"
                  title="语音朗读模型下载中"
                >
                  <Loader2 className="size-3 animate-spin" />
                  朗读模型 {Math.round(modelProgress * 100)}%
                </div>
              )}
              <Button variant="ghost" size="icon-sm" aria-label="帮助" title="帮助"
                onClick={() => setHelpOpen(true)}
              >
                <CircleHelp className="size-4" />
              </Button>
              <Button variant="ghost" size="icon-sm" aria-label="自动化" title="自动化"
                onClick={() => setView('automation')}
                className={cn(view === 'automation' && 'bg-surface-hover text-brand')}
              >
                <CalendarClock className="size-4" />
              </Button>
              <Button variant="ghost" size="icon-sm" aria-label="切换终端" title="切换终端"
                onClick={() => setView((v) => (v === 'terminal' ? 'agent' : 'terminal'))}
                className={cn(view === 'terminal' && 'bg-surface-hover text-brand')}
              >
                <SquareTerminal className="size-4" />
              </Button>
              <Button variant="ghost" size="icon-sm" aria-label="切换文件编辑器" title="切换文件编辑器"
                onClick={() => setView((v) => (v === 'editor' ? 'agent' : 'editor'))}
                className={cn(view === 'editor' && 'bg-surface-hover text-brand')}
              >
                <PanelRight className="size-4" />
              </Button>
            </header>
            <div className="relative flex min-h-0 flex-1">
              <div className={cn('flex min-h-0 w-full flex-1', view !== 'agent' && 'hidden')}>
                <AgentPanel workspaceId={workspaceId} />
              </div>
              <div className={cn('flex min-h-0 w-full flex-1', view !== 'terminal' && 'hidden')}>
                {paneMounted.terminal && (
                  <Suspense fallback={<PanelLoading />}>
                    <TerminalPanel workspaceId={workspaceId} onClose={() => setView('agent')} />
                  </Suspense>
                )}
              </div>
              <div className={cn('flex min-h-0 w-full flex-1', view !== 'automation' && 'hidden')}>
                {paneMounted.automation && <AutomationPanel />}
              </div>
              <div className={cn('flex min-h-0 w-full flex-1', view !== 'search' && 'hidden')}>
                {paneMounted.search && <SearchView onNavigate={() => setView('agent')} />}
              </div>
              <div className={cn('flex min-h-0 w-full flex-1', view !== 'skills' && 'hidden')}>
                {paneMounted.skills && <SkillsView />}
              </div>
              <div className={cn('flex min-h-0 w-full flex-1', view !== 'mcp' && 'hidden')}>
                {paneMounted.mcp && <McpView />}
              </div>
              <div className={cn('flex min-h-0 w-full flex-1', view !== 'stats' && 'hidden')}>
                {paneMounted.stats && (
                  <Suspense fallback={<PanelLoading />}>
                    <StatsView />
                  </Suspense>
                )}
              </div>
              <div className={cn('flex min-h-0 w-full flex-1', view !== 'graph' && 'hidden')}>
                {paneMounted.graph && (
                  <Suspense fallback={<PanelLoading />}>
                    <GraphView
                      workspaceId={workspaceId}
                      onOpenInEditor={() => setView('editor')}
                    />
                  </Suspense>
                )}
              </div>
              <div className={cn('flex min-h-0 w-full flex-1', view !== 'shortcuts' && 'hidden')}>
                {paneMounted.shortcuts && <ShortcutsView />}
              </div>
              <div className={cn('flex min-h-0 w-full flex-1', view !== 'editor' && 'hidden')}>
                {workspaceId ? (
                  paneMounted.editor && (
                    <Suspense fallback={<PanelLoading />}>
                      <EditorPane workspaceId={workspaceId} isActive={view === 'editor'} />
                    </Suspense>
                  )
                ) : (
                  <AgentPanel workspaceId={workspaceId} />
                )}
              </div>
            </div>
          </section>
        </div>
      </div>
      {workspaceId && <ModalQueue workspaceId={workspaceId} />}
      <HelpDialog open={helpOpen} onOpenChange={setHelpOpen} />
    </div>
  );
}
