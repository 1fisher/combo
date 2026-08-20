import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import userEvent from '@testing-library/user-event';
import { WorkspaceSidebar } from './WorkspaceSidebar';
import type { SideView } from './AppShell';
import { defaultBindings } from '../../lib/shortcuts';
import { useShortcutStore } from '../../stores/shortcutStore';

vi.mock('../../lib/api', () => ({
  listWorkspaces: vi.fn(async () => []),
  listSessions: vi.fn(async () => []),
  listSessionsPage: vi.fn(async (_w: string, limit: number, offset: number) => ({
    sessions: [],
    total: 0,
    limit,
    offset,
  })),
  getSessionSummary: vi.fn(async () => ({
    prompt_tokens: 0,
    completion_tokens: 0,
    cost: 0,
    busy_sessions: 0,
    total_sessions: 0,
  })),
  createSession: vi.fn(async () => ({ id: 's1', name: '新会话' })),
}));

vi.mock('../../lib/connection', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/connection')>();
  return { ...actual, isTauri: vi.fn(() => false) };
});

function renderSidebar() {
  const opened: SideView[] = [];
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <WorkspaceSidebar onOpenView={(v) => opened.push(v)} />
    </QueryClientProvider>,
  );
  return opened;
}

/** 在 window 上派发 ⌘/Ctrl 组合键(返回事件以便断言 defaultPrevented) */
function press(
  key: string,
  opts: { shift?: boolean; target?: HTMLElement; prePrevented?: boolean } = {},
) {
  if (opts.prePrevented) {
    // 模拟 CodeMirror 等组件在 capture 阶段已处理并 preventDefault
    const swallow = (ev: KeyboardEvent) => ev.preventDefault();
    window.addEventListener('keydown', swallow, { capture: true, once: true });
  }
  const ev = new KeyboardEvent('keydown', {
    key,
    metaKey: true,
    shiftKey: opts.shift,
    bubbles: true,
    cancelable: true,
  });
  (opts.target ?? window).dispatchEvent(ev);
  return ev;
}

let scratch: HTMLElement | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  useShortcutStore.setState({ bindings: defaultBindings() });
});

afterEach(() => {
  scratch?.remove();
  scratch = null;
});

describe('WorkspaceSidebar 视图快捷键', () => {
  it('⌘/Ctrl+Shift+A 切换到自动化视图(默认键避开 ⌘A 全选)', () => {
    const opened = renderSidebar();
    const ev = press('a', { shift: true });
    expect(ev.defaultPrevented).toBe(true);
    expect(opened).toEqual(['automation']);
  });

  it('⌘/Ctrl+Shift+S/M/D/G 分别切换技能/MCP/统计/图谱', () => {
    const opened = renderSidebar();
    press('s', { shift: true });
    press('m', { shift: true });
    press('d', { shift: true });
    press('g', { shift: true });
    expect(opened).toEqual(['skills', 'mcp', 'stats', 'graph']);
  });

  it('⌘/Ctrl+K 切换到搜索视图(原有行为)', () => {
    const opened = renderSidebar();
    press('k');
    expect(opened).toEqual(['search']);
  });

  it('焦点在输入框时 ⌘/Ctrl+Shift+A 让位给原生行为,不切视图', () => {
    const opened = renderSidebar();
    scratch = document.createElement('input');
    document.body.appendChild(scratch);
    scratch.focus();
    const ev = press('a', { target: scratch, shift: true });
    expect(ev.defaultPrevented).toBe(false);
    expect(opened).toEqual([]);
  });

  it('焦点在输入框时 ⌘/Ctrl+K 仍可触发(无原生冲突,豁免让位)', async () => {
    const opened = renderSidebar();
    scratch = document.createElement('input');
    document.body.appendChild(scratch);
    await userEvent.click(scratch);
    const ev = press('k', { target: scratch });
    expect(ev.defaultPrevented).toBe(true);
    expect(opened).toEqual(['search']);
  });

  it('已被其他组件处理(defaultPrevented)的 ⌘/Ctrl+Shift+A 不再切视图', () => {
    const opened = renderSidebar();
    const ev = press('a', { prePrevented: true, shift: true });
    expect(ev.defaultPrevented).toBe(true); // 由模拟的组件处理者标记
    expect(opened).toEqual([]);
  });

  it('无修饰键或无关组合不触发视图切换', () => {
    const opened = renderSidebar();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    press('x');
    press('a'); // ⌘A(原生全选)不属于侧边栏快捷键
    press('q', { shift: true }); // ⌘⇧Q 未分配
    press('s'); // ⌘S(保存,编辑器视图)不属于侧边栏
    expect(opened).toEqual([]);
  });
});

describe('WorkspaceSidebar 自定义快捷键', () => {
  beforeEach(() => {
    // store 依赖 zustand persist(上面 import 已注册);直接重置后注入自定义
    useShortcutStore.setState({ bindings: defaultBindings() });
  });

  it('改绑后原键位失效、新键位触发视图切换', () => {
    useShortcutStore.getState().setBinding('view:automation', '⇧z');
    const opened = renderSidebar();
    expect(press('a', { shift: true }).defaultPrevented).toBe(false); // 原 ⌘⇧A 不再触发
    const ev = press('z', { shift: true });
    expect(ev.defaultPrevented).toBe(true);
    expect(opened).toEqual(['automation']);
  });

  it('禁用某视图快捷键后按键不再触发', () => {
    useShortcutStore.getState().setBinding('view:skills', null);
    const opened = renderSidebar();
    press('s', { shift: true });
    expect(opened).toEqual([]);
  });

  it('底部「快捷键管理」按钮打开 shortcuts 视图', () => {
    const opened = renderSidebar();
    const btn = screen.getByRole('button', { name: '快捷键管理' });
    fireEvent.click(btn);
    expect(opened).toEqual(['shortcuts']);
  });
});
