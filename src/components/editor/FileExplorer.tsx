import { useEffect, useRef, useState } from 'react';
import {
  ChevronRight,
  CaseSensitive,
  WholeWord,
  FileText,
  Folder,
  FolderInput,
  FolderOpen,
  Loader2,
  MessageSquarePlus,
  MoreHorizontal,
  Search,
  SearchCode,
  X,
} from 'lucide-react';
import { listFiles, searchFiles, type ContentSearchResult } from '../../lib/api';
import type { Api } from '../../lib/api/types';
import { cn } from '../../lib/utils';
import { useContextStore } from '../../stores/contextStore';
import { ContextMenu, type MenuItem } from '../ui/ContextMenu';

interface Props {
  workspaceId: string;
  onOpenFile: (path: string, name: string, line?: number) => void;
  onError: (msg: string) => void;
  onSearchQueryChange?: (query: string) => void;
  /** 聚焦搜索框信号:每次递增时把焦点移入文件内容搜索框(供 ⌘/Ctrl+Shift+F 快捷键) */
  focusSearchSignal?: number;
}

interface SearchOptions {
  useRegex: boolean;
  caseSensitive: boolean;
  wholeWord: boolean;
}

/** 搜索结果上限(与后端一致),用于截断提示 */
const MAX_RESULTS = 500;

/**
 * 懒加载的目录树:目录首次展开时才向后端请求子项。
 * 支持文件内容搜索(正则/区分大小写/完整单词)和右键目录搜索。
 */
