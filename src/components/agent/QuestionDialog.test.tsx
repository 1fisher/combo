import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QuestionDialog } from './QuestionDialog';
import type { Api } from '../../lib/api/types';

const batch: Api.QuestionRequest = {
  id: 'q1',
  session_id: 's1',
  tool_call_id: 'tc1',
  questions: [
    { id: 'qq1', type: 'yes_no', question: '是否继续?', label: '继续' },
    {
      id: 'qq2',
      type: 'single_choice',
      question: '选哪个?',
      choices: [
        { id: 'a', label: '选项A' },
        { id: 'b', label: '选项B' },
      ],
    },
  ],
};

describe('QuestionDialog', () => {
  it('builds QuestionAnswer from yes_no and single_choice selections', async () => {
    let answer: Api.QuestionAnswer | null = null;
    render(<QuestionDialog batch={batch} onResolve={(a) => (answer = a)} />);
    await userEvent.click(screen.getByText('是'));
    await userEvent.click(screen.getByText('选项B'));
    await userEvent.click(screen.getByRole('button', { name: '提交回答' }));
    expect(answer).toEqual({
      batch_request_id: 'q1',
      responses: [
        { request_id: 'qq1', yes: true },
        { request_id: 'qq2', selected_ids: ['b'] },
      ],
    });
  });
});
