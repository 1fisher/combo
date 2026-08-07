import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { getFileContent, putFileContent } from '../../lib/api';
import { useEditorStore, type FileKind } from '../../stores/editorStore';
import { getProxyBaseUrl } from '../../lib/connection';
import { getClientId } from '../../lib/clientId';
import { cn } from '../../lib/utils';
import { CodeEditor } from './CodeEditor';
import { FileExplorer } from './FileExplorer';
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
 * 右侧编辑器面板:文件目录树 + 打开文件 tabs + 行号 + textarea + 保存。
 */
export function EditorPane({ workspaceId }: { workspaceId: string }) {
  const openFiles = useEditorStore((s) => s.openFiles);
  const activePath = useEditorStore((s) => s.activePath);
  const setActive = useEditorStore((s) => s.setActive);
  const setContent = useEditorStore((s) => s.setContent);
  const closeFile = useEditorStore((s) => s.closeFile);
  const markSaved = useEditorStore((s) => s.markSaved);
  const openFileInStore = useEditorStore((s) => s.openFile);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const active = openFiles.find((f) => f.path === activePath) ?? null;

  async function handleOpenFile(filePath: string, name: string) {
    setLoadError(null);
    const kind = fileKindOf(name);
    try {
      if (kind === 'text') {
        const { content } = await getFileContent(workspaceId, filePath);
        openFileInStore(filePath, name, content, kind);
      } else {
        // 图片 / PDF 不读文本内容,直接用 URL 预览
        openFileInStore(filePath, name, '', kind);
      }
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  }

  async function save() {
    if (!active || !active.dirty || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      await putFileContent(workspaceId, active.path, active.content);
      markSaved(active.path, active.content);
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

  return (
    <aside className="flex h-full w-full min-h-0 flex-col bg-card">
      {(saveError || loadError) && (
        <div className="border-b border-destructive/30 bg-destructive/10 px-3 py-1.5 text-xs text-destructive">
          {saveError || loadError}
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        {/* 文件目录树 */}
        <div className="flex w-[220px] shrink-0 flex-col border-r">
          <div className="shrink-0 border-b px-3 py-2 text-xs font-medium text-muted-foreground">
            文件
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <FileExplorer
              workspaceId={workspaceId}
              onOpenFile={handleOpenFile}
              onError={setLoadError}
            />
          </div>
        </div>
        {/* 编辑器区 */}
        <div className="flex min-w-0 flex-1 flex-col">
          {openFiles.length > 0 ? (
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
                          : 'text-muted-foreground hover:bg-muted/60'
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
              从左侧文件树打开文件
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}
