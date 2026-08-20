import { useMemo } from 'react';
import { CircleAlert, CircleCheck, CircleX, X } from 'lucide-react';
import type { Api } from '../../lib/api/types';
import type { LspIssue, LspReady } from '../../lib/lspStatus';
import { cn } from '../../lib/utils';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../ui/tooltip';

/**
 * 会话界面的 LSP 问题横幅:项目主要语言的 LSP 未就绪时显示在消息区上方,
 * - `not-found`(已配置但 PATH 中找不到可执行文件)→ 错误红,标题「语言服务检测异常」;
 * - `missing`(项目有该语言源码但未配置 server)→ 琥珀警告,标题「语言服务未配置」。
 *
 * 「去配置」跳转 LSP 服务视图(可一键安装/表单配置);「忽略」本次隐藏
 * (内存态,切换项目后自动复位重检)。
 *
 * 正常状态不使用本横幅(避免大条幅噪音),改用 LspReadyIndicator 的小 icon。
 */
export function LspStatusBanner({
  issues,
  onOpenLsp,
  onDismiss,
}: {
  issues: LspIssue[];
  onOpenLsp: () => void;
  onDismiss: () => void;
}) {
  const hasError = issues.some((i) => i.kind === 'not-found');
  return (
    <div
      data-testid="lsp-status-banner"
      className={cn(
        'flex items-start gap-2 bg-destructive/10 mx-4 mt-2 px-3 py-2 border rounded-xl text-xs shrink-0',
        hasError
          ? 'border-destructive/30 text-destructive'
          : 'border-amber-500/30 text-amber-700 dark:text-amber-400',
      )}
    >
      <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
      <div className="flex flex-col gap-1 min-w-0 flex-1">
        <span className="font-medium leading-5">
          {hasError ? '语言服务检测异常' : '语言服务未配置'}
        </span>
        <ul className="flex flex-col gap-0.5">
          {issues.map((i) => (
            <li key={i.lang} className="min-w-0 leading-snug text-foreground-subtle">
              <span className="font-medium text-foreground">{i.label}</span>
              <span className="opacity-70">({i.files} 个源文件)</span>
              {i.kind === 'not-found' ? (
                <>
                  :已配置 <code className="font-mono">{i.command}</code>,但未在 PATH
                  中找到可执行文件,代码诊断/导航工具不可用
                </>
              ) : (
                <>
                  :未配置 LSP server
                  {i.command ? (
                    <>
                      (建议 <code className="font-mono">{i.command}</code>)
                    </>
                  ) : null}
                  ,代码诊断/导航工具不可用
                </>
              )}
            </li>
          ))}
        </ul>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <button
          type="button"
          onClick={onOpenLsp}
          className="hover:bg-surface-hover text-brand rounded-md px-1.5 py-1 font-medium transition-colors"
        >
          去配置
        </button>
        <button
          type="button"
          aria-label="忽略本次提示"
          title="忽略本次提示(切换项目后会重新检测)"
          onClick={onDismiss}
          className="hover:bg-surface-hover flex justify-center items-center rounded-md size-6 text-foreground-subtle transition-colors"
        >
          <X className="size-3.5" />
        </button>
      </div>
    </div>
  );
}

/**
 * LSP 就绪指示器(正常状态的轻量展示):消息区右上角一枚小图标,
 * 悬停弹出 tooltip 显示就绪详情(语言 + server),点击跳 LSP 视图
 * (触屏没有 hover,点击兜底)。与 Composer「完全访问」的 icon+tooltip 范式一致。
 *
 * 诊断联动:
 * - `entries`(后端聚合的跨文件错误/警告,`/lsp/diagnostics/all`)可用时,
 *   tooltip 按「相对项目路径」分组列出真实代码行与简短错误消息,点击某条
 *   经 `onOpenFileAtLine` 打开文件并定位到该行(编辑器内波浪线为完整详情);
 * - `entries` 未加载时回退当前文件计数(`fileDiags`):有错误 → 红色 ✕、
 *   仅警告 → 琥珀 ⚠;无诊断 → 绿色 ✓。
 */
const DIAG_LIST_MAX = 12;

