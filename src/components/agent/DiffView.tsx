import { cn } from '../../lib/utils';
import type { DiffLine } from '../../lib/fileChanges';

export function DiffView({ lines, className }: { lines: DiffLine[]; className?: string }) {
  if (lines.length === 0) {
    return (
      <div className={cn('rounded-md border border-border bg-background px-3 py-2 text-xs text-muted-foreground', className)}>
        无差异
      </div>
    );
  }
  return (
    <div className={cn('overflow-x-auto rounded-md border border-border bg-background font-mono text-[11px] leading-5', className)}>
      {lines.map((line, i) => (
        <div
          key={i}
          className={cn(
            'flex items-start',
            line.type === 'add' && 'bg-green-500/10',
            line.type === 'remove' && 'bg-red-500/10',
          )}
        >
          {/* 旧行号 */}
          <span className="w-10 shrink-0 select-none pr-2 text-right text-muted-foreground/40">
            {line.oldLineNumber ?? ''}
          </span>
          {/* 新行号 */}
          <span className="w-10 shrink-0 select-none pr-2 text-right text-muted-foreground/40">
            {line.newLineNumber ?? ''}
          </span>
          {/* +/- 标记 */}
          <span
            className={cn(
              'w-4 shrink-0 select-none text-center',
              line.type === 'add' && 'text-green-500',
              line.type === 'remove' && 'text-red-500',
            )}
          >
            {line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' '}
          </span>
          {/* 内容 */}
          <span className="whitespace-pre-wrap break-all pr-2">
            {line.content || ' '}
          </span>
        </div>
      ))}
    </div>
  );
}
