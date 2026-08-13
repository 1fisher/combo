import { useState } from 'react';
import { CheckCircle2, Circle, Loader2, ChevronDown, ListTodo } from 'lucide-react';
import type { Api } from '../../lib/api/types';
import { cn } from '../../lib/utils';

function StatusIcon({ status }: { status: Api.TodoStatus }) {
  switch (status) {
    case 'completed':
      return <CheckCircle2 className="size-3.5 shrink-0 text-green-500" />;
    case 'in_progress':
      return <Loader2 className="size-3.5 shrink-0 animate-spin text-brand" />;
    default:
      return <Circle className="size-3.5 shrink-0 text-muted-foreground/50" />;
  }
}

export function TodoList({ todos }: { todos: Api.TodoItem[] }) {
  const [collapsed, setCollapsed] = useState(false);
  if (todos.length === 0) return null;

  const completed = todos.filter((t) => t.status === 'completed').length;
  const total = todos.length;
  const inProgress = todos.find((t) => t.status === 'in_progress');
  const progress = total > 0 ? Math.round((completed / total) * 100) : 0;

  return (
    <div className="mx-4 mb-2 rounded-xl border border-border bg-surface/40">
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
        {!inProgress && (
          <div className="flex-1" />
        )}
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
      {!collapsed && (
        <div className="border-t border-border/50 px-3 py-1.5">
          {todos.map((t, i) => (
            <div
              key={i}
              className={cn(
                'flex items-start gap-2 py-1',
                t.status === 'completed' && 'opacity-50'
              )}
            >
              <div className="mt-0.5">
                <StatusIcon status={t.status} />
              </div>
              <span
                className={cn(
                  'text-xs leading-relaxed',
                  t.status === 'completed'
                    ? 'text-muted-foreground line-through'
                    : t.status === 'in_progress'
                      ? 'text-foreground'
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