export function LspReadyIndicator({
  ready,
  onOpenLsp,
  fileDiags,
  entries,
  onOpenFileAtLine,
}: {
  ready: LspReady[];
  onOpenLsp: () => void;
  /** 当前编辑文件的 LSP 诊断计数(null = 无编辑文件或该文件无 LSP 支持) */
  fileDiags?: { errors: number; warnings: number } | null;
  /** 跨文件聚合的诊断条目(undefined = 尚未加载,回退 fileDiags 计数) */
  entries?: Api.LspDiagEntry[];
  /** 点击某条诊断跳转(打开文件并定位行,1-based) */
  onOpenFileAtLine?: (path: string, line: number) => void;
}) {
  const total = useMemo(() => {
    const errs = (entries ?? []).filter((e) => e.severity === 1).length;
    const warns = (entries ?? []).filter((e) => e.severity === 2).length;
    return { errs, warns };
  }, [entries]);
  // entries 已加载 → 以跨文件总数为准;否则回退当前文件计数
  const errs = entries ? total.errs : (fileDiags?.errors ?? 0);
  const warns = entries ? total.warns : (fileDiags?.warnings ?? 0);
  const hasErrors = errs > 0;
  const hasWarnings = warns > 0;
  const Icon = hasErrors ? CircleX : hasWarnings ? CircleAlert : CircleCheck;
  const iconCls = hasErrors
    ? 'text-destructive'
    : hasWarnings
      ? 'text-amber-500'
      : 'text-emerald-600 dark:text-emerald-400';
  const state = hasErrors ? 'error' : hasWarnings ? 'warning' : 'ready';
  // 按相对路径分组(entries 已按 severity→path→line 排序,组内顺序保留)
  const groups = useMemo(() => {
    const m = new Map<string, Api.LspDiagEntry[]>();
    for (const e of entries ?? []) {
      const arr = m.get(e.path);
      if (arr) arr.push(e);
      else m.set(e.path, [e]);
    }
    return [...m.entries()];
  }, [entries]);
  const visibleGroups = groups.slice(0, DIAG_LIST_MAX);
  const shownCount = visibleGroups.reduce((n, [, items]) => n + items.length, 0);
  const hidden = (entries?.length ?? 0) - shownCount;
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            data-testid="lsp-ready-indicator"
            data-state={state}
            aria-label={
              hasErrors
                ? `${errs} 个错误,点击查看 LSP 详情`
                : hasWarnings
                  ? `${warns} 个警告,点击查看 LSP 详情`
                  : '语言服务已就绪,点击查看详情'
            }
            title="语言服务状态"
            onClick={onOpenLsp}
            className={cn(
              'hover:bg-surface-hover flex justify-center items-center rounded-md size-6 transition-colors',
              iconCls,
            )}
          >
            <Icon className="size-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent
          side="bottom"
          align="end"
          className="flex flex-col items-start gap-1.5 max-w-[22rem]"
        >
          {hasErrors ? (
            <span
              data-lsp-file-state="error"
              className="flex items-center gap-1.5 font-medium text-destructive"
            >
              <CircleX className="size-3 shrink-0" />
              {entries ? '' : '当前文件:'}
              {errs} 个错误{hasWarnings ? ` / ${warns} 个警告` : ''}
            </span>
          ) : hasWarnings ? (
            <span
              data-lsp-file-state="warning"
              className="flex items-center gap-1.5 font-medium text-amber-600 dark:text-amber-400"
            >
              <CircleAlert className="size-3 shrink-0" />
              {entries ? '' : '当前文件:'}
              {warns} 个警告
            </span>
          ) : (
            <span className="flex items-center gap-1.5 font-medium">
              <CircleCheck className="size-3 shrink-0 text-emerald-600 dark:text-emerald-400" />
              语言服务已就绪
            </span>
          )}
          {groups.length > 0 && (
            <div className="flex flex-col gap-1.5 w-full max-h-56 overflow-y-auto">
              {visibleGroups.map(([path, items]) => (
                <div key={path} className="flex flex-col gap-0.5 min-w-0 w-full">
                  <span
                    className="font-mono text-[11px] text-muted-foreground truncate w-full"
                    title={path}
                  >
                    {path}
                  </span>
                  {items.map((e, i) => (
                    <button
                      key={`${path}:${e.line}:${i}`}
                      type="button"
                      data-lsp-diag-item={e.severity === 1 ? 'error' : 'warning'}
                      onClick={() => onOpenFileAtLine?.(e.path, e.line + 1)}
                      title={`${path}:${e.line + 1} ${e.message}`}
                      className="hover:bg-surface-hover flex items-baseline gap-1.5 w-full rounded px-1 -mx-1 text-left transition-colors"
                    >
                      <span
                        className={cn(
                          'font-mono text-[11px] tabular-nums shrink-0',
                          e.severity === 1
                            ? 'text-destructive'
                            : 'text-amber-600 dark:text-amber-400',
                        )}
                      >
                        {e.line + 1}
                      </span>
                      <span className="text-xs leading-snug truncate">{e.message}</span>
                    </button>
                  ))}
                </div>
              ))}
              {hidden > 0 && (
                <span className="text-muted-foreground text-xs">
                  还有 {hidden} 条未显示,编辑器内查看全部
                </span>
              )}
            </div>
          )}
          {ready.map((r) => (
            <span
              key={r.lang}
              data-lsp-ready-lang
              className="flex items-center gap-1.5 min-w-0 max-w-[16rem]"
            >
              <span
                aria-hidden
                className="size-1.5 rounded-full bg-emerald-500 shrink-0"
                title="已就绪"
              />
              <span className="font-medium whitespace-nowrap">{r.label}</span>
              <code className="font-mono text-muted-foreground break-all">{r.command}</code>
            </span>
          ))}
          <span className="pt-0.5 border-t border-card-border w-full text-muted-foreground">
            {groups.length > 0
              ? '点击条目跳转到对应行;编辑器内以波浪线标注具体位置'
              : hasErrors || hasWarnings
                ? '编辑器内以波浪线标注具体位置,保存后运行完整检查'
                : '代码诊断 / 跳转定义 / 引用查找 / 悬停信息工具已可用'}
          </span>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
