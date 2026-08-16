import { describe, expect, it } from 'vitest';
import { parseReadOutput } from './readOutput';

const FULL = [
  '文件: src/main.rs(5 行)',
  '显示第 1-3 行:',
  '    1 │ fn main() {',
  '    2 │     println!("hi");',
  '    3 │ }',
  '',
  '(共 5 行,使用 offset=3 继续读取)',
].join('\n');

describe('parseReadOutput', () => {
  it('解析完整分页格式(头部 + 行号 + footer)', () => {
    const view = parseReadOutput(FULL);
    expect(view).not.toBeNull();
    expect(view!.path).toBe('src/main.rs');
    expect(view!.total).toBe(5);
    expect(view!.range).toEqual({ start: 1, end: 3 });
    expect(view!.lines).toEqual(['fn main() {', '    println!("hi");', '}']);
    expect(view!.lineNumbers).toEqual([1, 2, 3]);
    expect(view!.footer).toBe('(共 5 行,使用 offset=3 继续读取)');
  });

  it('读全量小文件时无 footer', () => {
    const content = [
      '文件: a.py(2 行)',
      '显示第 1-2 行:',
      '    1 │ x = 1',
      '    2 │ ',
    ].join('\n');
    const view = parseReadOutput(content);
    expect(view).not.toBeNull();
    expect(view!.footer).toBeNull();
    // 行号后的空代码行保留为空字符串
    expect(view!.lines).toEqual(['x = 1', '']);
  });

  it('缺头部时仍可按行号前缀解析', () => {
    const view = parseReadOutput('  10 │ let x = 1;\n  11 │ let y = 2;');
    expect(view).not.toBeNull();
    expect(view!.path).toBeNull();
    expect(view!.range).toBeNull();
    expect(view!.lineNumbers).toEqual([10, 11]);
    expect(view!.lines).toEqual(['let x = 1;', 'let y = 2;']);
  });

  it('错误输出与普通文本返回 null(回退纯文本渲染)', () => {
    expect(parseReadOutput('文件不存在: foo.rs')).toBeNull();
    expect(parseReadOutput('随便一段文字\n没有行号')).toBeNull();
    expect(parseReadOutput('')).toBeNull();
  });

  it('存在无法归类的非空行时返回 null', () => {
    const content = ['    1 │ code()',  '未分类行'].join('\n');
    expect(parseReadOutput(content)).toBeNull();
  });
});
