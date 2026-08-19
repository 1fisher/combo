import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SubAgentPanel } from './SubAgentPanel';
import type { Api } from '../../lib/api/types';


function task(overrides: Partial<Api.SubAgentTask> = {}): Api.SubAgentTask {
  return {
    task_id: 't1',
    agent: 'researcher',
    task: '调研依赖树',
    status: 'running',
    ...overrides,
  };
}

describe('SubAgentPanel 子 agent 进度卡片', () => {
  it('空任务列表不渲染', () => {
    const { container } = render(<SubAgentPanel tasks={[]} />);
    expect(container.querySelector('.rounded-xl')).toBeNull();
  });

  it('渲染角色 badge / 任务描述 / 预览与工具计数', () => {
    const { container } = render(
      <SubAgentPanel
        tasks={[
          task({
            task_id: 't1',
            agent: 'researcher',
            task: '调研依赖树',
            status: 'running',
            preview: '[grep] use crate::',
            tool_calls: 3,
          }),
          task({
            task_id: 't2',
            agent: 'coder',
            task: '实现模块',
            status: 'done',
          }),
        ]}
      />
    );
    expect(screen.getByText('researcher')).toBeTruthy();
    expect(screen.getByText('调研依赖树')).toBeTruthy();
    expect(screen.getByText('实现模块')).toBeTruthy();
    // 预览同时出现在头部汇总行与任务行
    expect(screen.getAllByText('[grep] use crate::').length).toBe(2);
    // 完成统计 1/2
    expect(container.textContent).toContain('子 agent 1/2');
    // running 行带 loader
    expect(container.querySelectorAll('svg.animate-spin').length).toBeGreaterThanOrEqual(1);
  });

  it('错误任务显示错误信息,取消任务显示已取消', () => {
    render(
      <SubAgentPanel
        tasks={[
          task({ task_id: 't1', status: 'error', error: 'provider 超时' }),
          task({ task_id: 't2', status: 'cancelled' }),
        ]}
      />
    );
    expect(screen.getByText('provider 超时')).toBeTruthy();
    expect(screen.getByText('已取消')).toBeTruthy();
  });
});
