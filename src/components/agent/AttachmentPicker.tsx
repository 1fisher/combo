import { useEffect, useRef, useState } from 'react';
import { Check, ChevronRight, FileText, Folder, FolderOpen, Paperclip, X } from 'lucide-react';
import { Button } from '../ui/button';
import { listFiles } from '../../lib/api';
import type { Api } from '../../lib/api/types';
import { cn } from '../../lib/utils';

interface Props {
  workspaceId: string;
  selected?: Api.Attachment[];
  onPick: (files: Api.Attachment[]) => void;
  onClose: () => void;
}

/**
 * 工作区附件选择器:以树形列出工作区文件,点选文件为多选附件。
 * 目录懒加载(首次展开才向后端请求子项)。
 */
export function AttachmentPicker({ workspaceId, selected = [], onPick, onClose }: Props) {
  const [byDir, setByDir] = useState<Record<string, Api.FileEntry[]>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [picked, setPicked] = useState<Record<string, { path: string; name: string }>>({});
  const [loading, setLoading] = useState(false);

  // 保持最新 onClose,避免因调用方每次渲染重建函数而反复重挂监听
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  // 按 Esc 关闭文件选择弹窗
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onCloseRef.current();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  useEffect(() => {
    setByDir({});
    setExpanded({});
    setPicked({});
    // 预载根目录,方便直接点选
    void load('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  // 初始选中回填
  useEffect(() => {
    const init: Record<string, { path: string; name: string }> = {};
    for (const a of selected) {
      init[a.file_path] = { path: a.file_path, name: a.file_name };
    }
    setPicked(init);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function load(dir: string) {
    try {
      setLoading(true);
      const entries = await listFiles(workspaceId, dir);
      setByDir((m) => ({ ...m, [dir]: entries }));
    } catch {
      /* 目录加载失败时静默,用户可重试展开 */
    } finally {
      setLoading(false);
    }
  }

  function toggle(dir: string) {
    const willOpen = !expanded[dir];
    setExpanded((m) => ({ ...m, [dir]: willOpen }));
    if (willOpen && !byDir[dir]) void load(dir);
  }

  function toggleFile(e: Api.FileEntry) {
    setPicked((m) => {
      const next = { ...m };
      if (next[e.path]) {
        delete next[e.path];
      } else {
        next[e.path] = { path: e.path, name: e.name };
      }
      return next;
    });
  }

  const pickedList: Api.Attachment[] = Object.values(picked).map((p) => ({
    file_path: p.path,
    file_name: p.name,
  }));

  function renderDir(dir: string, depth: number) {
    const entries = byDir[dir] ?? [];
    return (
      <div key={dir}>
        {entries.map((e) => {
          const isDir = e.type === 'dir';
          const isPicked = !!picked[e.path];
          return (
            <div key={e.path}>
              <button
                type="button"
                onClick={() => (isDir ? toggle(e.path) : toggleFile(e))}
                className={cn(
                  'flex w-full items-center gap-1.5 rounded py-1 pr-2 text-left transition-colors hover:bg-surface-hover',
                  isPicked && 'bg-brand/10'
                )}
                style={{ paddingLeft: isDir ? 8 + depth * 14 : 24 + depth * 14 }}
                title={e.path}
              >
                {isDir ? (
                  <>
                    <ChevronRight
                      className={cn(
                        'h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform',
                        expanded[e.path] && 'rotate-90'
                      )}
                    />
                    {expanded[e.path] ? (
                      <FolderOpen className="h-3.5 w-3.5 shrink-0 text-primary/70" />
                    ) : (
                      <Folder className="h-3.5 w-3.5 shrink-0 text-primary/70" />
                    )}
                    <span className="truncate font-mono text-xs">{e.name}</span>
                  </>
                ) : (
                  <>
                    <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <span className="truncate font-mono text-xs">{e.name}</span>
                  </>
                )}
                {!isDir && isPicked && <Check className="ml-auto h-3.5 w-3.5 shrink-0 text-brand" />}
              </button>
              {isDir && expanded[e.path] && renderDir(e.path, depth + 1)}
            </div>
          );
        })}
        {entries.length === 0 && expanded[dir] && (
          <div
            className="py-1 text-xs text-muted-foreground/70"
            style={{ paddingLeft: 24 + depth * 14 }}
          >
            空目录
          </div>
        )}
      </div>
    );
  }

  const selectedCount = Object.keys(picked).length;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <div className="relative flex max-h-[70vh] w-full max-w-md flex-col overflow-hidden rounded-2xl border border-border bg-popover shadow-2xl">
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <Paperclip className="size-4 text-foreground-subtle" />
          <span className="text-sm font-medium">添加附件</span>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto rounded p-1 text-foreground-subtle transition-colors hover:bg-surface-hover hover:text-foreground"
            aria-label="关闭"
          >
            <X className="size-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-1.5">{renderDir('', 0)}</div>
        <div className="flex items-center justify-between gap-2 border-t border-border px-4 py-3">
          <span className="text-xs text-foreground-subtle">
            {selectedCount > 0 ? `已选择 ${selectedCount} 个文件` : loading ? '加载中…' : '选择工作区文件作为附件'}
          </span>
          <div className="flex items-center gap-1.5">
            <Button variant="ghost" size="sm" onClick={onClose} className="text-[13px]">
              取消
            </Button>
            <Button
              size="sm"
              disabled={selectedCount === 0}
              onClick={() => onPick(pickedList)}
              className="bg-brand text-foreground-inverse text-[13px] hover:bg-brand/80"
            >
              添加附件{selectedCount > 0 ? `(${selectedCount})` : ''}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}