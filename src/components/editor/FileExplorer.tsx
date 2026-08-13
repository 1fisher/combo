import { useEffect, useRef, useState } from 'react';
import {
  ChevronRight,
  CaseSensitive,
  Regex,
  WholeWord,
  FileText,
  Folder,
  FolderOpen,
  Loader2,
  MessageSquarePlus,
  MoreHorizontal,
  Search,
  X,
} from 'lucide-react';
import { listFiles } from '../../lib/api';
import type { Api } from '../../lib/api/types';
import { cn } from '../../lib/utils';
import { useContextStore } from '../../stores/contextStore';
import { ContextMenu, type MenuItem } from '../ui/ContextMenu';

interface Props {
  workspaceId: string;
  onOpenFile: (path: string, name: string) => void;
  onError: (msg: string) => void;
}

interface SearchOptions {
  useRegex: boolean;
  caseSensitive: boolean;
  wholeWord: boolean;
}

/** 需要跳过的目录名,加快递归搜索速度 */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'target',
  'dist',
  'build',
  '.next',
  '.nuxt',
  '__pycache__',
  '.venv',
  'venv',
  '.cache',
  '.turbo',
  'coverage',
  '.idea',
  '.vscode',
]);

/** 搜索结果上限,避免超大仓库卡顿 */
const MAX_RESULTS = 500;

/** 从文件名中提取扩展名(小写,不含点) */
function getExt(name: string): string {
  const idx = name.lastIndexOf('.');
  return idx > 0 ? name.slice(idx + 1).toLowerCase() : '';
}

/** 构建 name 匹配函数 */
function buildMatcher(
  query: string,
  opts: SearchOptions,
): ((name: string) => boolean) | null {
  if (!query) return null;
  const flags = opts.caseSensitive ? '' : 'i';
  let pattern: string;
  if (opts.useRegex) {
    pattern = query;
  } else {
    pattern = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  if (opts.wholeWord) {
    pattern = `(?:^|[^\\w])(${pattern})(?:[^\\w]|$)`;
  }
  try {
    const re = new RegExp(pattern, flags);
    return (name: string) => re.test(name);
  } catch {
    return null;
  }
}

/** 解析扩展名过滤输入,返回小写扩展名集合(不含点) */
function parseExtensions(input: string): Set<string> | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const exts = trimmed
    .split(/[,\s]+/)
    .map((e) => e.replace(/^\./, '').toLowerCase())
    .filter(Boolean);
  return exts.length > 0 ? new Set(exts) : null;
}

interface SearchResult {
  name: string;
  path: string;
  type: Api.FileEntryType;
}

/**
 * 懒加载的目录树:目录首次展开时才向后端请求子项。
 * 支持文件名搜索(正则/区分大小写/完整单词)和扩展名过滤。
 */
