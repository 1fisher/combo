import { beforeEach, describe, expect, it, vi } from 'vitest';

const confirmDialog = vi.fn<() => Promise<boolean>>();
vi.mock('../../lib/confirm', () => ({
  confirmDialog: (...args: unknown[]) => confirmDialog(...(args as [])),
}));

import { deleteSessionWithConfirm } from './sessionDelete';

describe('deleteSessionWithConfirm', () => {
  beforeEach(() => {
    confirmDialog.mockReset();
  });

  it('空会话(无任何消息)直接删除,不弹确认', async () => {
    const remove = vi.fn().mockResolvedValue(undefined);
    await deleteSessionWithConfirm({ id: 's1', message_count: 0, is_busy: false }, remove);
    expect(remove).toHaveBeenCalledWith('s1');
    expect(confirmDialog).not.toHaveBeenCalled();
  });

  it('有消息的会话需确认,确认后删除', async () => {
    confirmDialog.mockResolvedValue(true);
    const remove = vi.fn().mockResolvedValue(undefined);
    await deleteSessionWithConfirm({ id: 's2', message_count: 3, is_busy: false }, remove);
    expect(confirmDialog).toHaveBeenCalledWith('确定删除此会话?');
    expect(remove).toHaveBeenCalledWith('s2');
  });

  it('有消息的会话确认取消时不删除', async () => {
    confirmDialog.mockResolvedValue(false);
    const remove = vi.fn().mockResolvedValue(undefined);
    await deleteSessionWithConfirm({ id: 's2', message_count: 3, is_busy: false }, remove);
    expect(remove).not.toHaveBeenCalled();
  });

  it('运行中的会话即使消息数仍为 0(旧列表快照)也需确认', async () => {
    confirmDialog.mockResolvedValue(true);
    const remove = vi.fn().mockResolvedValue(undefined);
    await deleteSessionWithConfirm({ id: 's3', message_count: 0, is_busy: true }, remove);
    expect(confirmDialog).toHaveBeenCalled();
    expect(remove).toHaveBeenCalledWith('s3');
  });
});
