import { useEffect, useState } from 'react';
import { Save, X } from 'lucide-react';
import { getFileContent, putFileContent } from '../../lib/api';
import { useEditorStore } from '../../stores/editorStore';
import { Button } from '../ui/button';
import { cn } from '../../lib/utils';
import { CodeEditor } from './CodeEditor';
import { FileExplorer } from './FileExplorer';

/**
 * 右侧编辑器面板:文件目录树 + 打开文件 tabs + 行号 + textarea + 保存。
 */
export function EditorPane({ workspaceId, width }: { workspaceId: string; width: number }) {
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
    try {
      const { content } = await getFileContent(workspaceId, filePath);
      openFileInStore(filePath, name, content);
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
    <aside className="flex shrink-0 flex-col border-l bg-card" style={{ width }}>
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
                <Button
                  size="sm"
                  variant="outline"
                  className="m-1.5 h-7 shrink-0"
                  onClick={save}
                  disabled={!active?.dirty || saving}
                >
                  <Save className="h-3.5 w-3.5" />
                  保存
                </Button>
              </div>
              {active ? (
                <div className="min-h-0 flex-1 overflow-hidden">
                  <CodeEditor
                    value={active.content}
                    filename={active.name}
                    onChange={(val) => setContent(active.path, val)}
                  />
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
