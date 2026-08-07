import { cn } from '../../lib/utils';

type TermLineType = 'add' | 'remove' | 'hunk' | 'meta' | 'file-add' | 'file-del' | 'normal';

/** 将终端输出的一行分类为 diff 语义类型 */
function classifyLine(line: string): TermLineType {
  // unified diff 元信息(必须在 +/- 之前判断)
  if (
    line.startsWith('diff --git') ||
    line.startsWith('diff -') ||
    line.startsWith('index ') ||
    line.startsWith('rename from') ||
    line.startsWith('rename to') ||
    line.startsWith('old mode') ||
    line.startsWith('new mode') ||
    line.startsWith('similarity index') ||
    line.startsWith('copy from') ||
    line.startsWith('copy to')
  ) {
    return 'meta';
  }
  if (line.startsWith('---') || line.startsWith('+++')) return 'meta';
  if (line.startsWith('@@')) return 'hunk';
  // unified diff 内容行
  if (line.startsWith('+')) return 'add';
  if (line.startsWith('-')) return 'remove';
  // 文件操作信息行
  if (/create mode|new file:|file.*created|file.*written|创建.*文件|写入文件|写入成功/i.test(line)) return 'file-add';
  if (/delete mode|deleted:|file.*deleted|删除.*文件/i.test(line)) return 'file-del';
  return 'normal';
}

const LINE_STYLES: Record<TermLineType, string> = {
  add: 'bg-green-500/10 text-green-400',
  remove: 'bg-red-500/10 text-red-400',
  hunk: 'text-cyan-400',
  meta: 'text-blue-400',
  'file-add': 'text-green-400',
  'file-del': 'text-red-400',
  normal: '',
};

export function TerminalOutput({ content, className }: { content: string; className?: string }) {
  const lines = content.split('\n');
  // 判断是否包含 diff 内容,决定是否渲染行号列
  const hasDiff = lines.some(
    (l) => l.startsWith('+') || l.startsWith('-') || l.startsWith('@@'),
  );
  return (
    <pre
      className={cn(
        'max-h-[60vh] overflow-auto bg-background px-3 py-2 font-mono text-[11px] leading-5',
        className,
      )}
    >
      {lines.map((line, i) => {
        const type = classifyLine(line);
        return (
          <div key={i} className={cn('flex items-start', LINE_STYLES[type])}>
            {hasDiff && (
              <span className="w-4 shrink-0 select-none text-center">
                {type === 'add' ? '+' : type === 'remove' ? '-' : ''}
              </span>
            )}
            <span className="whitespace-pre-wrap break-all">{line || ' '}</span>
          </div>
        );
      })}
    </pre>
  );
}
