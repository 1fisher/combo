import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { ArrowLeft, ArrowRight, CircleHelp, PanelLeftClose, PanelRight, SquareTerminal } from 'lucide-react';
import { connectLoop } from '../../lib/connection';
import { WorkspaceSidebar } from './WorkspaceSidebar';
import { AgentPanel } from '../agent/AgentPanel';
import { TerminalPanel } from './TerminalPanel';
import { EditorPane } from '../editor/EditorPane';
import { ModalQueue } from '../agent/ModalQueue';
import { useEditorStore } from '../../stores/editorStore';
import { useActiveWorkspaceId } from '../../hooks/useActiveWorkspaceId';
import { Button } from '../ui/button';
import { cn } from '../../lib/utils';

const qc = new QueryClient();

const SIDEBAR_MIN = 264;
const SIDEBAR_DEFAULT = 372;
const EDITOR_MIN = 360;
const EDITOR_DEFAULT = 680;

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
  const workspaceId = useActiveWorkspaceId();
  const resetOpenFiles = useEditorStore((s) => s.resetOpenFiles);

  // 切换项目时清空编辑器里打开的文件
  useEffect(() => {
    resetOpenFiles();
  }, [workspaceId, resetOpenFiles]);

  const [width, setWidth] = useState(SIDEBAR_DEFAULT);
  const [collapsed, setCollapsed] = useState(false);
  const [view, setView] = useState<'agent' | 'terminal'>('agent');
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorWidth, setEditorWidth] = useState(EDITOR_DEFAULT);
  const dragRef = useRef<{ startX: number; startW: number } | null>(null);
  const editorDragRef = useRef<{ startX: number; startW: number } | null>(null);

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

  function onEditorHandleDown(e: PointerEvent<HTMLDivElement>) {
    editorDragRef.current = { startX: e.clientX, startW: editorWidth };
    const onMove = (ev: globalThis.PointerEvent) => {
      if (!editorDragRef.current) return;
      // 向左拖 → 增大编辑器宽度
      const d = editorDragRef.current.startX - ev.clientX;
      const max = Math.round(window.innerWidth * 0.6);
      setEditorWidth(Math.min(max, Math.max(EDITOR_MIN, editorDragRef.current.startW + d)));
    };
    const onUp = () => {
      editorDragRef.current = null;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  return (
    <div className="relative flex h-dvh flex-col overflow-hidden bg-background-alt text-foreground">
      <div className="relative flex min-h-0 flex-1">
        {/* 侧边栏 */}
        <div
          data-panel="sidebar"
          className={cn(
            'flex-none overflow-hidden transition-[width,opacity] duration-200 ease-out',
            collapsed && 'w-0 opacity-0'
          )}
          style={{ width: collapsed ? undefined : width }}
        >
          <WorkspaceSidebar />
        </div>
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
            {!collapsed && (
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
        {/* 主内容区 */}
        <div data-panel="content" className="flex min-w-0 flex-1 flex-col p-1 pl-0 pt-0">
          <div className="h-1 w-full" />
          <section className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-background">
            <header className="relative flex h-10 shrink-0 items-center justify-end gap-0.5 pr-2.5">
              <Button variant="ghost" size="icon-sm" aria-label="帮助" title="帮助">
                <CircleHelp className="size-4" />
              </Button>
              <Button variant="ghost" size="icon-sm" aria-label="切换终端" title="切换终端"
                onClick={() => setView((v) => (v === 'terminal' ? 'agent' : 'terminal'))}
                className={cn(view === 'terminal' && 'bg-surface-hover text-brand')}
              >
                <SquareTerminal className="size-4" />
              </Button>
              <Button variant="ghost" size="icon-sm" aria-label="切换文件编辑器" title="切换文件编辑器"
                onClick={() => setEditorOpen((o) => !o)}
                className={cn(editorOpen && 'bg-surface-hover text-brand')}
              >
                <PanelRight className="size-4" />
              </Button>
            </header>
            <div className="flex min-h-0 flex-1">
              {view === 'terminal' ? (
                <TerminalPanel workspaceId={workspaceId} onClose={() => setView('agent')} />
              ) : (
                <AgentPanel workspaceId={workspaceId} />
              )}
            </div>
          </section>
        </div>
        {/* 调整编辑器宽度 */}
        {workspaceId && editorOpen && (
          <div
            role="separator"
            tabIndex={0}
            aria-orientation="vertical"
            aria-label="调整文件编辑器宽度"
            onPointerDown={onEditorHandleDown}
            className="group/ehandle relative z-10 my-6 flex w-px shrink-0 cursor-ew-resize touch-none items-center justify-center bg-transparent outline-none transition-colors hover:bg-border-hover/60 focus-visible:bg-border-hover/60"
          />
        )}
        {/* 文件编辑器面板 */}
        <div
          className={cn(
            'flex-none overflow-hidden transition-[width,opacity] duration-200 ease-out',
            !(workspaceId && editorOpen) && 'w-0 opacity-0'
          )}
          style={{ width: workspaceId && editorOpen ? editorWidth : undefined }}
        >
          {workspaceId && <EditorPane workspaceId={workspaceId} width={editorWidth} />}
        </div>
      </div>
      {workspaceId && <ModalQueue workspaceId={workspaceId} />}
    </div>
  );
}
