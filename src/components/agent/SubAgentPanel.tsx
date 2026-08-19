import { useState } from 'react';
import {
  Bot,
  CheckCircle2,
  ChevronDown,
  Loader2,
  MinusCircle,
  Wrench,
  XCircle,
} from 'lucide-react';
import type { Api } from '../../lib/api/types';
import { cn } from '../../lib/utils';

/**
 * 子 agent 状态图标:
 * - running → 旋转 loader(执行中)
 * - done → 绿色对勾;error → 红色叉;cancelled → 灰色减号(被中止)
 */
function StatusIcon({ status }: { status: Api.SubAgentStatus }) {
  switch (status) {
    case 'running':
      return <Loader2 className="size-3.5 shrink-0 animate-spin text-brand" />;
    case 'done':
      return <CheckCircle2 className="size-3.5 shrink-0 fill-green-500/20 text-green-500" />;
    case 'error':
      return <XCircle className="size-3.5 shrink-0 text-red-500" />;
    default:
      return <MinusCircle className="size-3.5 shrink-0 text-muted-foreground/60" />;
  }
}

/**
 * 子 agent 进度卡片(multi-agent)。
 *
 * 显示在输入坞上方(与任务进度卡同区域):主 agent 通过 `agent` 工具派发的
 * 子任务实时状态——角色名 + 任务描述 + 最新动作预览 + 工具调用数。
 * run 结束时随 run_complete 清空(最终报告在消息流的 tool_result 卡片里)。
 */
export function SubAgentPanel({ tasks }: { tasks: Api.SubAgentTask[] }) {
  const [collapsed, setCollapsed] = useState(false);
  if (tasks.length === 0) return null;

  const done = tasks.filter((t) => t.status === 'done').length;
  const total = tasks.length;
  // 汇总行:任一仍在执行 → 显示第一个 running 任务的预览;全部结束 → 完成统计
  const current = tasks.find((t) => t.status === 'running');

  return (
    <div className="rounded-xl border border-border bg-surface/40 mx-4 mb-2">
      <button
        type="button"
        onClick={() => setCollapsed((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        <Bot className="size-3.5 shrink-0 text-brand" />
        <span className="text-xs font-medium text-foreground">
          子 agent {done}/{total}
        </span>
        {current ? (
          <span className="min-w-0 flex-1 truncate text-xs text-foreground-subtle">
            {current.preview || current.task}
          </span>
        ) : (
          <span className="ml-auto text-xs text-green-500">全部完成</span>
        )}
        <ChevronDown
          className={cn(
            'size-3.5 shrink-0 text-muted-foreground transition-transform',
            collapsed && '-rotate-90'
          )}
        />
      </button>
      {!collapsed && (
        <div className="max-h-48 overflow-y-auto overscroll-contain border-t border-border/50 px-3 py-1.5">
          {tasks.map((t) => (
            <div key={t.task_id} className="flex items-start gap-2 rounded-md py-1">
              <div className="mt-0.5">
                <StatusIcon status={t.status} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  {/* 角色名 badge */}
                  <span className="shrink-0 rounded bg-brand/10 px-1.5 py-0.5 text-[10px] font-medium text-brand">
                    {t.agent}
                  </span>
                  <span
                    className={cn(
                      'min-w-0 flex-1 truncate text-xs',
                      t.status === 'running'
                        ? 'font-medium text-foreground'
                        : 'text-foreground-subtle'
                    )}
                    title={t.task}
                  >
                    {t.task}
                  </span>
                  {(t.tool_calls ?? 0) > 0 && (
                    <span className="inline-flex shrink-0 items-center gap-0.5 text-[10px] text-muted-foreground">
                      <Wrench className="size-3" />
                      {t.tool_calls}
                    </span>
                  )}
                </div>
                {/* 最新动作/输出预览或错误 */}
                {t.status === 'error' && t.error ? (
                  <p className="truncate text-xs text-red-500/90" title={t.error}>
                    {t.error}
                  </p>
                ) : t.status === 'cancelled' ? (
                  <p className="truncate text-xs text-muted-foreground/60">已取消</p>
                ) : t.preview ? (
                  <p
                    className="truncate text-xs text-foreground-subtle/80"
                    title={t.preview}
                  >
                    {t.preview}
                  </p>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
