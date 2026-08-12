import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { cn } from '../../lib/utils';
import {
  groupDiffWithContext,
  type DiffLine,
  type DiffSection,
} from '../../lib/fileChanges';

export function DiffView({
  lines,
  className,
  contextSize = 3,
}: {
  lines: DiffLine[];
  className?: string;
  contextSize?: number;
}) {
  if (lines.length === 0) {
    return (
      <div className={cn('rounded-md border border-border bg-background px-3 py-2 text-xs text-muted-foreground', className)}>
        无差异
      </div>
    );
  }

  const sections = groupDiffWithContext(lines, contextSize);

  return (
    <div className={cn('overflow-x-auto rounded-md border border-border bg-background font-mono text-[11px] leading-5', className)}>
      {sections.map((section, si) =>
        section.type === 'skip' ? (
          <SkipSection key={si} section={section} />
        ) : (
          section.lines.map((line, li) => <DiffRow key={`s${si}-${li}`} line={line} />)
        ),
      )}
    </div>
  );
}

function SkipSection({ section }: { section: DiffSection }) {
  const [expanded, setExpanded] = useState(false);
  if (expanded) {
    return (
      <>
        <button
          onClick={() => setExpanded(false)}
          className="flex w-full items-center justify-center gap-1 border-y border-border/50 bg-muted/20 py-0.5 text-[10px] text-muted-foreground/60 transition-colors hover:bg-muted/40"
        >
          <ChevronRight className="size-2.5 rotate-90" />
          收起未变更代码
        </button>
        {section.lines.map((line, i) => (
          <DiffRow key={`skip-${i}`} line={line} dim />
        ))}
      </>
    );
  }
  return (
    <button
      onClick={() => setExpanded(true)}
      className="flex w-full items-center justify-center gap-1 border-y border-border/50 bg-muted/20 py-0.5 text-[10px] text-muted-foreground/60 transition-colors hover:bg-muted/40"
    >
      <ChevronRight className="size-2.5" />
      {section.skipCount} 行未变更
    </button>
  );
}

function DiffRow({ line, dim }: { line: DiffLine; dim?: boolean }) {
  return (
    <div
      className={cn(
        'flex items-start',
        line.type === 'add' && 'bg-green-500/10',
        line.type === 'remove' && 'bg-red-500/10',
        dim && 'opacity-40',
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
  );
}
