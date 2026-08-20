import { CircleAlert, CircleCheck, CircleX, X } from 'lucide-react';
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
 * 悬停弹出 tooltip 显示就绪详情(语言 + server + 可用工具),点击跳 LSP 视图
 * (触屏没有 hover,点击兜底)。与 Composer「完全访问」的 icon+tooltip 范式一致。
 *
 * 联动当前编辑文件 的实时诊断计数(`fileDiags`):
 * 有错误 → 红色 ✕、tooltip 顶部报「N 个错误」;仅警告 → 琥珀 ⚠;
 * 无诊断 → 绿色 ✓。编辑器内的具体波浪线由 CodeMirror linter 渲染。
 */
export function LspReadyIndicator({
  ready,
  onOpenLsp,
  fileDiags,
}: {
  ready: LspReady[];
  onOpenLsp: () => void;
  /** 当前编辑文件的 LSP 诊断计数(null = 无编辑文件或该文件无 LSP 支持) */
  fileDiags?: { errors: number; warnings: number } | null;
}) {
  const hasErrors = (fileDiags?.errors ?? 0) > 0;
  const hasWarnings = (fileDiags?.warnings ?? 0) > 0;
  const Icon = hasErrors ? CircleX : hasWarnings ? CircleAlert : CircleCheck;
  const iconCls = hasErrors
    ? 'text-destructive'
    : hasWarnings
      ? 'text-amber-500'
      : 'text-emerald-600 dark:text-emerald-400';
  const state = hasErrors ? 'error' : hasWarnings ? 'warning' : 'ready';
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
                ? `当前文件有 ${fileDiags!.errors} 个错误,点击查看 LSP 详情`
                : hasWarnings
                  ? `当前文件有 ${fileDiags!.warnings} 个警告,点击查看 LSP 详情`
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
        <TooltipContent side="bottom" align="end" className="flex flex-col items-start gap-1">
          {hasErrors ? (
            <span data-lsp-file-state="error" className="flex items-center gap-1.5 font-medium text-destructive">
              <CircleX className="size-3 shrink-0" />
              当前文件:{fileDiags!.errors} 个错误{hasWarnings ? ` / ${fileDiags!.warnings} 个警告` : ''}
            </span>
          ) : hasWarnings ? (
            <span data-lsp-file-state="warning" className="flex items-center gap-1.5 font-medium text-amber-600 dark:text-amber-400">
              <CircleAlert className="size-3 shrink-0" />
              当前文件:{fileDiags!.warnings} 个警告
            </span>
          ) : (
            <span className="flex items-center gap-1.5 font-medium">
              <CircleCheck className="size-3 shrink-0 text-emerald-600 dark:text-emerald-400" />
              语言服务已就绪
            </span>
          )}
          {ready.map((r) => (
            <span key={r.lang} data-lsp-ready-lang className="flex items-center gap-1.5 min-w-0 max-w-[16rem]">
              <span
                aria-hidden
                className="size-1.5 rounded-full bg-emerald-500 shrink-0"
                title="已就绪"
              />
              <span className="font-medium whitespace-nowrap">{r.label}</span>
              <code className="font-mono text-muted-foreground break-all">{r.command}</code>
              <span className="text-muted-foreground whitespace-nowrap">({r.files} 个源文件)</span>
            </span>
          ))}
          <span className="pt-0.5 border-t border-card-border w-full text-muted-foreground">
            {hasErrors || hasWarnings
              ? '编辑器内以波浪线标注具体位置,保存后运行完整检查'
              : '代码诊断 / 跳转定义 / 引用查找 / 悬停信息工具已可用'}
          </span>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
