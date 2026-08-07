import { describe, it, expect } from 'vitest';
import {
  extractFileToolCalls,
  groupByPath,
  reconstructBefore,
  reconstructAfter,
  computeDiffLines,
  countChanges,
  diffFromToolInput,
} from './fileChanges';
import type { MessageVM } from '../stores/agentStore';
import type { Api } from './api/types';

function mkMsg(parts: Api.ContentPart[]): MessageVM {
  return {
    id: Math.random().toString(36),
    role: 'assistant',
    parts,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    streaming: false,
  };
}

function toolCall(name: string, input: Record<string, unknown>): Api.ContentPart {
  return { type: 'tool_call', data: { id: `tc-${Math.random()}`, name, input: JSON.stringify(input), finished: true } };
}

describe('extractFileToolCalls', () => {
  it('extracts write/edit/multiedit calls', () => {
    const msgs: MessageVM[] = [
      mkMsg([
        toolCall('write', { file_path: 'src/a.ts', content: 'hello' }),
        toolCall('edit', { file_path: 'src/b.ts', old_string: 'foo', new_string: 'bar' }),
        toolCall('multiedit', {
          file_path: 'src/c.ts',
          edits: [
            { old_string: 'a', new_string: 'b' },
            { old_string: 'c', new_string: 'd' },
          ],
        }),
        toolCall('bash', { command: 'ls' }),
        toolCall('read', { file_path: 'src/d.ts' }),
      ]),
    ];
    const calls = extractFileToolCalls(msgs);
    expect(calls).toHaveLength(3);
    expect(calls[0].name).toBe('write');
    expect(calls[0].path).toBe('src/a.ts');
    expect(calls[0].content).toBe('hello');
    expect(calls[1].name).toBe('edit');
    expect(calls[1].oldString).toBe('foo');
    expect(calls[1].newString).toBe('bar');
    expect(calls[2].name).toBe('multiedit');
    expect(calls[2].edits).toHaveLength(2);
  });

  it('skips tool calls without a path', () => {
    const msgs: MessageVM[] = [
      mkMsg([toolCall('write', { content: 'no path' })]),
    ];
    expect(extractFileToolCalls(msgs)).toHaveLength(0);
  });

  it('handles non-JSON input gracefully', () => {
    const msgs: MessageVM[] = [
      mkMsg([{ type: 'tool_call', data: { id: 'x', name: 'write', input: '{bad json', finished: true } }]),
    ];
    expect(extractFileToolCalls(msgs)).toHaveLength(0);
  });
});

describe('groupByPath', () => {
  it('groups calls by file path preserving order', () => {
    const msgs: MessageVM[] = [
      mkMsg([
        toolCall('edit', { file_path: 'a.ts', old_string: '1', new_string: '2' }),
        toolCall('edit', { file_path: 'b.ts', old_string: '3', new_string: '4' }),
        toolCall('edit', { file_path: 'a.ts', old_string: '5', new_string: '6' }),
      ]),
    ];
    const calls = extractFileToolCalls(msgs);
    const grouped = groupByPath(calls);
    expect(grouped.get('a.ts')).toHaveLength(2);
    expect(grouped.get('b.ts')).toHaveLength(1);
  });
});

describe('reconstructBefore', () => {
  it('reverses a single edit', () => {
    const calls = extractFileToolCalls([
      mkMsg([toolCall('edit', { file_path: 'f.ts', old_string: 'world', new_string: 'WORLD' })]),
    ]);
    const after = 'hello WORLD';
    const before = reconstructBefore(after, calls);
    expect(before).toBe('hello world');
  });

  it('reverses multiple sequential edits', () => {
    const calls = extractFileToolCalls([
      mkMsg([
        toolCall('edit', { file_path: 'f.ts', old_string: 'a', new_string: 'A' }),
        toolCall('edit', { file_path: 'f.ts', old_string: 'b', new_string: 'B' }),
      ]),
    ]);
    const after = 'A_B_C';
    const before = reconstructBefore(after, calls);
    expect(before).toBe('a_b_C');
  });

  it('reverses multiedit', () => {
    const calls = extractFileToolCalls([
      mkMsg([
        toolCall('multiedit', {
          file_path: 'f.ts',
          edits: [
            { old_string: 'x', new_string: 'X' },
            { old_string: 'y', new_string: 'Y' },
          ],
        }),
      ]),
    ]);
    const after = 'X_Y_';
    const before = reconstructBefore(after, calls);
    expect(before).toBe('x_y_');
  });

  it('returns empty string when a write is in the chain', () => {
    const calls = extractFileToolCalls([
      mkMsg([toolCall('write', { file_path: 'f.ts', content: 'new content' })]),
    ]);
    const before = reconstructBefore('new content', calls);
    expect(before).toBe('');
  });
});

