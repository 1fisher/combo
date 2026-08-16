import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { CodeView, isLangRegistered } from './CodeView';

describe('CodeView', () => {
  it('按指定语言语法高亮(rust 关键字产生 hljs span)', () => {
    const { container } = render(<CodeView code="fn main() {}" language="rust" />);
    expect(container.querySelector('code.language-rust')).toBeTruthy();
    expect(container.querySelector('code.language-rust .hljs-keyword')).toBeTruthy();
  });

  it('渲染行号列(与代码行对应)', () => {
    const { container } = render(
      <CodeView code={'let a = 1;\nlet b = 2;'} language="rust" lineNumbers={[1, 2]} />,
    );
    const pres = container.querySelectorAll('pre');
    expect(pres.length).toBe(2);
    expect(pres[0].textContent).toBe('1\n2');
    expect(pres[1].textContent).toContain('let a = 1;');
  });

  it('语言未注册或缺失时按纯文本渲染(无高亮 span)', () => {
    const { container } = render(<CodeView code="plain text" language="nosuchlang" />);
    expect(container.querySelector('.hljs-keyword')).toBeNull();
    expect(container.querySelector('code')?.textContent).toBe('plain text');
  });

  it('isLangRegistered 反映语言注册状态', () => {
    expect(isLangRegistered('rust')).toBe(true);
    expect(isLangRegistered('dart')).toBe(true);
    expect(isLangRegistered('nosuchlang')).toBe(false);
  });
});
