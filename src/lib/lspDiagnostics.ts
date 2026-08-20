import type { Diagnostic as CmDiagnostic } from '@codemirror/lint';
import type { Text } from '@codemirror/state';
import type { Api } from './api/types';

/**
 * 编辑器 LSP 诊断的纯转换逻辑:
 * - toCmDiagnostics:LSP 扁平诊断(LSP 0-based 行列,UTF-16 code unit)
 *   → CodeMirror linter 的 Diagnostic(文档内 offset)。行列越界时 clamp 到
 *   行尾/文末(server 可能基于旧版本内容推送,位置需防御)。
 * - countSeverity:错误/警告计数(供编辑器外部的状态指示器联动)。
 */

/** LSP severity(1=error 2=warning 3=info 4=hint)→ CodeMirror linter 严重级别。 */
function severityToCm(s: 1 | 2 | 3 | 4): 'error' | 'warning' | 'info' {
  switch (s) {
    case 1:
      return 'error';
    case 2:
      return 'warning';
    default:
      return 'info';
  }
}

/** LSP (line, character)(0-based)→ 文档 offset,clamp 到对应行行尾。 */
function posToOffset(doc: Text, line: number, character: number): number {
  const ln = doc.line(Math.min(Math.max(line + 1, 1), doc.lines));
  return ln.from + Math.min(character, ln.length);
}

export function toCmDiagnostics(diags: Api.LspDiagnostic[], doc: Text): CmDiagnostic[] {
  const out: CmDiagnostic[] = [];
  for (const d of diags) {
    const from = posToOffset(doc, d.line, d.character);
    const to = posToOffset(doc, d.endLine, d.endCharacter);
    out.push({
      from: Math.min(from, to),
      to: Math.max(from, to),
      message: d.source ? `${d.message}(${d.source})` : d.message,
      severity: severityToCm(d.severity),
    });
  }
  return out;
}

/** 统计 error/severity=1 与 warning/severity=2 的条数(状态指示器联动用)。 */
export function countSeverity(diags: Api.LspDiagnostic[]): { errors: number; warnings: number } {
  let errors = 0;
  let warnings = 0;
  for (const d of diags) {
    if (d.severity === 1) errors += 1;
    else if (d.severity === 2) warnings += 1;
  }
  return { errors, warnings };
}
