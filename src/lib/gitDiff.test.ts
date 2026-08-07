import { describe, it, expect } from 'vitest';
import { computeLineChanges, countLineChanges, parseUnifiedDiff } from './gitDiff';

describe('computeLineChanges', () => {
  it('returns empty map when content is identical', () => {
    const content = 'line1\nline2\nline3';
    const changes = computeLineChanges(content, content);
    expect(changes.size).toBe(0);
  });

  it('marks all lines as added for a new file (empty HEAD)', () => {
    const head = '';
    const current = 'line1\nline2\nline3';
    const changes = computeLineChanges(head, current);
    expect(changes.size).toBe(3);
    expect(changes.get(1)).toBe('added');
    expect(changes.get(2)).toBe('added');
    expect(changes.get(3)).toBe('added');
  });

  it('marks appended lines as added', () => {
    const head = 'line1\nline2\n';
    const current = 'line1\nline2\nline3\nline4\n';
    const changes = computeLineChanges(head, current);
    expect(changes.size).toBe(2);
    expect(changes.get(3)).toBe('added');
    expect(changes.get(4)).toBe('added');
  });

  it('marks modified lines correctly', () => {
    const head = 'line1\nold\nline3\n';
    const current = 'line1\nnew\nline3\n';
    const changes = computeLineChanges(head, current);
    expect(changes.size).toBe(1);
    expect(changes.get(2)).toBe('modified');
  });

  it('handles deleted lines without marking current file lines', () => {
    const head = 'line1\nline2\nline3\n';
    const current = 'line1\nline3\n';
    const changes = computeLineChanges(head, current);
    expect(changes.size).toBe(0);
  });

  it('handles mixed add and modify', () => {
    const head = 'a\nb\nc\n';
    const current = 'a\nB\nc\nd\n';
    const changes = computeLineChanges(head, current);
    expect(changes.get(2)).toBe('modified');
    expect(changes.get(4)).toBe('added');
  });
});

describe('countLineChanges', () => {
  it('counts additions and modifications', () => {
    const changes = new Map([
      [1, 'added' as const],
      [2, 'modified' as const],
      [3, 'added' as const],
      [4, 'modified' as const],
      [5, 'added' as const],
    ]);
    const result = countLineChanges(changes);
    expect(result.additions).toBe(3);
    expect(result.modifications).toBe(2);
  });
});

describe('parseUnifiedDiff', () => {
  it('parses a simple diff with one hunk', () => {
    const diffText = [
      'diff --git a/test.txt b/test.txt',
      'index 1234567..abcdefg 100644',
      '--- a/test.txt',
      '+++ b/test.txt',
      '@@ -1,3 +1,4 @@',
      ' line1',
      '-old line',
      '+new line',
      '+added line',
      ' line3',
    ].join('\n');

    const hunks = parseUnifiedDiff(diffText);
    expect(hunks).toHaveLength(1);
    expect(hunks[0].oldStart).toBe(1);
    expect(hunks[0].oldLines).toBe(3);
    expect(hunks[0].newStart).toBe(1);
    expect(hunks[0].newLines).toBe(4);
    expect(hunks[0].lines).toHaveLength(5);
    expect(hunks[0].lines[0]).toEqual({ type: 'context', content: 'line1' });
    expect(hunks[0].lines[1]).toEqual({ type: 'remove', content: 'old line' });
    expect(hunks[0].lines[2]).toEqual({ type: 'add', content: 'new line' });
    expect(hunks[0].lines[3]).toEqual({ type: 'add', content: 'added line' });
    expect(hunks[0].lines[4]).toEqual({ type: 'context', content: 'line3' });
  });

  it('parses multiple hunks', () => {
    const diffText = [
      '@@ -1,2 +1,2 @@',
      ' a',
      '-b',
      '+B',
      '@@ -5,1 +6,1 @@',
      ' e',
      '-f',
      '+F',
    ].join('\n');

    const hunks = parseUnifiedDiff(diffText);
    expect(hunks).toHaveLength(2);
    expect(hunks[0].oldStart).toBe(1);
    expect(hunks[1].oldStart).toBe(5);
  });

  it('returns empty array for empty diff', () => {
    expect(parseUnifiedDiff('')).toEqual([]);
  });

  it('handles single-line hunk headers', () => {
    const diffText = '@@ -10 +10 @@\n context\n+added';
    const hunks = parseUnifiedDiff(diffText);
    expect(hunks).toHaveLength(1);
    expect(hunks[0].oldStart).toBe(10);
    expect(hunks[0].oldLines).toBe(1);
    expect(hunks[0].newStart).toBe(10);
    expect(hunks[0].newLines).toBe(1);
  });
});