export function FileExplorer({ workspaceId, onOpenFile, onError }: Props) {
  const [byDir, setByDir] = useState<Record<string, Api.FileEntry[]>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [menu, setMenu] = useState<{ x: number; y: number; entry: Api.FileEntry } | null>(null);
  const addItem = useContextStore((s) => s.addItem);

  // 搜索状态
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [extFilter, setExtFilter] = useState('');
  const [searchOpts, setSearchOpts] = useState<SearchOptions>({
    useRegex: false,
    caseSensitive: false,
    wholeWord: false,
  });
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const searchCancelRef = useRef(0);

  useEffect(() => {
    setByDir({});
    setExpanded({});
    setResults(null);
    setSearchQuery('');
    setDebouncedQuery('');
    void load('');
    // 切换项目时重新加载根目录
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  // debounce 搜索输入
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(searchQuery), 250);
    return () => clearTimeout(t);
  }, [searchQuery]);

  const isSearching = debouncedQuery.trim().length > 0 || extFilter.trim().length > 0;

  // 执行递归搜索
  useEffect(() => {
    if (!isSearching) {
      setResults(null);
      setSearching(false);
      return;
    }
    const cancelId = ++searchCancelRef.current;
    setSearching(true);
    const matcher = buildMatcher(debouncedQuery, searchOpts);
    const extSet = parseExtensions(extFilter);

    void (async () => {
      const found: SearchResult[] = [];
      const queue: string[] = [''];
      const visited = new Set<string>(['']);

      try {
        while (queue.length > 0 && found.length < MAX_RESULTS) {
          if (cancelId !== searchCancelRef.current) return;
          const dir = queue.shift()!;
          let entries: Api.FileEntry[];
          try {
            entries = await listFiles(workspaceId, dir);
          } catch {
            continue;
          }
          if (cancelId !== searchCancelRef.current) return;

          for (const e of entries) {
            if (cancelId !== searchCancelRef.current) return;
            const isDir = e.type === 'dir';

            if (isDir) {
              if (SKIP_DIRS.has(e.name)) continue;
              // 目录名匹配
              if (matcher && matcher(e.name)) {
                found.push({ name: e.name, path: e.path, type: e.type });
              }
              if (!visited.has(e.path)) {
                visited.add(e.path);
                queue.push(e.path);
              }
            } else {
              // 扩展名过滤
              if (extSet) {
                const ext = getExt(e.name);
                if (!extSet.has(ext)) continue;
              }
              // 文件名匹配
              if (matcher) {
                if (matcher(e.name)) {
                  found.push({ name: e.name, path: e.path, type: e.type });
                }
              } else {
                // 只有扩展名过滤,没有文件名搜索
                found.push({ name: e.name, path: e.path, type: e.type });
              }
            }
          }
        }
        if (cancelId !== searchCancelRef.current) return;
        setResults(found);
      } catch (e) {
        if (cancelId !== searchCancelRef.current) return;
        onError(e instanceof Error ? e.message : String(e));
        setResults([]);
      } finally {
        if (cancelId === searchCancelRef.current) setSearching(false);
      }
    })();
  }, [debouncedQuery, extFilter, searchOpts, workspaceId, isSearching, onError]);

  async function load(dir: string) {
    try {
      const entries = await listFiles(workspaceId, dir);
      setByDir((m) => ({ ...m, [dir]: entries }));
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    }
  }

  function toggle(dir: string) {
    const willOpen = !expanded[dir];
    setExpanded((m) => ({ ...m, [dir]: willOpen }));
    if (willOpen && !byDir[dir]) void load(dir);
  }

  function contextMenuItems(entry: Api.FileEntry | SearchResult): MenuItem[] {
    const items: MenuItem[] = [];
    if (entry.type !== 'dir') {
      items.push({
        label: '添加到对话',
        icon: <MessageSquarePlus className="size-3.5 text-muted-foreground" />,
        onClick: () =>
          addItem({ filePath: entry.path, fileName: entry.name, type: 'file' }),
      });
    }
    return items;
  }

  /** 打开上下文菜单:右键用指针坐标,行内按钮用按钮位置 */
  function openMenu(
    ev: React.MouseEvent,
    entry: Api.FileEntry | SearchResult,
    fromButton = false,
  ) {
    const list = contextMenuItems(entry);
    if (list.length === 0) return;
    ev.preventDefault();
    ev.stopPropagation();
    if (fromButton) {
      const rect = (ev.currentTarget as HTMLElement).getBoundingClientRect();
      setMenu({ x: rect.left, y: rect.bottom, entry: entry as Api.FileEntry });
    } else {
      setMenu({ x: ev.clientX, y: ev.clientY, entry: entry as Api.FileEntry });
    }
  }

  function clearSearch() {
    setSearchQuery('');
    setExtFilter('');
  }

  function renderDir(dir: string, depth: number) {
    const entries = byDir[dir] ?? [];
    return (
      <div key={dir}>
        {entries.map((e) => {
          const isDir = e.type === 'dir';
          const hasMenu = contextMenuItems(e).length > 0;
          return (
            <div key={e.path}>
              <div className="group flex items-center">
              <button
                onClick={() => (isDir ? toggle(e.path) : onOpenFile(e.path, e.name))}
                onContextMenu={(ev) => openMenu(ev, e)}
                className={cn(
                  'flex min-w-0 flex-1 items-center gap-1.5 rounded py-1 pr-2 text-left transition-colors hover:bg-accent',
                  !isDir && 'pl-6'
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
              </button>
              {/* 行内更多操作:移动端常驻,桌面端 hover 显示;触屏替代右键菜单 */}
              {hasMenu && (
                <button
                  onClick={(ev) => openMenu(ev, e, true)}
                  className="flex shrink-0 items-center justify-center rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground md:opacity-0 md:group-hover:opacity-100"
                  aria-label="更多操作"
                  title="更多操作"
                >
                  <MoreHorizontal className="size-3.5" />
                </button>
              )}
              </div>
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

  function renderSearchResults() {
    if (searching) {
      return (
        <div className="flex items-center gap-1.5 px-3 py-4 text-xs text-muted-foreground">
          <Loader2 className="size-3 animate-spin" />
          搜索中…
        </div>
      );
    }
    if (!results || results.length === 0) {
      return (
        <div className="px-3 py-4 text-xs text-muted-foreground/70">
          未找到匹配的文件
        </div>
      );
    }
    return (
      <div>
        {results.map((r) => {
          const hasMenu = contextMenuItems(r).length > 0;
          const dirPath = r.path.includes('/')
            ? r.path.slice(0, r.path.lastIndexOf('/'))
            : '';
          return (
            <div key={r.path} className="group flex items-center">
              <button
                onClick={() => onOpenFile(r.path, r.name)}
                onContextMenu={(ev) => openMenu(ev, r)}
                className="flex min-w-0 flex-1 items-center gap-1.5 rounded py-1 pr-2 pl-6 text-left transition-colors hover:bg-accent"
                title={r.path}
              >
                {r.type === 'dir' ? (
                  <Folder className="h-3.5 w-3.5 shrink-0 text-primary/70" />
                ) : (
                  <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                )}
                <span className="flex min-w-0 flex-col">
                  <span className="truncate font-mono text-xs">{r.name}</span>
                  {dirPath && (
                    <span className="truncate text-[10px] text-muted-foreground/60">
                      {dirPath}
                    </span>
                  )}
                </span>
              </button>
              {hasMenu && (
                <button
                  onClick={(ev) => openMenu(ev, r, true)}
                  className="flex shrink-0 items-center justify-center rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground md:opacity-0 md:group-hover:opacity-100"
                  aria-label="更多操作"
                  title="更多操作"
                >
                  <MoreHorizontal className="size-3.5" />
                </button>
              )}
            </div>
          );
        })}
        {results.length >= MAX_RESULTS && (
          <div className="px-3 py-1 text-[10px] text-muted-foreground/60">
            结果过多,仅显示前 {MAX_RESULTS} 项,请细化搜索条件
          </div>
        )}
      </div>
    );
  }

  return (
    <>
      {/* 搜索栏 */}
      <div className="flex flex-col gap-1 border-b p-1.5">
        <div className="flex items-center gap-1">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-2 top-1/2 size-3 -translate-y-1/2 text-muted-foreground" />
            <input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="搜索文件名…"
              className="h-7 w-full rounded-md border border-input-border bg-background pl-7 pr-6 text-xs outline-none placeholder:text-foreground-subtlest focus-visible:border-input-border-focused"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                aria-label="清除搜索"
              >
                <X className="size-3" />
              </button>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1">
          {/* 正则 */}
          <SearchToggle
            active={searchOpts.useRegex}
            onClick={() => setSearchOpts((s) => ({ ...s, useRegex: !s.useRegex }))}
            title="正则表达式"
            label=".*"
            icon={<Regex className="size-3.5" />}
          />
          {/* 区分大小写 */}
          <SearchToggle
            active={searchOpts.caseSensitive}
            onClick={() => setSearchOpts((s) => ({ ...s, caseSensitive: !s.caseSensitive }))}
            title="区分大小写"
            icon={<CaseSensitive className="size-3.5" />}
          />
          {/* 完整单词 */}
          <SearchToggle
            active={searchOpts.wholeWord}
            onClick={() => setSearchOpts((s) => ({ ...s, wholeWord: !s.wholeWord }))}
            title="完整单词"
            icon={<WholeWord className="size-3.5" />}
          />
          <div className="ml-auto flex items-center gap-1">
            <span className="text-[10px] text-muted-foreground/70">扩展名</span>
            <input
              value={extFilter}
              onChange={(e) => setExtFilter(e.target.value)}
              placeholder="ts,tsx"
              className="h-6 w-16 rounded border border-input-border bg-background px-1.5 text-[11px] outline-none placeholder:text-foreground-subtlest focus-visible:border-input-border-focused"
            />
            {(searchQuery || extFilter) && (
              <button
                onClick={clearSearch}
                className="text-muted-foreground hover:text-foreground"
                aria-label="清除所有搜索"
                title="清除"
              >
                <X className="size-3.5" />
              </button>
            )}
          </div>
        </div>
      </div>

      {/* 搜索结果 / 目录树 */}
      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {isSearching ? renderSearchResults() : renderDir('', 0)}
      </div>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={contextMenuItems(menu.entry)}
          onClose={() => setMenu(null)}
        />
      )}
    </>
  );
}

/** 搜索选项切换按钮 */
function SearchToggle({
  active,
  onClick,
  title,
  label,
  icon,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  label?: string;
  icon: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      aria-pressed={active}
      className={cn(
        'flex h-6 min-w-6 items-center justify-center gap-0.5 rounded border px-1 text-[11px] transition-colors',
        active
          ? 'border-primary bg-primary/10 text-primary'
          : 'border-input-border text-muted-foreground hover:bg-accent hover:text-foreground',
      )}
    >
      {icon}
      {label && <span className="font-mono">{label}</span>}
    </button>
  );
}
