import { describe, expect, it } from 'vitest';

// We test the detection logic in isolation since useMention depends on DOM refs.
// Extract the core algorithm for direct testing.

function detectTrigger(text: string, cursorPos: number): { type: 'file' | 'skill' | null; query: string; startIndex: number } {
  const slice = text.slice(0, cursorPos);
  let triggerChar: 'file' | 'skill' | null = null;
  let at = -1;
  for (let i = slice.length - 1; i >= 0; i--) {
    const ch = slice[i];
    if (ch === ' ' || ch === '\n' || ch === '\t') break;
    if (ch === '@' && (i === 0 || /[\s\n]/.test(slice[i - 1]))) {
      triggerChar = 'file';
      at = i;
      break;
    }
    if (ch === '%' && (i === 0 || /[\s\n]/.test(slice[i - 1]))) {
      triggerChar = 'skill';
      at = i;
      break;
    }
  }
  if (triggerChar && at >= 0) {
    return { type: triggerChar, query: slice.slice(at + 1), startIndex: at };
  }
  return { type: null, query: '', startIndex: -1 };
}

describe('mention trigger detection', () => {
  it('detects @ trigger at start', () => {
    expect(detectTrigger('@src/main.ts', 12)).toEqual({ type: 'file', query: 'src/main.ts', startIndex: 0 });
  });

  it('detects @ trigger after space', () => {
    expect(detectTrigger('hello @main', 11)).toEqual({ type: 'file', query: 'main', startIndex: 6 });
  });

  it('detects % trigger for skill', () => {
    expect(detectTrigger('%brainstor', 10)).toEqual({ type: 'skill', query: 'brainstor', startIndex: 0 });
  });

  it('detects % trigger after newline', () => {
    expect(detectTrigger('line1\n%skill', 12)).toEqual({ type: 'skill', query: 'skill', startIndex: 6 });
  });

  it('returns null when no trigger char', () => {
    expect(detectTrigger('hello world', 11)).toEqual({ type: null, query: '', startIndex: -1 });
  });

  it('returns null when trigger is not at word boundary', () => {
    expect(detectTrigger('foo@bar', 7)).toEqual({ type: null, query: '', startIndex: -1 });
  });

  it('returns null when space after trigger', () => {
    expect(detectTrigger('hello @ world', 13)).toEqual({ type: null, query: '', startIndex: -1 });
  });

  it('handles empty query (just typed trigger)', () => {
    expect(detectTrigger('@', 1)).toEqual({ type: 'file', query: '', startIndex: 0 });
  });

  it('handles % at start with empty query', () => {
    expect(detectTrigger('%', 1)).toEqual({ type: 'skill', query: '', startIndex: 0 });
  });
});
