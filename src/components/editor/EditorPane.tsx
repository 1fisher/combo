import { useCallback, useEffect, useRef, useState, type PointerEvent } from 'react';
import { Eye, Folder, GitBranch, History, PanelLeft, Pencil, Search, X } from 'lucide-react';
import { EditorView } from '@codemirror/view';
import { openSearchPanel } from '@codemirror/search';
import { getFileContent, getGitFileAtHead, putFileContent } from '../../lib/api';
import { useEditorStore, type FileKind } from '../../stores/editorStore';
import { getProxyBaseUrl } from '../../lib/connection';
import { getClientId } from '../../lib/clientId';
import { useIsMobile } from '../../hooks/useIsMobile';
import { cn } from '../../lib/utils';
import { Button } from '../ui/button';
import { CodeEditor } from './CodeEditor';
import { DiffView } from './DiffView';
import { FileExplorer } from './FileExplorer';
import { GitGraph } from './GitGraph';
import { GitPanel } from './GitPanel';
import { ImageViewer } from './ImageViewer';
import { MarkdownPreview } from './MarkdownPreview';

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.ico']);
const MD_EXTS = new Set(['.md', '.markdown', '.mdx']);

/** 文件/Git 侧边栏宽度限制 */
const FILE_SIDEBAR_MIN = 180;
const FILE_SIDEBAR_DEFAULT = 240;

function isMarkdown(name: string): boolean {
  const lower = name.toLowerCase();
  const idx = lower.lastIndexOf('.');
  return idx >= 0 && MD_EXTS.has(lower.slice(idx));
}

function fileKindOf(name: string): FileKind {
  const lower = name.toLowerCase();
  const idx = lower.lastIndexOf('.');
  const ext = idx >= 0 ? lower.slice(idx) : '';
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (ext === '.pdf') return 'pdf';
  return 'text';
}

function fileUrl(workspaceId: string, path: string): string {
  const base = getProxyBaseUrl();
  const q = new URLSearchParams({ client_id: getClientId(), path });
  return `${base}/v1/workspaces/${workspaceId}/files/raw?${q.toString()}`;
}

/**
 * 右侧编辑器面板:文件目录树 / Git 面板 + 打开文件 tabs + 行号 + 编辑器 + 保存。
 * 移动端下文件/Git 面板变为从左侧滑出的抽屉,编辑器全宽显示。
 */