describe('reconstructAfter', () => {
  it('builds content from write', () => {
    const calls = extractFileToolCalls([
      mkMsg([toolCall('write', { file_path: 'f.ts', content: 'hello world' })]),
    ]);
    expect(reconstructAfter(calls)).toBe('hello world');
  });

  it('applies edits on top of write', () => {
    const calls = extractFileToolCalls([
      mkMsg([
        toolCall('write', { file_path: 'f.ts', content: 'hello world' }),
        toolCall('edit', { file_path: 'f.ts', old_string: 'world', new_string: 'there' }),
      ]),
    ]);
    expect(reconstructAfter(calls)).toBe('hello there');
  });
});

describe('computeDiffLines', () => {
  it('detects additions', () => {
    const before = 'line1\nline3';
    const after = 'line1\nline2\nline3';
    const lines = computeDiffLines(before, after);
    const added = lines.filter((l) => l.type === 'add');
    expect(added).toHaveLength(1);
    expect(added[0].content).toBe('line2');
  });

  it('detects deletions', () => {
    const before = 'line1\nline2\nline3';
    const after = 'line1\nline3';
    const lines = computeDiffLines(before, after);
    const removed = lines.filter((l) => l.type === 'remove');
    expect(removed).toHaveLength(1);
    expect(removed[0].content).toBe('line2');
  });

  it('returns empty for identical content', () => {
    const lines = computeDiffLines('same\ncontent', 'same\ncontent');
    expect(lines.every((l) => l.type === 'context')).toBe(true);
  });

  it('tracks line numbers correctly', () => {
    const before = 'a\nb\nc';
    const after = 'a\nB\nc';
    const lines = computeDiffLines(before, after);
    const removed = lines.find((l) => l.type === 'remove');
    const added = lines.find((l) => l.type === 'add');
    expect(removed?.oldLineNumber).toBe(2);
    expect(removed?.newLineNumber).toBeNull();
    expect(added?.newLineNumber).toBe(2);
    expect(added?.oldLineNumber).toBeNull();
  });
});

describe('countChanges', () => {
  it('counts additions and deletions', () => {
    const lines = computeDiffLines('a\nb\nc', 'a\nB\nC\nd');
    const { additions, deletions } = countChanges(lines);
    expect(additions).toBe(3);
    expect(deletions).toBe(2);
  });
});

describe('diffFromToolInput', () => {
  it('computes diff for edit tool', () => {
    const input = JSON.stringify({ file_path: 'f.ts', old_string: 'hello\nworld', new_string: 'hello\nWORLD' });
    const lines = diffFromToolInput('edit', input);
    expect(lines).not.toBeNull();
    const removed = lines!.filter((l) => l.type === 'remove');
    const added = lines!.filter((l) => l.type === 'add');
    expect(removed).toHaveLength(1);
    expect(removed[0].content).toBe('world');
    expect(added).toHaveLength(1);
    expect(added[0].content).toBe('WORLD');
  });

  it('computes diff for multiedit tool with separator lines', () => {
    const input = JSON.stringify({
      file_path: 'f.ts',
      edits: [
        { old_string: 'a', new_string: 'A' },
        { old_string: 'b', new_string: 'B' },
      ],
    });
    const lines = diffFromToolInput('multiedit', input);
    expect(lines).not.toBeNull();
    // 每段各产生 remove+add,段间有分隔行
    const separators = lines!.filter((l) => l.content === '⋯');
    expect(separators.length).toBeGreaterThanOrEqual(1);
    const added = lines!.filter((l) => l.type === 'add').map((l) => l.content);
    expect(added).toEqual(expect.arrayContaining(['A', 'B']));
  });

  it('marks all content as additions for write tool', () => {
    const input = JSON.stringify({ file_path: 'f.ts', content: 'line1\nline2\nline3' });
    const lines = diffFromToolInput('write', input);
    expect(lines).not.toBeNull();
    expect(lines!.every((l) => l.type === 'add')).toBe(true);
    expect(lines).toHaveLength(3);
    expect(lines![1].newLineNumber).toBe(2);
  });

  it('returns null for unknown tool names', () => {
    expect(diffFromToolInput('bash', '{"command":"ls"}')).toBeNull();
  });

  it('returns null for invalid JSON', () => {
    expect(diffFromToolInput('edit', '{bad')).toBeNull();
  });
});
