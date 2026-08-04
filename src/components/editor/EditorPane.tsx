import { useEffect, useState } from 'react';
import { Save, X } from 'lucide-react';
import { putFileContent } from '../../lib/api';
import { useEditorStore } from '../../stores/editorStore';
import { Button } from '../ui/button';
import { cn } from '../../lib/utils';
import { CodeEditor } from './CodeEditor';

/**
 * 右侧编辑器面板:打开文件 tabs + 行号 + textarea + 保存。
 * 未打开任何文件时渲染 null。
 */
export function EditorPane({ workspaceId }: { workspaceId: string }) {
  const openFiles = useEditorStore((s) => s.openFiles);
  const activePath = useEditorStore((s) => s.activePath);
  const setActive = useEditorStore((s) => s.setActive);
  const setContent = useEditorStore((s) => s.setContent);
  const closeFile = useEditorStore((s) => s.closeFile);
  const markSaved = useEditorStore((s) => s.markSaved);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const active = openFiles.find((f) => f.path === activePath) ?? null;

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

  if (openFiles.length === 0) return null;

  return (
    <aside className="flex w-[480px] shrink-0 flex-col border-l bg-card">
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
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400" aria-label="未保存" />
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
      {saveError && (
        <div className="border-t border-destructive/30 bg-destructive/10 px-3 py-1.5 text-xs text-destructive">
          保存失败:{saveError}
        </div>
      )}
    </aside>
  );
}
