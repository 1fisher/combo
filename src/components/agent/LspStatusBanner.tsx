import { CircleAlert, X } from 'lucide-react';
import type { LspIssue } from '../../lib/lspStatus';
import { cn } from '../../lib/utils';

/**
 * 会话界面的 LSP 检测横幅:项目主要语言的 LSP 未就绪时显示在消息区上方,
 * - `not-found`(已配置但 PATH 中找不到可执行文件)→ 错误红,标题「语言服务检测异常」;
 * - `missing`(项目有该语言源码但未配置 server)→ 琥珀警告,标题「语言服务未配置」。
 *
 * 「去配置」跳转 LSP 服务视图(可一键安装/表单配置);「忽略」本次隐藏
 * (内存态,切换项目后自动复位重检)。
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
