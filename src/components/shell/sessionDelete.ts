import type { Api } from '../../lib/api/types';
import { confirmDialog } from '../../lib/confirm';

/**
 * 删除会话的统一入口(侧边栏任务列表 + 项目分组视图共用):
 * 新建后未发过任何消息的空会话(message_count 为 0)直接删除,
 * 不再弹确认;有内容或正在运行的会话仍需二次确认。
 */
export async function deleteSessionWithConfirm(
  session: Pick<Api.Session, 'id' | 'message_count' | 'is_busy'>,
  remove: (id: string) => Promise<unknown>,
): Promise<void> {
  // is_busy 双保险:run 刚启动时列表可能仍是旧快照(message_count 尚为 0)
  if (!session.message_count && !session.is_busy) {
    await remove(session.id);
    return;
  }
  const ok = await confirmDialog('确定删除此会话?');
  if (ok) await remove(session.id);
}
