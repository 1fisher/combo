import { useState } from 'react';
import { CheckCircle2, Circle, Loader2, ChevronDown, ListTodo, CheckCheck } from 'lucide-react';
import type { Api } from '../../lib/api/types';
import { cn } from '../../lib/utils';

/**
 * 任务状态图标:
 * - in_progress → 旋转的 loader(loading 效果,表示正在处理该条)
 * - completed → 绿色对勾(明确的完成标记,不依赖变暗/透明)
 * - pending → 空心圆
 */
function StatusIcon({ status }: { status: Api.TodoStatus }) {
  switch (status) {
    case 'completed':
      return <CheckCircle2 className="size-3.5 shrink-0 fill-green-500/20 text-green-500" />;
    case 'in_progress':
      return <Loader2 className="size-3.5 shrink-0 animate-spin text-brand" />;
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
  const inProgress = todos.find((t) => t.status === 'in_progress');
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
          {inProgress && (
            <span className="min-w-0 flex-1 truncate text-xs text-foreground-subtle">
              {inProgress.active_form ?? inProgress.content}
            </span>
          )}
          {!inProgress && <div className="flex-1" />}
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
          {todos.map((t, i) => (
            <div
              key={i}
              className={cn(
                'flex items-start gap-2 rounded-md py-1',
                // 正在处理的那条:品牌色浅底 + 左侧竖线,突出「当前进行中」
                t.status === 'in_progress' && 'relative bg-brand/5 px-1.5'
              )}
            >
              {t.status === 'in_progress' && (
                <span className="absolute inset-y-1 left-0 w-0.5 rounded-full bg-brand" />
              )}
              <div className="mt-0.5">
                <StatusIcon status={t.status} />
              </div>
              <span
                className={cn(
                  'text-xs leading-relaxed',
                  t.status === 'completed'
                    ? // 完成:保持亮度(不变暗),用划线 + 对勾标记完成
                      'text-foreground line-through decoration-muted-foreground/60'
                    : t.status === 'in_progress'
                      ? 'font-medium text-foreground'
                      : 'text-foreground-subtle'
                )}
              >
                {t.status === 'in_progress' && t.active_form
                  ? t.active_form
                  : t.content}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
