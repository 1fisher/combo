import { useCallback, useEffect, useState } from 'react';
import { Folder, GitBranch, History, X } from 'lucide-react';
import { getFileContent, getGitFileAtHead, putFileContent } from '../../lib/api';
import { useEditorStore, type FileKind } from '../../stores/editorStore';
import { getProxyBaseUrl } from '../../lib/connection';
import { getClientId } from '../../lib/clientId';
import { cn } from '../../lib/utils';
import { CodeEditor } from './CodeEditor';
import { DiffView } from './DiffView';
import { FileExplorer } from './FileExplorer';
import { GitGraph } from './GitGraph';
import { GitPanel } from './GitPanel';
import { ImageViewer } from './ImageViewer';

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.ico']);

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

  const [sidebarMode, setSidebarMode] = useState<'files' | 'git'>('files');
  const [gitSubView, setGitSubView] = useState<'changes' | 'history'>('changes');
  const [diffPath, setDiffPath] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const active = openFiles.find((f) => f.path === activePath) ?? null;

  const handleOpenFile = useCallback(
    async (filePath: string, name: string) => {
      setLoadError(null);
      setDiffPath(null);
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
  const showGraph = sidebarMode === 'git' && gitSubView === 'history';

  return (
    <aside className="flex h-full w-full min-h-0 flex-col bg-card">
      {(saveError || loadError) && (
        <div className="border-b border-destructive/30 bg-destructive/10 px-3 py-1.5 text-xs text-destructive">
          {saveError || loadError}
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        {/* 左侧面板:文件 / Git */}
        <div className="flex w-[240px] shrink-0 flex-col border-r">
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
                      selectedDiffPath={diffPath}
                      onShowDiff={handleShowDiff}
                      onOpenFile={handleOpenFile}
                    />
                  ) : (
                    <GitGraph workspaceId={workspaceId} />
                  )}
                </div>
              </>
            )}
          </div>
        </div>
        {/* 编辑器 / Diff / Graph 区 */}
        <div className="flex min-w-0 flex-1 flex-col">
          {showDiff ? (
            /* git 变更模式:右侧显示 diff */
            <DiffView workspaceId={workspaceId} filePath={diffPath!} />
          ) : showGraph ? (
            /* git 历史模式:右侧显示 graph 占位 */
            <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
              提交历史显示在左侧面板
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
                        className="h-3 w-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-60 hover:opacity-100"
                        onClick={(e) => {
                          e.stopPropagation();
                          closeFile(f.path);
                        }}
                      />
                    </button>
                  ))}
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
                  ) : (
                    <CodeEditor
                      value={active.content}
                      filename={active.name}
                      onChange={(val) => setContent(active.path, val)}
                      headContent={active.headContent ?? undefined}
                    />
                  )}
                </div>
              ) : (
                <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
                  从左侧文件树打开文件
                </div>
              )}
            </>
          ) : (
            <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
              {sidebarMode === 'git' && gitSubView === 'changes'
                ? '从左侧选择变更文件查看 diff'
                : sidebarMode === 'git' && gitSubView === 'history'
                ? '从左侧查看提交历史'
                : '从左侧文件树打开文件'}
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}
