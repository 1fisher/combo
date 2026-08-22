import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QuestionCard } from './QuestionCard';
import type { Api } from '../../lib/api/types';

const base = { session_id: 's1', tool_call_id: 'tc1' } as const;

describe('QuestionCard', () => {
  it('yes_no 渲染为单选框(是/否),而非按钮', () => {
    const batch: Api.QuestionRequest = {
      ...base,
      id: 'q7',
      questions: [{ id: 'qq1', type: 'yes_no', question: '是否继续?' }],
    };
    render(<QuestionCard batch={batch} onResolve={() => {}} />);
    const yes = screen.getByRole('radio', { name: '是' }) as HTMLInputElement;
    const no = screen.getByRole('radio', { name: '否' }) as HTMLInputElement;
    expect(yes.type).toBe('radio');
    expect(no.type).toBe('radio');
    expect(screen.queryByRole('button', { name: '是' })).toBeNull();
    expect(screen.queryByRole('button', { name: '否' })).toBeNull();
  });

  it('从 yes_no / 单选 / 多选构造回答(未用「其他」时不携带 fill_in_text)', async () => {
    const batch: Api.QuestionRequest = {
      ...base,
      id: 'q1',
      questions: [
        { id: 'qq1', type: 'yes_no', question: '是否继续?' },
        {
          id: 'qq2',
          type: 'single_choice',
          question: '选哪个?',
          choices: [
            { id: 'a', label: '选项A' },
            { id: 'b', label: '选项B' },
          ],
        },
        {
          id: 'qq3',
          type: 'multi_choice',
          question: '要哪些?',
          choices: [
            { id: 'x', label: 'X' },
            { id: 'y', label: 'Y' },
          ],
        },
      ],
    };
    let answer: Api.QuestionAnswer | null = null;
    render(<QuestionCard batch={batch} onResolve={(a) => (answer = a)} />);
    await userEvent.click(screen.getByText('是'));
    await userEvent.click(screen.getByText('选项B'));
    await userEvent.click(screen.getByText('Y'));
    await userEvent.click(screen.getByRole('button', { name: '提交回答' }));
    expect(answer).toEqual({
      batch_request_id: 'q1',
      responses: [
        { request_id: 'qq1', yes: true },
        { request_id: 'qq2', selected_ids: ['b'] },
        { request_id: 'qq3', selected_ids: ['y'] },
      ],
    });
  });

  it('单选选「其他」并输入 → 自定义文本走 fill_in_text', async () => {
    const batch: Api.QuestionRequest = {
      ...base,
      id: 'q2',
      questions: [
        {
          id: 'qq1',
          type: 'single_choice',
          question: '用哪个分支?',
          choices: [{ id: 'main', label: 'main' }],
        },
      ],
    };
    let answer: Api.QuestionAnswer | null = null;
    render(<QuestionCard batch={batch} onResolve={(a) => (answer = a)} />);
    await userEvent.click(screen.getByText('其他(手动输入)'));
    const input = screen.getByPlaceholderText('请输入自定义答案…');
    await userEvent.type(input, 'feature/xyz');
    await userEvent.click(screen.getByRole('button', { name: '提交回答' }));
    const got = answer as Api.QuestionAnswer | null;
    expect(got?.responses[0]).toEqual({
      request_id: 'qq1',
      selected_ids: [],
      fill_in_text: 'feature/xyz',
    });
  });

  it('多选:真实选项与「其他」输入并存 → selected_ids + fill_in_text 同时回传', async () => {
    const batch: Api.QuestionRequest = {
      ...base,
      id: 'q3',
      questions: [
        {
          id: 'qq1',
          type: 'multi_choice',
          question: '要哪些功能?',
          choices: [{ id: 'a', label: '选项A' }],
        },
      ],
    };
    let answer: Api.QuestionAnswer | null = null;
    render(<QuestionCard batch={batch} onResolve={(a) => (answer = a)} />);
    await userEvent.click(screen.getByText('选项A'));
    await userEvent.click(screen.getByText('其他(手动输入)'));
    await userEvent.type(screen.getByPlaceholderText('请输入自定义答案…'), '再加个开关');
    await userEvent.click(screen.getByRole('button', { name: '提交回答' }));
    const got = answer as Api.QuestionAnswer | null;
    expect(got?.responses[0]).toEqual({
      request_id: 'qq1',
      selected_ids: ['a'],
      fill_in_text: '再加个开关',
    });
  });

  it('「让 agent 自行决定」→ skipped 跳过回答', async () => {
    const batch: Api.QuestionRequest = {
      ...base,
      id: 'q4',
      questions: [{ id: 'qq1', type: 'free_text', question: '项目名?' }],
    };
    let answer: Api.QuestionAnswer | null = null;
    render(<QuestionCard batch={batch} onResolve={(a) => (answer = a)} />);
    await userEvent.click(screen.getByText('让 agent 自行决定'));
    expect(answer).toEqual({ batch_request_id: 'q4', responses: [], skipped: true });
  });

  it('type 缺失但有 choices → 按单选兜底渲染,选项可选中并提交', async () => {
    const batch: Api.QuestionRequest = {
      ...base,
      id: 'q5',
      questions: [
        {
          id: 'qq1',
          type: '',
          question: '切走期间收到音效/通知了吗?',
          choices: [
            { id: 'both', label: '音效 + 系统通知都有' },
            { id: 'none', label: '都没有' },
          ],
        },
      ],
    };
    let answer: Api.QuestionAnswer | null = null;
    render(<QuestionCard batch={batch} onResolve={(a) => (answer = a)} />);
    await userEvent.click(screen.getByText('音效 + 系统通知都有'));
    await userEvent.click(screen.getByRole('button', { name: '提交回答' }));
    expect(answer).toMatchObject({
      batch_request_id: 'q5',
      responses: [{ request_id: 'qq1', selected_ids: ['both'] }],
    });
  });

  it('type 缺失且无 choices → 按自由输入兜底,fill_in_text 回传', async () => {
    const batch: Api.QuestionRequest = {
      ...base,
      id: 'q6',
      questions: [{ id: 'qq1', type: '', question: '项目名?' }],
    };
    let answer: Api.QuestionAnswer | null = null;
    render(<QuestionCard batch={batch} onResolve={(a) => (answer = a)} />);
    await userEvent.type(screen.getByPlaceholderText('请输入…'), 'combo');
    await userEvent.click(screen.getByRole('button', { name: '提交回答' }));
    expect(answer).toMatchObject({
      batch_request_id: 'q6',
      responses: [{ request_id: 'qq1', fill_in_text: 'combo' }],
    });
  });
});
