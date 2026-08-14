import { useState } from 'react';
import { CheckCircle2, Circle, Loader2, ChevronDown, ListTodo, CheckCheck } from 'lucide-react';
import type { Api } from '../../lib/api/types';
import { cn } from '../../lib/utils';

/**
 * 任务状态图标:
 * - 当前处理项(真实 in_progress,或展示层兜底推导的第一条 pending)→ 旋转的
 *   loader(loading 效果,表示正在处理该条)
 * - completed → 绿色对勾(明确的完成标记,不依赖变暗/透明)
 * - 其余 pending → 空心圆
 */
function StatusIcon({ status, active }: { status: Api.TodoStatus; active?: boolean }) {
  if (active || status === 'in_progress') {
    return <Loader2 className="size-3.5 shrink-0 animate-spin text-brand" />;
  }
  switch (status) {
    case 'completed':
      return <CheckCircle2 className="size-3.5 shrink-0 fill-green-500/20 text-green-500" />;
    default:
      return <Circle className="size-3.5 shrink-0 text-muted-foreground/50" />;
  }
}

/**
 * 任务列表卡片。
 *
 * - `active`(默认,显示在输入坞上方):实时追踪 agent 执行进度,含进度条与折叠;
 * - `archived`(显示在消息流中):上一轮已全部完成的任务清单,静态展示。
 */
export function TodoList({
  todos,
  variant = 'active',
}: {
  todos: Api.TodoItem[];
  variant?: 'active' | 'archived';
}) {
  const [collapsed, setCollapsed] = useState(false);
  if (todos.length === 0) return null;

  const completed = todos.filter((t) => t.status === 'completed').length;
  const total = todos.length;
  // 当前正在处理的那条:优先真实 in_progress;若列表中没有任何 in_progress
  // (如 agent 一次性提交全 pending,或后端未及时标记),则展示层兜底默认把
  // 第一条未完成(pending)推导为「正在处理」—— 保证「默认处理第一条」、
  // 「当前完成后自动推进到下一条」的语义在前端始终可见(不修改 store,纯展示)。
  const inProgressIndex = todos.findIndex((t) => t.status === 'in_progress');
  const currentIndex =
    inProgressIndex >= 0 ? inProgressIndex : todos.findIndex((t) => t.status === 'pending');
  const current = currentIndex >= 0 ? todos[currentIndex] : undefined;
  const progress = total > 0 ? Math.round((completed / total) * 100) : 0;

  const archived = variant === 'archived';

  return (
    <div
      className={cn(
        'rounded-xl border border-border bg-surface/40',
        archived ? 'mx-0' : 'mx-4 mb-2'
      )}
    >
      {archived ? (
        <div className="flex items-center gap-2 px-3 py-2">
          <CheckCheck className="size-3.5 shrink-0 text-green-500" />
          <span className="text-xs font-medium text-foreground">任务清单</span>
          <span className="ml-auto inline-flex items-center gap-1 text-xs text-green-500">
            <CheckCircle2 className="size-3.5" />
            已完成 {completed}/{total}
          </span>
          <ChevronDown
            className={cn(
              'size-3.5 shrink-0 text-muted-foreground transition-transform',
              collapsed && '-rotate-90'
            )}
            onClick={() => setCollapsed((v) => !v)}
          />
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setCollapsed((v) => !v)}
          className="flex w-full items-center gap-2 px-3 py-2 text-left"
        >
          <ListTodo className="size-3.5 shrink-0 text-brand" />
          <span className="text-xs font-medium text-foreground">
            任务进度 {completed}/{total}
          </span>
          {current && (
            <span className="min-w-0 flex-1 truncate text-xs text-foreground-subtle">
              {current.active_form ?? current.content}
            </span>
          )}
          {!current && <div className="flex-1" />}
          <div className="h-1 w-16 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-brand transition-all duration-300"
              style={{ width: `${progress}%` }}
            />
          </div>
          <ChevronDown
            className={cn(
              'size-3.5 shrink-0 text-muted-foreground transition-transform',
              collapsed && '-rotate-90'
            )}
          />
        </button>
      )}
      {!collapsed && (
        <div
          className={cn(
            'border-t border-border/50 px-3 py-1.5',
            // 输入坞上方的实时列表限高,项多时内部滚动,避免挤压 Composer
            !archived && 'max-h-48 overflow-y-auto overscroll-contain'
          )}
        >
          {todos.map((t, i) => {
            const isCurrent = i === currentIndex;
            return (
              <div
                key={i}
                className={cn(
                  'flex items-start gap-2 rounded-md py-1',
                  // 正在处理的那条:品牌色浅底 + 左侧竖线,突出「当前进行中」
                  isCurrent && 'relative bg-brand/5 px-1.5'
                )}
              >
                {isCurrent && (
                  <span className="absolute inset-y-1 left-0 w-0.5 rounded-full bg-brand" />
                )}
                <div className="mt-0.5">
                  <StatusIcon status={t.status} active={isCurrent} />
                </div>
                <span
                  className={cn(
                    'text-xs leading-relaxed',
                    t.status === 'completed'
                      ? // 完成:保持亮度(不变暗),用划线 + 对勾标记完成
                        'text-foreground line-through decoration-muted-foreground/60'
                      : isCurrent
                        ? 'font-medium text-foreground'
                        : 'text-foreground-subtle'
                  )}
                >
                  {isCurrent && t.active_form ? t.active_form : t.content}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
