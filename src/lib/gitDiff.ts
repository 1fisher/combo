import { diffLines } from 'diff';

/** 单行的 git 变更状态 */
export type LineChangeType = 'added' | 'modified' | 'removed';

/**
 * 从 HEAD 内容和当前内容计算每行的变更状态。
 * 返回 Map<当前文件行号(1-based), LineChangeType>。
 * added: 新增行(modified 块中的新增行标记为 modified)
 */
export function computeLineChanges(
  headContent: string,
  currentContent: string
): Map<number, LineChangeType> {
  const result = new Map<number, LineChangeType>();
  if (headContent === currentContent) return result;

  const parts = diffLines(headContent, currentContent);
  let newLine = 1;

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const raw = part.value;
    const lines = raw.endsWith('\n') ? raw.slice(0, -1).split('\n') : raw.split('\n');

    if (part.removed) {
      // 检查下一个 part 是否是 added(即修改,而非纯删除)
      const nextPart = parts[i + 1];
      const isModification = nextPart && nextPart.added;

      if (isModification) {
        // 修改:下一个 added 块中的行标记为 modified
        const nextRaw = nextPart.value;
        const nextLines = nextRaw.endsWith('\n')
          ? nextRaw.slice(0, -1).split('\n')
          : nextRaw.split('\n');
        for (const _line of nextLines) {
          result.set(newLine, 'modified');
          newLine++;
        }
        i++; // 跳过下一个 part(已处理)
      }
      // 纯删除:当前文件中没有对应行,不标记(仅在 gutter 边缘显示)
    } else if (part.added) {
      for (const _line of lines) {
        result.set(newLine, 'added');
        newLine++;
      }
    } else {
      // 上下文(未变更)
      newLine += lines.length;
    }
  }

  return result;
}

/** 统计增删行数 */
export function countLineChanges(changes: Map<number, LineChangeType>): {
  additions: number;
  modifications: number;
} {
  let additions = 0;
  let modifications = 0;
  for (const type of changes.values()) {
    if (type === 'added') additions++;
    else if (type === 'modified') modifications++;
  }
  return { additions, modifications };
}

/**
 * 解析 unified diff 文本为 DiffLine 数组(用于 diff 视图)。
 * 复用 fileChanges 中的 DiffLine 类型。
 */
export interface UnifiedDiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: Array<{ type: 'add' | 'remove' | 'context'; content: string }>;
}

/** 解析 unified diff(`git diff` 输出)为结构化 hunk 列表 */
export function parseUnifiedDiff(diffText: string): UnifiedDiffHunk[] {
  const hunks: UnifiedDiffHunk[] = [];
  const lines = diffText.split('\n');
  let currentHunk: UnifiedDiffHunk | null = null;

  for (const line of lines) {
    if (line.startsWith('@@')) {
      if (currentHunk) hunks.push(currentHunk);
      // @@ -oldStart,oldLines +newStart,newLines @@
      const match = line.match(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (match) {
        currentHunk = {
          oldStart: parseInt(match[1], 10),
          oldLines: match[2] ? parseInt(match[2], 10) : 1,
          newStart: match[3] ? parseInt(match[3], 10) : 1,
          newLines: match[4] ? parseInt(match[4], 10) : 1,
          lines: [],
        };
      }
    } else if (currentHunk) {
      if (line.startsWith('+')) {
        currentHunk.lines.push({ type: 'add', content: line.slice(1) });
      } else if (line.startsWith('-')) {
        currentHunk.lines.push({ type: 'remove', content: line.slice(1) });
      } else if (line.startsWith(' ')) {
        currentHunk.lines.push({ type: 'context', content: line.slice(1) });
      } else if (line === '' || line === '\\ No newline at end of file') {
        // 空行或末尾标记,跳过
      }
    }
  }
  if (currentHunk) hunks.push(currentHunk);
  return hunks;
}
