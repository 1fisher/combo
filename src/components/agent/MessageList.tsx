import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from '../ui/message-scroller';
import type { MessageVM } from '../../stores/agentStore';
import { MessageItem } from './MessageItem';

export function MessageList({
  messages,
  workspaceId,
}: {
  messages: MessageVM[];
  workspaceId?: string;
}) {
  return (
    <MessageScrollerProvider autoScroll scrollEdgeThreshold={80}>
      <MessageScroller>
        <MessageScrollerViewport>
          <MessageScrollerContent>
            {messages.map((m) => (
              <MessageScrollerItem
                key={m.id}
                messageId={m.id}
                scrollAnchor
              >
                <MessageItem vm={m} workspaceId={workspaceId} />
              </MessageScrollerItem>
            ))}
            {messages.length === 0 && (
              <div className="flex flex-col items-center gap-2 px-8 py-16 text-center">
                <p className="text-sm font-medium text-foreground">开始一个任务</p>
                <p className="max-w-xs text-xs leading-relaxed text-muted-foreground">
                  给 agent 下任务,执行过程会在这里流式展开;对话中出现的文件可以
                  一键在编辑器打开。
                </p>
              </div>
            )}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton />
      </MessageScroller>
    </MessageScrollerProvider>
  );
}