export function FileExplorer({
  workspaceId,
  onOpenFile,
  onError,
  onSearchQueryChange,
  focusSearchSignal,
}: Props) {
  const [byDir, setByDir] = useState<Record<string, Api.FileEntry[]>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [menu, setMenu] = useState<{ x: number; y: number; entry: Api.FileEntry } | null>(null);
  const addItem = useContextStore((s) => s.addItem);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // 搜索状态
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [searchDir, setSearchDir] = useState('');
  const [searchOpts, setSearchOpts] = useState<SearchOptions>({
    useRegex: false,
    caseSensitive: false,
    wholeWord: false,
  });
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<ContentSearchResult[] | null>(null);
  const searchCancelRef = useRef(0);

  useEffect(() => {
    setByDir({});
    setExpanded({});
    setResults(null);
    setSearchQuery('');
    setDebouncedQuery('');
    setSearchDir('');
    void load('');
    // 切换项目时重新加载根目录
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  // 外部请求聚焦搜索框(⌘/Ctrl+Shift+F;signal 递增触发,挂载时的初始值 0 不触发)
  useEffect(() => {
    if (focusSearchSignal) searchInputRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusSearchSignal]);

  // debounce 搜索输入
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(searchQuery), 300);
    return () => clearTimeout(t);
  }, [searchQuery]);

  // 通知父组件当前搜索关键词(用于编辑器内高亮)
  useEffect(() => {
    onSearchQueryChange?.(debouncedQuery.trim() || '');
  }, [debouncedQuery, onSearchQueryChange]);

  const isSearching = debouncedQuery.trim().length > 0;

  // 使用后端搜索文件内容(ripgrep --json + walkdir 回退)
  useEffect(() => {
    if (!isSearching) {
      setResults(null);
      setSearching(false);
      return;
    }
    const cancelId = ++searchCancelRef.current;
    setSearching(true);

    void (async () => {
      try {
        const entries = await searchFiles(workspaceId, {
          q: debouncedQuery,
          path: searchDir || undefined,
          regex: searchOpts.useRegex,
          caseSensitive: searchOpts.caseSensitive,
          wholeWord: searchOpts.wholeWord,
        });
        if (cancelId !== searchCancelRef.current) return;
        setResults(entries);
      } catch (e) {
        if (cancelId !== searchCancelRef.current) return;
        onError(e instanceof Error ? e.message : String(e));
        setResults([]);
      } finally {
        if (cancelId === searchCancelRef.current) setSearching(false);
      }
    })();
  }, [debouncedQuery, searchDir, searchOpts, workspaceId, isSearching, onError]);

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

  /** 在指定目录中搜索 */
  function searchInDir(dir: string) {
    setSearchDir(dir);
    // 如果搜索框为空,聚焦搜索框让用户输入
    if (!searchQuery) searchInputRef.current?.focus();
  }

  function contextMenuItems(entry: Api.FileEntry): MenuItem[] {
    const items: MenuItem[] = [];
    if (entry.type === 'dir') {
      items.push({
        label: '在此目录搜索',
        icon: <SearchCode className="size-3.5 text-muted-foreground" />,
        onClick: () => searchInDir(entry.path),
      });
    } else {
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
    entry: Api.FileEntry,
    fromButton = false,
  ) {
    ev.preventDefault();
    ev.stopPropagation();
    if (fromButton) {
      const rect = (ev.currentTarget as HTMLElement).getBoundingClientRect();
      setMenu({ x: rect.left, y: rect.bottom, entry });
    } else {
      setMenu({ x: ev.clientX, y: ev.clientY, entry });
    }
  }

  function clearSearch() {
    setSearchQuery('');
    setSearchDir('');
  }

  function renderDir(dir: string, depth: number) {
    const entries = byDir[dir] ?? [];
    return (
      <div key={dir}>
        {entries.map((e) => {
          const isDir = e.type === 'dir';
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
              <button
                onClick={(ev) => openMenu(ev, e, true)}
                className="flex shrink-0 items-center justify-center rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground md:opacity-0 md:group-hover:opacity-100"
                aria-label="更多操作"
                title="更多操作"
              >
                <MoreHorizontal className="size-3.5" />
              </button>
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
          未找到匹配的内容
        </div>
      );
    }

    // 按 path 分组
    const grouped: Record<string, ContentSearchResult[]> = {};
    for (const r of results) {
      const key = r.path;
      if (!grouped[key]) grouped[key] = [];
      grouped[key].push(r);
    }
    const filePaths = Object.keys(grouped);

    return (
      <div>
        {filePaths.map((fp) => {
          const matches = grouped[fp];
          const fileName = matches[0].name;
          const dirPath = fp.includes('/')
            ? fp.slice(0, fp.lastIndexOf('/'))
            : '';
          return (
            <div key={fp} className="mb-0.5">
              {/* 文件头 */}
              <div className="group flex items-center">
                <button
                  onClick={() => onOpenFile(fp, fileName, matches[0]?.line ?? undefined)}
                  className="flex min-w-0 flex-1 items-center gap-1.5 rounded py-1 pr-2 pl-6 text-left transition-colors hover:bg-accent"
                  title={fp}
                >
                  <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate font-mono text-xs">{fileName}</span>
                    {dirPath && (
                      <span className="truncate text-[10px] text-muted-foreground/60">
                        {dirPath}
                      </span>
                    )}
                  </span>
                </button>
                <button
                  onClick={() =>
                    addItem({ filePath: fp, fileName, type: 'file' })
                  }
                  className="flex shrink-0 items-center justify-center rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground md:opacity-0 md:group-hover:opacity-100"
                  aria-label="添加到对话"
                  title="添加到对话"
                >
                  <MessageSquarePlus className="size-3.5" />
                </button>
              </div>
              {/* 每个匹配行 */}
              {matches.map((m, i) => (
                <button
                  key={i}
                  onClick={() => onOpenFile(fp, fileName, m.line ?? undefined)}
                  className="flex w-full min-w-0 items-start gap-1.5 rounded py-0.5 pr-2 pl-10 text-left transition-colors hover:bg-accent"
                  title={`${fp}:${m.line ?? ''}`}
                >
                  {m.line != null && (
                    <span className="shrink-0 text-[10px] leading-5 text-primary/60 tabular-nums">
                      {m.line}
                    </span>
                  )}
                  <code className="min-w-0 flex-1 truncate text-[11px] leading-5 text-foreground/80">
                    <HighlightMatch
                      text={m.content}
                      query={debouncedQuery}
                      useRegex={searchOpts.useRegex}
                      caseSensitive={searchOpts.caseSensitive}
                      wholeWord={searchOpts.wholeWord}
                    />
                  </code>
                </button>
              ))}
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
              ref={searchInputRef}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="搜索文件内容…"
              data-file-search
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
          {(searchQuery || searchDir) && (
            <button
              onClick={clearSearch}
              className="ml-auto text-muted-foreground hover:text-foreground"
              aria-label="清除所有搜索"
              title="清除"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>
        {/* 搜索目录范围 */}
        <div className="flex items-center gap-1">
          <FolderInput className="size-3 shrink-0 text-muted-foreground/70" />
          <input
            value={searchDir}
            onChange={(e) => setSearchDir(e.target.value)}
            placeholder="搜索目录(留空搜索全部)"
            className="h-6 w-full rounded border border-input-border bg-background px-1.5 text-[11px] outline-none placeholder:text-foreground-subtlest focus-visible:border-input-border-focused"
          />
          {searchDir && (
            <button
              onClick={() => setSearchDir('')}
              className="shrink-0 text-muted-foreground hover:text-foreground"
              aria-label="清除搜索目录"
              title="清除目录"
            >
              <X className="size-3" />
            </button>
          )}
        </div>
        {searchDir && (
          <div className="text-[10px] text-muted-foreground/60">
            当前搜索范围:{searchDir}
          </div>
        )}
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
  icon?: React.ReactNode;
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

/** 高亮搜索关键词。支持普通文本、正则、区分大小写、完整单词。 */
function HighlightMatch({
  text,
  query,
  useRegex,
  caseSensitive,
  wholeWord: _wholeWord,
}: {
  text: string;
  query: string;
  useRegex: boolean;
  caseSensitive: boolean;
  wholeWord: boolean;
}) {
  if (!query.trim()) return <>{text}</>;

  let pattern: string;
  if (useRegex) {
    pattern = query;
  } else {
    pattern = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  const flags = caseSensitive ? 'g' : 'gi';
  let re: RegExp;
  try {
    re = new RegExp(pattern, flags);
  } catch {
    return <>{text}</>;
  }

  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = re.exec(text)) !== null) {
    const matchStart = match.index;
    const matchEnd = matchStart + match[0].length;
    if (matchStart > lastIndex) {
      parts.push(text.slice(lastIndex, matchStart));
    }
    parts.push(
      <mark key={key++} className="rounded bg-teal-400/30 px-0.5 text-teal-100">
        {match[0]}
      </mark>,
    );
    lastIndex = matchEnd;
    if (match[0].length === 0) re.lastIndex++;
  }
  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }

  return <>{parts}</>;
}
