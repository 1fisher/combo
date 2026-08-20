import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { toCmDiagnostics, countSeverity } from './lspDiagnostics';
import type { Api } from './api/types';

const DOC = EditorState.create({ doc: 'fn main() {\n    let x = 1\n}\n' }).doc;

function diag(partial: Partial<Api.LspDiagnostic>): Api.LspDiagnostic {
  return {
    line: 0,
    character: 0,
    endLine: 0,
    endCharacter: 0,
    severity: 1,
    message: 'm',
    ...partial,
  };
}

describe('toCmDiagnostics', () => {
  it('LSP 0-based 行列映射为文档 offset', () => {
    // 第 2 行(0-based 1)「    let x = 1」第 4-8 列 → offset 16..20
    const ds = toCmDiagnostics(
      [diag({ line: 1, character: 4, endLine: 1, endCharacter: 8, message: 'expected `;`', severity: 2 })],
      DOC,
    );
    expect(ds).toHaveLength(1);
    expect(ds[0].from).toBe(16);
    expect(ds[0].to).toBe(20);
    expect(ds[0].severity).toBe('warning');
    expect(ds[0].message).toBe('expected `;`');
  });

  it('severity 映射:1=error 2=warning 3/4=info;source 附加到消息', () => {
    const ds = toCmDiagnostics(
      [
        diag({ severity: 1 }),
        diag({ severity: 2 }),
        diag({ severity: 3 }),
        diag({ severity: 4, source: 'rust-analyzer' }),
      ],
      DOC,
    );
    expect(ds.map((d) => d.severity)).toEqual(['error', 'warning', 'info', 'info']);
    expect(ds[3].message).toBe('m(rust-analyzer)');
  });

  it('行列越界 clamp 到行尾/文末(server 可能基于旧版本推送)', () => {
    const ds = toCmDiagnostics(
      [diag({ line: 99, character: 50, endLine: 100, endCharacter: 9 })],
      DOC,
    );
    expect(ds[0].from).toBeLessThanOrEqual(ds[0].to);
    expect(ds[0].to).toBeLessThanOrEqual(DOC.length);
  });

  it('from/to 交叉时自动排序', () => {
    const ds = toCmDiagnostics([diag({ line: 1, character: 8, endLine: 0, endCharacter: 2 })], DOC);
    expect(ds[0].from).toBeLessThanOrEqual(ds[0].to);
  });
});

describe('countSeverity', () => {
  it('统计 error 与 warning,忽略 info/hint', () => {
    expect(
      countSeverity([diag({ severity: 1 }), diag({ severity: 1 }), diag({ severity: 2 }), diag({ severity: 3 }), diag({ severity: 4 })]),
    ).toEqual({ errors: 2, warnings: 1 });
  });

  it('空列表为 0/0', () => {
    expect(countSeverity([])).toEqual({ errors: 0, warnings: 0 });
  });
});
