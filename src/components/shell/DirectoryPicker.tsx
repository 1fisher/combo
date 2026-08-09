import { useCallback, useEffect, useState } from 'react';
import { ArrowUp, ChevronRight, Folder, Loader2, RefreshCw } from 'lucide-react';
import { Button } from '../ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import { listHostDirs, type HostDirEntry } from '../../lib/api';
import { cn } from '../../lib/utils';

interface DirectoryPickerProps {
  open: boolean;
  title?: string;
  description?: string;
  confirmLabel?: string;
  onOpenChange: (open: boolean) => void;
  onSelect: (path: string) => void;
  /** 提供后端选择行时显示(创建项目场景)。 */
  backend?: string;
  onBackendChange?: (backend: string) => void;
}

/**
 * 服务器目录选择器:供浏览器/移动端从远端浏览服务器文件系统并点选项目目录。
 * 手动路径输入作为兜底;受限浏览(COMBO_BROWSE_ROOT)时越界由服务端拒绝。
 */
export function DirectoryPicker({
  open,
  title = '添加项目',
  description = '在服务器上选择项目目录(服务器上的绝对路径)。',
  confirmLabel = '选择此目录',
  onOpenChange,
  onSelect,
  backend,
  onBackendChange,
}: DirectoryPickerProps) {
  const [path, setPath] = useState('');
  const [parent, setParent] = useState<string | null>(null);
  const [entries, setEntries] = useState<HostDirEntry[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (p?: string) => {
    setLoading(true);
    setError(null);
    try {
      const r = await listHostDirs(p);
      setPath(r.path);
      setParent(r.parent);
      setEntries(r.entries);
      setInput(r.path);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  // 打开时默认进入服务器浏览起点(家目录或受限浏览根)
  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-1.5">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && input.trim()) void load(input.trim());
              }}
              placeholder="/path/to/project"
              className="h-9 min-w-0 flex-1 rounded-lg border border-input-border bg-background px-2.5 text-[13px] outline-none placeholder:text-foreground-subtlest focus-visible:border-input-border-focused"
            />
            <Button
              variant="outline"
              size="sm"
              className="h-9 shrink-0 px-2.5 text-[13px]"
              onClick={() => {
                if (input.trim()) void load(input.trim());
              }}
            >
              前往
            </Button>
          </div>
          <div className="flex items-center justify-between gap-2 rounded-lg border border-border bg-surface px-2.5 py-1.5 text-[12px] text-foreground-subtle">
            <span className="min-w-0 truncate" title={path}>
              {path || '加载中…'}
            </span>
            <button
              type="button"
              aria-label="上级目录"
              title="上级目录"
              disabled={!parent || loading || parent === path}
              onClick={() => {
                if (parent) void load(parent);
              }}
              className="shrink-0 rounded-md p-1 text-foreground-subtle transition-colors hover:bg-surface-hover hover:text-foreground disabled:opacity-40"
            >
              <ArrowUp className="size-4" />
            </button>
          </div>
          <div className="max-h-64 min-h-32 overflow-y-auto rounded-lg border border-border">
            {loading ? (
              <div className="flex h-32 items-center justify-center text-foreground-subtle">
                <Loader2 className="size-4 animate-spin" />
              </div>
            ) : error ? (
              <div className="flex h-32 flex-col items-center justify-center gap-2 px-3 text-center text-[13px] text-destructive">
                <span>{error}</span>
                <Button
                  variant="outline"
                  size="sm"
                  className="text-[12px]"
                  onClick={() => void load(path || undefined)}
                >
                  <RefreshCw className="size-3.5" />
                  重试
                </Button>
              </div>
            ) : entries.length === 0 ? (
              <div className="flex h-32 items-center justify-center px-3 text-center text-[13px] text-foreground-subtle">
                此目录没有子目录
              </div>
            ) : (
              <ul>
                {entries.map((e) => (
                  <li key={e.path}>
                    <button
                      type="button"
                      onClick={() => void load(e.path)}
                      className={cn(
                        'flex w-full items-center gap-2 px-2.5 py-2 text-left text-[13px] transition-colors',
                        'hover:bg-surface-hover'
                      )}
                    >
                      <Folder className="size-4 shrink-0 text-foreground-subtlest" />
                      <span className="min-w-0 flex-1 truncate">{e.name}</span>
                      <ChevronRight className="size-3.5 shrink-0 text-foreground-subtlest" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {onBackendChange && (
            <div className="flex items-center gap-1.5">
              <span className="shrink-0 text-[12px] text-foreground-subtle">后端</span>
              <select
                value={backend ?? 'combo-cli'}
                onChange={(e) => onBackendChange(e.target.value)}
                className="h-7 min-w-0 flex-1 rounded-lg border border-input-border bg-background px-1.5 text-[13px] outline-none"
              >
                <option value="combo-cli">Combo-cli</option>
                <option value="crush">Crush</option>
                <option value="opencode">OpenCode</option>
                <option value="claude_code">Claude Code</option>
                <option value="codex">Codex</option>
              </select>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button disabled={!path || loading} onClick={() => onSelect(path)}>
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
