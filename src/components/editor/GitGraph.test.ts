import { describe, it, expect } from 'vitest';
import { computeLanes, buildRowLines } from './GitGraph';
import type { Api } from '../../lib/api/types';

const ROW_H = 32;

function commit(hash: string, parents: string[], message = ''): Api.GitCommitInfo {
  return {
    hash,
    shortHash: hash.slice(0, 7),
    author: 'test',
    date: '2025-01-01',
    message,
    parents,
    branches: [],
    isHead: false,
  };
}

/** 线性历史:A ← B ← C */
const linearCommits: Api.GitCommitInfo[] = [
  commit('C', ['B'], 'c'),
  commit('B', ['A'], 'b'),
  commit('A', [], 'a'),
];

/**
 * merge 场景:
 *   M (merge) parents=[P1, P2]
 *   P2        parents=[Base]
 *   P1        parents=[Base]
 *   Base      parents=[]
 */
const mergeCommits: Api.GitCommitInfo[] = [
  commit('M', ['P1', 'P2'], 'merge'),
  commit('P2', ['Base'], 'feature'),
  commit('P1', ['Base'], 'main'),
  commit('Base', [], 'base'),
];

describe('computeLanes', () => {
  it('assigns lane 0 to a linear history', () => {
    const result = computeLanes(linearCommits);
    expect(result.get('C')?.lane).toBe(0);
    expect(result.get('B')?.lane).toBe(0);
    expect(result.get('A')?.lane).toBe(0);
  });

  it('assigns second merge parent to a different lane than first', () => {
    const result = computeLanes(mergeCommits);
    const merge = result.get('M')!;
    expect(merge.lane).toBe(0);
    // first and second parent must be on different lanes
    expect(merge.parentLanes[0]).not.toBe(merge.parentLanes[1]);
  });

  it('returns empty map for empty input', () => {
    expect(computeLanes([]).size).toBe(0);
  });
});

describe('buildRowLines — merge node connections', () => {
  it('draws a curve from merge dot to second parent lane', () => {
    const gc = computeLanes(mergeCommits);
    const merge = gc.get('M')!;
    const { lines } = buildRowLines(mergeCommits[0], merge, 0, mergeCommits, gc, ROW_H);

    const curves = lines.filter((l) => l.curve);
    const downs = lines.filter((l) => !l.curve && l.key.startsWith('down'));

    // At least one curve (for the second parent)
    expect(curves.length).toBeGreaterThanOrEqual(1);

    // The curve must start from the merge dot center (y = ROW_H / 2 = 16)
    expect(curves[0].y1).toBe(ROW_H / 2);

    // At least one straight down line for the first parent
    expect(downs.length).toBeGreaterThanOrEqual(1);
  });

  it('does NOT draw incoming curve from wrong lane at second parent row', () => {
    const gc = computeLanes(mergeCommits);
    // Row 1 is P2 (second parent of merge)
    const p2 = gc.get('P2')!;
    const { lines } = buildRowLines(mergeCommits[1], p2, 1, mergeCommits, gc, ROW_H);

    // All incoming lines must be straight (not curved) and on P2's own lane
    const incoming = lines.filter((l) => l.key.startsWith('in'));
    for (const line of incoming) {
      expect(line.curve).toBeFalsy();
      // x1 and x2 should be the same (vertical line on one lane)
      expect(line.x1).toBe(line.x2);
    }
  });

  it('produces no curves for linear history', () => {
    const gc = computeLanes(linearCommits);
    for (let row = 0; row < linearCommits.length; row++) {
      const c = gc.get(linearCommits[row].hash)!;
      const { lines } = buildRowLines(linearCommits[row], c, row, linearCommits, gc, ROW_H);
      const curves = lines.filter((l) => l.curve);
      expect(curves).toHaveLength(0);
    }
  });

  it('all down-lines originate from the dot center y', () => {
    const gc = computeLanes(mergeCommits);
    for (let row = 0; row < mergeCommits.length; row++) {
      const c = gc.get(mergeCommits[row].hash)!;
      const { lines } = buildRowLines(mergeCommits[row], c, row, mergeCommits, gc, ROW_H);
      const downs = lines.filter((l) => l.key.startsWith('down'));
      for (const d of downs) {
        // Down-lines must start from y = ROW_H / 2 (the dot center)
        expect(d.y1).toBe(ROW_H / 2);
      }
    }
  });
});
