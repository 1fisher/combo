import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Markdown } from './markdown';

describe('Markdown 反色气泡配色', () => {
  it('普通模式:链接用 text-primary,行内代码用 bg-muted', () => {
    const { container } = render(
      <Markdown text={'[链接](https://example.com) 和 `code`'} />,
    );
    const link = container.querySelector('a');
    expect(link).not.toBeNull();
    // cmd/ctrl+click 打开外链的行为仍在
    expect(link?.getAttribute('href')).toBe('https://example.com');
    const code = container.querySelector('code');
    expect(code?.className).toContain('bg-muted');
    expect(code?.className).not.toContain('bg-primary-foreground');
  });

  it('反色模式(品牌色气泡):行内代码改 primary-foreground 半透明底', () => {
    const { container } = render(<Markdown text={'`code`'} inverted />);
    const code = container.querySelector('code');
    expect(code?.className).toContain('bg-primary-foreground/15');
    expect(code?.className).not.toContain('bg-muted');
  });

  it('反色模式:容器配色规则切换为 text-inherit 系', () => {
    const { container } = render(<Markdown text="正文" inverted />);
    const wrapper = container.firstElementChild as HTMLElement;
    expect(wrapper.className).toContain('text-inherit');
    expect(wrapper.className).not.toContain('text-primary ');
    expect(wrapper.className).not.toContain('bg-muted');
  });

  it('普通模式容器不含反色规则', () => {
    const { container } = render(<Markdown text="正文" />);
    const wrapper = container.firstElementChild as HTMLElement;
    expect(wrapper.className).not.toContain('text-inherit');
    expect(wrapper.className).toContain('text-primary');
  });

  it('流式光标:streaming 时文本末尾追加 ▍', () => {
    render(<Markdown text="生成中" streaming />);
    expect(screen.getByText(/生成中/).textContent).toContain('▍');
  });
});
