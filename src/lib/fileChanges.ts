import { diffLines } from 'diff';
import type { MessageVM } from '../stores/agentStore';
import type { Api } from './api/types';

/** 涉及文件内容变更的工具名 */
const FILE_WRITE_TOOLS = new Set(['write', 'edit', 'multiedit', 'replace']);

export interface FileToolCall {
  id: string;
  name: 'write' | 'edit' | 'multiedit' | 'replace';
  path: string;
  /** write 工具的完整文件内容 */
  content?: string;
  /** edit/replace 工具的旧文本 / 新文本 */
  oldString?: string;
  newString?: string;
  /** replace 工具是否替换所有匹配 */
  replaceAll?: boolean;
  /** multiedit 工具的编辑列表 */
  edits?: Array<{ old_string: string; new_string: string }>;
  finished: boolean;
}

export interface DiffLine {
  type: 'add' | 'remove' | 'context';
  content: string;
  oldLineNumber: number | null;
  newLineNumber: number | null;
}

export interface FileChangeSummary {
  path: string;
  toolCalls: FileToolCall[];
  additions: number;
  deletions: number;
}

/** 从工具输入 JSON 提取文件路径 */
function extractPath(input: Record<string, unknown>): string | null {
  for (const key of ['file_path', 'path', 'filePath', 'filename']) {
    const v = input[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

/** 解析单个 tool_call,提取文件变更信息 */
function parseToolCall(tc: Api.ToolCall): FileToolCall | null {
  if (!FILE_WRITE_TOOLS.has(tc.name)) return null;
  let input: Record<string, unknown>;
  try {
    input = JSON.parse(tc.input) as Record<string, unknown>;
  } catch {
    return null;
  }
  const path = extractPath(input);
  if (!path) return null;

  const base = { id: tc.id, name: tc.name as FileToolCall['name'], path, finished: tc.finished ?? false };

  if (tc.name === 'write') {
    return { ...base, content: typeof input.content === 'string' ? input.content : '' };
  }
  if (tc.name === 'edit' || tc.name === 'replace') {
    return {
      ...base,
      oldString: typeof input.old_string === 'string' ? input.old_string : '',
      newString: typeof input.new_string === 'string' ? input.new_string : '',
      replaceAll: tc.name === 'replace' ? input.replace_all === true : undefined,
    };
  }
  // multiedit
  const edits = Array.isArray(input.edits)
    ? input.edits
        .filter((e): e is Record<string, unknown> => typeof e === 'object' && e !== null)
        .map((e) => ({
          old_string: typeof e.old_string === 'string' ? e.old_string : '',
          new_string: typeof e.new_string === 'string' ? e.new_string : '',
        }))
    : [];
  return { ...base, edits };
}

/** 从会话消息中提取所有文件变更工具调用(按时间顺序) */
export function extractFileToolCalls(messages: MessageVM[]): FileToolCall[] {
  const calls: FileToolCall[] = [];
  for (const msg of messages) {
    for (const part of msg.parts ?? []) {
      if (part.type !== 'tool_call') continue;
      const parsed = parseToolCall(part.data as Api.ToolCall);
      if (parsed) calls.push(parsed);
    }
  }
  return calls;
}

/** 按文件路径分组,每个路径保留按时间顺序的操作列表 */
export function groupByPath(calls: FileToolCall[]): Map<string, FileToolCall[]> {
  const map = new Map<string, FileToolCall[]>();
  for (const call of calls) {
    const arr = map.get(call.path);
    if (arr) arr.push(call);
    else map.set(call.path, [call]);
  }
  return map;
}

/**
 * 反向应用操作列表,从磁盘当前内容(atAfter)重建原始内容。
 * 遇到 write 操作时,原始内容不可恢复(被完全覆盖),返回空串。
 */
export function reconstructBefore(atAfter: string, toolCalls: FileToolCall[]): string {
  let content = atAfter;
  for (let i = toolCalls.length - 1; i >= 0; i--) {
    const op = toolCalls[i];
    if (op.name === 'write') {
      // write 完全覆盖文件,此前的原始内容无法恢复
      return '';
    }
    if (op.name === 'edit' && op.newString !== undefined && op.oldString !== undefined) {
      content = replaceFirst(content, op.newString, op.oldString);
    } else if (op.name === 'replace' && op.newString !== undefined && op.oldString !== undefined) {
      // replace_all=true 时反向替换所有匹配,否则只替换第一处
      if (op.replaceAll) {
        content = content.split(op.newString).join(op.oldString);
      } else {
        content = replaceFirst(content, op.newString, op.oldString);
      }
    } else if (op.name === 'multiedit' && op.edits) {
      for (let j = op.edits.length - 1; j >= 0; j--) {
        content = replaceFirst(content, op.edits[j].new_string, op.edits[j].old_string);
      }
    }
  }
  return content;
}

/** 替换第一次出现(与 edit 工具语义一致) */
function replaceFirst(text: string, search: string, replace: string): string {
  if (search === '') return text;
  const idx = text.indexOf(search);
  if (idx === -1) return text;
  return text.slice(0, idx) + replace + text.slice(idx + search.length);
}

/** 当无法从磁盘获取内容时,从工具调用前向重建最终内容 */
export function reconstructAfter(toolCalls: FileToolCall[]): string {
  let content = '';
  for (const op of toolCalls) {
    if (op.name === 'write' && op.content !== undefined) {
      content = op.content;
    } else if ((op.name === 'edit' || op.name === 'replace') && op.oldString !== undefined && op.newString !== undefined) {
      if (op.name === 'replace' && op.replaceAll) {
        content = content.split(op.oldString).join(op.newString);
      } else {
        content = replaceFirst(content, op.oldString, op.newString);
      }
    } else if (op.name === 'multiedit' && op.edits) {
      for (const e of op.edits) {
        content = replaceFirst(content, e.old_string, e.new_string);
      }
    }
  }
  return content;
}

/** 计算行级 diff */
export function computeDiffLines(before: string, after: string): DiffLine[] {
  const parts = diffLines(before, after);
  const lines: DiffLine[] = [];
  let oldLine = 1;
  let newLine = 1;
  for (const part of parts) {
    const raw = part.value;
    // 去掉末尾换行产生的空行
    const partLines = raw.endsWith('\n') ? raw.slice(0, -1).split('\n') : raw.split('\n');
    for (const line of partLines) {
      if (part.added) {
        lines.push({ type: 'add', content: line, oldLineNumber: null, newLineNumber: newLine++ });
      } else if (part.removed) {
        lines.push({ type: 'remove', content: line, oldLineNumber: oldLine++, newLineNumber: null });
      } else {
        lines.push({ type: 'context', content: line, oldLineNumber: oldLine++, newLineNumber: newLine++ });
      }
    }
  }
  return lines;
}

/** 从 DiffLine 列表统计增删行数 */
export function countChanges(lines: DiffLine[]): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of lines) {
    if (line.type === 'add') additions++;
    else if (line.type === 'remove') deletions++;
  }
  return { additions, deletions };
}

/**
 * 从工具调用原始输入 JSON 计算 diff 行。
 * - edit: 比较 old_string → new_string
 * - multiedit: 依次对每对 old/new 做 diff,段间插入分隔行
 * - write: 无 before,全部内容标记为新增
 */
export function diffFromToolInput(
  toolName: string,
  inputJson: string,
): DiffLine[] | null {
  let input: Record<string, unknown>;
  try {
    input = JSON.parse(inputJson) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (toolName === 'edit' || toolName === 'replace') {
    const oldStr = typeof input.old_string === 'string' ? input.old_string : '';
    const newStr = typeof input.new_string === 'string' ? input.new_string : '';
    return computeDiffLines(oldStr, newStr);
  }
  if (toolName === 'multiedit' && Array.isArray(input.edits)) {
    const result: DiffLine[] = [];
    let oldLine = 1;
    let newLine = 1;
    for (const e of input.edits) {
      if (typeof e !== 'object' || e === null) continue;
      const oldStr = typeof e.old_string === 'string' ? e.old_string : '';
      const newStr = typeof e.new_string === 'string' ? e.new_string : '';
      const partDiff = computeDiffLines(oldStr, newStr);
      // 重新编号
      for (const dl of partDiff) {
        if (dl.type === 'add') {
          result.push({ ...dl, oldLineNumber: null, newLineNumber: newLine++ });
        } else if (dl.type === 'remove') {
          result.push({ ...dl, oldLineNumber: oldLine++, newLineNumber: null });
        } else {
          result.push({ ...dl, oldLineNumber: oldLine++, newLineNumber: newLine++ });
        }
      }
      // 段间分隔
      result.push({ type: 'context', content: '⋯', oldLineNumber: null, newLineNumber: null });
    }
    return result;
  }
  if (toolName === 'write') {
    const content = typeof input.content === 'string' ? input.content : '';
    const partLines = content.endsWith('\n') ? content.slice(0, -1).split('\n') : content.split('\n');
    return partLines.map((line, i) => ({
      type: 'add' as const,
      content: line,
      oldLineNumber: null,
      newLineNumber: i + 1,
    }));
  }
  return null;
}
