import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { TodoList } from './TodoList';
import type { Api } from '../../lib/api/types';

function todo(content: string, status: Api.TodoStatus, active_form?: string): Api.TodoItem {
  return { content, status, active_form };
}

/** 找出当前被 loader(animate-spin)标记的列表行的文本 */
function loaderLines(container: HTMLElement): string[] {
  const lines: string[] = [];
  container.querySelectorAll('svg.animate-spin').forEach((svg) => {
    const row = svg.closest('.py-1');
    lines.push(row?.textContent ?? '');
  });
  return lines;
}

describe('TodoList 正在处理标记(展示层兜底)', () => {
  it('没有任何 in_progress 时,默认把第一条 pending 标记为正在处理(loading)', () => {
    const { container } = render(
      <TodoList todos={[todo('任务一', 'pending'), todo('任务二', 'pending')]} />
    );
    // 只有一条带 loader,且是第一条
    expect(loaderLines(container)).toEqual(['任务一']);
    // 顶栏也显示当前处理的第一条
    expect(container.textContent).toContain('任务进度 0/2');
  });

  it('当前条完成后,自动把下一条 pending 标记为正在处理(loading)', () => {
    const { container } = render(
      <TodoList
        todos={[
          todo('任务一', 'completed'),
          todo('任务二', 'pending'),
          todo('任务三', 'pending'),
        ]}
      />
    );
    expect(loaderLines(container)).toEqual(['任务二']);
  });

  it('全部完成时没有任何 loading 标记', () => {
    const { container } = render(
      <TodoList todos={[todo('任务一', 'completed'), todo('任务二', 'completed')]} />
    );
    expect(container.querySelectorAll('svg.animate-spin')).toHaveLength(0);
    // 顶栏无当前处理项,也不显示 active_form
    expect(container.textContent).toContain('任务进度 2/2');
  });

  it('存在真实 in_progress 时优先使用它,不推导第一条 pending', () => {
    const { container } = render(
      <TodoList
        todos={[
          todo('任务一', 'pending'),
          todo('任务二', 'in_progress', '正在处理任务二'),
          todo('任务三', 'pending'),
        ]}
      />
    );
    expect(loaderLines(container)).toEqual(['正在处理任务二']);
  });

  it('推导的当前项也展示 active_form(若存在)', () => {
    const { container } = render(
      <TodoList
        todos={[
          todo('任务一', 'pending', '正在处理任务一'),
          todo('任务二', 'pending'),
        ]}
      />
    );
    expect(loaderLines(container)).toEqual(['正在处理任务一']);
  });
});
