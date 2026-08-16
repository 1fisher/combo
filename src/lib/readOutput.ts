/**
 * 解析 combo read 工具的分页输出格式,提取代码正文与行号,
 * 供 ToolResultCard 按文件类型做语法高亮渲染(替代纯文本)。
 *
 * 后端格式(tools.rs read_tool):
 * ```
 * 文件: src/main.rs(123 行)
 * 显示第 1-200 行:
 *     1 │ fn main() {
 *     2 │     println!("hi");
 * ...
 *
 * (共 123 行,使用 offset=200 继续读取)
 * ```
 *
 * 解析成功返回结构化视图;格式不匹配(其他后端、错误输出等)返回 null,
 * 调用方回退到原始文本渲染。
 */

export interface ReadOutputView {
  /** 头部「文件: <path>(N 行)」提取的路径(可能缺省) */
  path: string | null;
  /** 文件总行数(头部提取,可能缺省) */
  total: number | null;
  /** 显示范围(头部提取,可能缺省) */
  range: { start: number; end: number } | null;
  /** 代码正文(已剥离行号前缀),与 lineNumbers 一一对应 */
  lines: string[];
  /** 每行对应的真实文件行号(1-based) */
  lineNumbers: number[];
  /** 尾部翻页提示(如「(共 123 行,使用 offset=200 继续读取)」) */
  footer: string | null;
}

const HEADER_FILE_RE = /^文件: (.+)\((\d+) 行\)$/;
const HEADER_RANGE_RE = /^显示第 (\d+)-(\d+) 行:$/;
const FOOTER_RE = /^\(共 \d+ 行,使用 offset=\d+ 继续读取\)$/;
/** 行号前缀:`{:>5} │ {content}`(宽容匹配:行号宽度任意、│ 后零或一个空格) */
const CODE_LINE_RE = /^\s*(\d{1,7})\s*│ ?(.*)$/;

/**
 * 解析 read 工具输出。
 * 接受条件:至少一行命中行号格式,且不存在无法归类的非空行
 * (空行 tolerated——footer 前的空行、行尾 split 产生的尾空串)。
 */
export function parseReadOutput(content: string): ReadOutputView | null {
  const raw = content.split('\n');
  let i = 0;

  let path: string | null = null;
  let total: number | null = null;
  let range: { start: number; end: number } | null = null;

  const fileMatch = raw[i] !== undefined ? HEADER_FILE_RE.exec(raw[i]) : null;
  if (fileMatch) {
    path = fileMatch[1];
    total = Number(fileMatch[2]);
    i++;
  }
  const rangeMatch = raw[i] !== undefined ? HEADER_RANGE_RE.exec(raw[i]) : null;
  if (rangeMatch) {
    range = { start: Number(rangeMatch[1]), end: Number(rangeMatch[2]) };
    i++;
  }

  const lines: string[] = [];
  const lineNumbers: number[] = [];
  let footer: string | null = null;
  let unmatched = 0;

  for (; i < raw.length; i++) {
    const line = raw[i];
    if (line === '') continue; // 空行:footer 前的分隔或尾随换行
    if (FOOTER_RE.test(line)) {
      footer = line;
      continue;
    }
    const m = CODE_LINE_RE.exec(line);
    if (m) {
      lineNumbers.push(Number(m[1]));
      lines.push(m[2]);
      continue;
    }
    unmatched++;
  }

  if (lines.length === 0 || unmatched > 0) return null;
  return { path, total, range, lines, lineNumbers, footer };
}