export function EditorPane({ workspaceId }: { workspaceId: string }) {
  const openFiles = useEditorStore((s) => s.openFiles);
  const activePath = useEditorStore((s) => s.activePath);
  const setActive = useEditorStore((s) => s.setActive);
  const setContent = useEditorStore((s) => s.setContent);
  const closeFile = useEditorStore((s) => s.closeFile);
  const markSaved = useEditorStore((s) => s.markSaved);
  const openFileInStore = useEditorStore((s) => s.openFile);
  const setHeadContent = useEditorStore((s) => s.setHeadContent);

  const isMobile = useIsMobile();
  const [sidebarMode, setSidebarMode] = useState<'files' | 'git'>('files');
  const [gitSubView, setGitSubView] = useState<'changes' | 'history'>('changes');
  /** 当前选中的 git 仓库(相对 workspace 根目录的路径,空串表示根仓库) */
  const [activeGitRepo, setActiveGitRepo] = useState('');
  /** 移动端文件/Git 抽屉开关 */
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [diffPath, setDiffPath] = useState<string | null>(null);
  const [commitDiff, setCommitDiff] = useState<{ hash: string; path: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** markdown 文件是否处于预览模式 */
  const [mdPreview, setMdPreview] = useState(true);
  /** 搜索高亮关键词(从文件搜索结果带入,用于编辑器内高亮) */
  const [highlightQuery, setHighlightQuery] = useState<string | null>(null);
  /** 搜索结果定位行号(打开后跳转并高亮该行) */
  const [highlightLine, setHighlightLine] = useState<number | null>(null);
  /** 编辑器视图引用(用于打开文件内搜索面板) */
  const editorViewRef = useRef<EditorView | null>(null);

  /** 文件/Git 侧边栏宽度(桌面端可拖拽) */
  const [fileSidebarW, setFileSidebarW] = useState(FILE_SIDEBAR_DEFAULT);
  const fileDragRef = useRef<{ startX: number; startW: number } | null>(null);

  function onFileHandleDown(e: PointerEvent<HTMLDivElement>) {
    fileDragRef.current = { startX: e.clientX, startW: fileSidebarW };
    const onMove = (ev: globalThis.PointerEvent) => {
      if (!fileDragRef.current) return;
      const d = ev.clientX - fileDragRef.current.startX;
      const max = Math.round(window.innerWidth * 0.4);
      setFileSidebarW(Math.min(max, Math.max(FILE_SIDEBAR_MIN, fileDragRef.current.startW + d)));
    };
    const onUp = () => {
      fileDragRef.current = null;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  const active = openFiles.find((f) => f.path === activePath) ?? null;

  // 切换文件时重置为预览模式
  useEffect(() => {
    setMdPreview(true);
  }, [activePath]);

  // 切换工作区时重置选中的 git 仓库
  useEffect(() => {
    setActiveGitRepo('');
  }, [workspaceId]);

  // 移动端:无打开文件时自动展开文件树抽屉,引导选择文件
  useEffect(() => {
    if (isMobile && openFiles.length === 0) setSidebarOpen(true);
  }, [isMobile, openFiles.length]);

  const handleOpenFile = useCallback(
    async (filePath: string, name: string, line?: number) => {
      setLoadError(null);
      setDiffPath(null);
      setSidebarOpen(false); // 移动端选文件后收起抽屉
      // 从搜索结果打开时带入行号
      setHighlightLine(line ?? null);
      const kind = fileKindOf(name);
      try {
        if (kind === 'text') {
          const { content } = await getFileContent(workspaceId, filePath);
          openFileInStore(filePath, name, content, kind);
          // 异步获取 HEAD 内容用于 git gutter(失败时静默忽略)
          try {
            const { content: headContent } = await getGitFileAtHead(workspaceId, filePath);
            setHeadContent(filePath, headContent);
          } catch {
            setHeadContent(filePath, null);
          }
        } else {
          openFileInStore(filePath, name, '', kind);
        }
      } catch (e) {
        setLoadError(e instanceof Error ? e.message : String(e));
      }
    },
    [workspaceId, openFileInStore, setHeadContent],
  );

  function handleShowDiff(filePath: string) {
    setDiffPath(filePath);
    setCommitDiff(null);
    setSidebarOpen(false); // 移动端选中 diff 后收起抽屉
  }

  function handleShowCommitDiff(hash: string, path: string) {
    setCommitDiff({ hash, path });
    setDiffPath(null);
    setSidebarOpen(false); // 移动端选中提交 diff 后收起抽屉
  }

  async function save() {
    if (!active || !active.dirty || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      await putFileContent(workspaceId, active.path, active.content);
      markSaved(active.path, active.content);
      // 保存后刷新 HEAD 内容(gutter 基准更新)
      try {
        const { content: headContent } = await getGitFileAtHead(workspaceId, active.path);
        setHeadContent(active.path, headContent);
      } catch {
        /* ignore */
      }
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  // Cmd/Ctrl+S 保存
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void save();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // git 模式下右侧显示 diff 或 graph;否则显示编辑器
  const showDiff = sidebarMode === 'git' && gitSubView === 'changes' && diffPath !== null;
  const showCommitDiff = sidebarMode === 'git' && gitSubView === 'history' && commitDiff !== null;
  const showGraphPlaceholder = sidebarMode === 'git' && gitSubView === 'history' && commitDiff === null;

  // 文件 / Git 侧边栏主体(文件|Git 切换 + 内容),桌面端固定栏与移动端抽屉共用
  const sidebarBody = (
    <>
      <div className="flex shrink-0 items-center border-b">
        <button
          onClick={() => setSidebarMode('files')}
          className={cn(
            'flex flex-1 items-center justify-center gap-1.5 py-2 text-xs font-medium transition-colors',
            sidebarMode === 'files'
              ? 'border-b-2 border-primary text-foreground'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          <Folder className="h-3.5 w-3.5" />
          文件
        </button>
        <button
          onClick={() => setSidebarMode('git')}
          className={cn(
            'flex flex-1 items-center justify-center gap-1.5 py-2 text-xs font-medium transition-colors',
            sidebarMode === 'git'
              ? 'border-b-2 border-primary text-foreground'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          <GitBranch className="h-3.5 w-3.5" />
          Git
        </button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        {sidebarMode === 'files' ? (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <FileExplorer
              workspaceId={workspaceId}
              onOpenFile={handleOpenFile}
              onError={setLoadError}
              onSearchQueryChange={setHighlightQuery}
            />
          </div>
        ) : (
          <>
            {/* Git 子标签:变更 / 历史 */}
            <div className="flex shrink-0 items-center gap-1 border-b px-2 py-1">
              <button
                onClick={() => setGitSubView('changes')}
                className={cn(
                  'flex items-center gap-1 rounded px-2 py-1 text-[10px] font-medium transition-colors',
                  gitSubView === 'changes'
                    ? 'bg-accent text-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                <GitBranch className="h-3 w-3" />
                变更
              </button>
              <button
                onClick={() => setGitSubView('history')}
                className={cn(
                  'flex items-center gap-1 rounded px-2 py-1 text-[10px] font-medium transition-colors',
                  gitSubView === 'history'
                    ? 'bg-accent text-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                <History className="h-3 w-3" />
                历史
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-hidden">
              {gitSubView === 'changes' ? (
                <GitPanel
                  workspaceId={workspaceId}
                  repo={activeGitRepo}
                  onRepoChange={setActiveGitRepo}
                  selectedDiffPath={diffPath}
                  onShowDiff={handleShowDiff}
                  onOpenFile={handleOpenFile}
                />
              ) : (
                <GitGraph
                  workspaceId={workspaceId}
                  repo={activeGitRepo}
                  onShowCommitDiff={handleShowCommitDiff}
                />
              )}
            </div>
          </>
        )}
      </div>
    </>
  );

  return (
    <aside className="flex h-full w-full min-h-0 flex-col bg-card">
      {(saveError || loadError) && (
        <div className="border-b border-destructive/30 bg-destructive/10 px-3 py-1.5 text-xs text-destructive">
          {saveError || loadError}
        </div>
      )}
      <div className="relative flex min-h-0 flex-1">
        {/* 文件 / Git 面板:桌面端固定栏,移动端为从左滑出的抽屉 */}
        {isMobile ? (
          sidebarOpen && (
            <>
              <div
                className="fixed inset-0 z-30 bg-black/50"
                onClick={() => setSidebarOpen(false)}
                aria-hidden
              />
              <div className="fixed inset-y-0 left-0 z-40 flex w-[86vw] max-w-[320px] flex-col border-r border-border bg-card shadow-2xl">
                <div className="flex h-10 shrink-0 items-center justify-end border-b px-2">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="关闭"
                    title="关闭"
                    onClick={() => setSidebarOpen(false)}
                  >
                    <X className="size-4" />
                  </Button>
                </div>
                <div className="flex min-h-0 flex-1 flex-col">{sidebarBody}</div>
              </div>
            </>
          )
        ) : (
          <>
            <div
              className="flex shrink-0 flex-col border-r"
              style={{ width: fileSidebarW }}
            >
              {sidebarBody}
            </div>
            {/* 调整文件/Git 面板宽度 */}
            <div
              role="separator"
              tabIndex={0}
              aria-orientation="vertical"
              aria-label="调整文件面板宽度"
              onPointerDown={onFileHandleDown}
              className="group/file-handle relative z-10 my-6 flex w-px shrink-0 cursor-ew-resize touch-none items-center justify-center bg-transparent outline-none transition-colors hover:bg-border-hover/60 focus-visible:bg-border-hover/60"
            />
          </>
        )}

        {/* 编辑器 / Diff / Graph 区 */}
        <div className="flex min-w-0 flex-1 flex-col">
          {/* 移动端顶栏:打开文件/Git 抽屉的按钮 */}
          {isMobile && (
            <div className="flex h-9 shrink-0 items-center gap-1 border-b px-1">
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => setSidebarOpen(true)}
                aria-label="打开文件树"
                title="文件树"
              >
                <PanelLeft className="size-4" />
              </Button>
            </div>
          )}
          {showDiff ? (
            /* git 变更模式:右侧显示 diff */
            <DiffView workspaceId={workspaceId} filePath={diffPath!} repo={activeGitRepo} />
          ) : showCommitDiff ? (
            /* git 历史模式:右侧显示提交的文件 diff */
            <DiffView
              workspaceId={workspaceId}
              filePath={commitDiff!.path}
              commitHash={commitDiff!.hash}
              repo={activeGitRepo}
            />
          ) : showGraphPlaceholder ? (
            /* git 历史模式:未选择文件时显示占位 */
            <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-muted-foreground">
              点击提交节点展开变更文件,点击文件查看 diff
            </div>
          ) : openFiles.length > 0 ? (
            <>
              <div className="flex items-center border-b bg-muted/30">
                <div className="flex min-w-0 flex-1 overflow-x-auto">
                  {openFiles.map((f) => (
                    <button
                      key={f.path}
                      onClick={() => setActive(f.path)}
                      title={f.path}
                      className={cn(
                        'group flex shrink-0 items-center gap-1.5 border-r px-3 py-2 font-mono text-xs transition-colors',
                        f.path === activePath
                          ? 'bg-background text-foreground'
                          : 'text-muted-foreground hover:bg-muted/60',
                      )}
                    >
                      {f.dirty && (
                        <span
                          className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400"
                          aria-label="未保存"
                        />
                      )}
                      <span className="max-w-36 truncate">{f.name}</span>
                      <X
                        className="h-3 w-3 shrink-0 opacity-60 transition-opacity hover:opacity-100 md:opacity-0 md:group-hover:opacity-60"
                        onClick={(e) => {
                          e.stopPropagation();
                          closeFile(f.path);
                        }}
                      />
                    </button>
                  ))}
                </div>
                {active && isMarkdown(active.name) && (
                  <div className="flex shrink-0 items-center gap-0.5 border-l px-1">
                    <button
                      onClick={() => setMdPreview(false)}
                      className={cn(
                        'flex items-center gap-1 rounded px-2 py-1 text-[10px] font-medium transition-colors',
                        !mdPreview
                          ? 'bg-accent text-foreground'
                          : 'text-muted-foreground hover:text-foreground',
                      )}
                    >
                      <Pencil className="h-3 w-3" />
                      编辑
                    </button>
                    <button
                      onClick={() => setMdPreview(true)}
                      className={cn(
                        'flex items-center gap-1 rounded px-2 py-1 text-[10px] font-medium transition-colors',
                        mdPreview
                          ? 'bg-accent text-foreground'
                          : 'text-muted-foreground hover:text-foreground',
                      )}
                    >
                      <Eye className="h-3 w-3" />
                      预览
                    </button>
                  </div>
                )}
                {/* 文件内搜索按钮 */}
                <div className="flex shrink-0 items-center border-l px-1">
                  <button
                    onClick={() => {
                      const view = editorViewRef.current;
                      if (view) openSearchPanel(view);
                    }}
                    className="flex items-center justify-center rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    aria-label="文件内搜索"
                    title="文件内搜索 (⌘F)"
                  >
                    <Search className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
              {active ? (
                <div className="min-h-0 flex-1 overflow-hidden">
                  {active.kind === 'image' ? (
                    <ImageViewer
                      src={fileUrl(workspaceId, active.path)}
                      alt={active.name}
                    />
                  ) : active.kind === 'pdf' ? (
                    <iframe
                      src={fileUrl(workspaceId, active.path)}
                      title={active.name}
                      className="h-full w-full border-0"
                    />
                  ) : isMarkdown(active.name) && mdPreview ? (
                    <MarkdownPreview content={active.content} highlightQuery={highlightQuery} />
                  ) : (
                    <CodeEditor
                      value={active.content}
                      filename={active.name}
                      filePath={active.path}
                      onChange={(val) => setContent(active.path, val)}
                      headContent={active.headContent ?? undefined}
                      highlightQuery={highlightQuery}
                      highlightLine={highlightLine}
                      onEditorReady={(view) => {
                        editorViewRef.current = view;
                      }}
                    />
                  )}
                </div>
              ) : (
                <div className="flex flex-1 flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
                  <span>选择左侧文件树打开文件</span>
                  {isMobile && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setSidebarOpen(true)}
                      className="gap-1.5"
                    >
                      <Folder className="size-3.5" />
                      打开文件树
                    </Button>
                  )}
                </div>
              )}
            </>
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
              <span>
                {sidebarMode === 'git' && gitSubView === 'changes'
                  ? '选择变更文件查看 diff'
                  : sidebarMode === 'git' && gitSubView === 'history'
                  ? '点击提交节点查看变更'
                  : '选择文件树打开文件'}
              </span>
              {isMobile && sidebarMode === 'files' && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setSidebarOpen(true)}
                  className="gap-1.5"
                >
                  <Folder className="size-3.5" />
                  打开文件树
                </Button>
              )}
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}
