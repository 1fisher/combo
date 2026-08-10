import { describe, expect, it } from 'vitest';
import type { Api } from './types';

describe('api contract', () => {
  it('exposes workspace, session, message, permission, question types', () => {
    // 类型级断言:以下变量赋值仅在类型正确时通过编译。
    const ws: Api.Workspace = {
      id: 'w1',
      path: '/proj',
    };
    const msg: Api.Message = {
      id: 'm1',
      role: 'assistant',
      session_id: 's1',
      parts: [{ type: 'text', data: { text: 'hi' } }],
      model: '',
      provider: '',
      created_at: 1,
      updated_at: 1,
    };
    const qa: Api.QuestionAnswer = {
      batch_request_id: 'q1',
      responses: [{ request_id: 'qq1', yes: true }],
    };
    const pg: Api.PermissionGrant = {
      permission: {
        id: 'p1',
        session_id: 's1',
        tool_call_id: 'tc1',
        tool_name: 'bash',
        description: '',
        action: '',
        params: {},
        path: '',
      },
      action: 'allow',
    };
    expect(ws.id).toBe('w1');
    expect(msg.parts?.[0]).toEqual({ type: 'text', data: { text: 'hi' } });
    expect(qa.responses[0].yes).toBe(true);
    expect(pg.action).toBe('allow');
  });
});
