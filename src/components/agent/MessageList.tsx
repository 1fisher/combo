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

export function MessageList({ messages }: { messages: MessageVM[] }) {
  return (
    <MessageScrollerProvider autoScroll>
      <MessageScroller>
        <MessageScrollerViewport>
          <MessageScrollerContent>
            {messages.map((m) => (
              <MessageScrollerItem
                key={m.id}
                messageId={m.id}
                scrollAnchor={m.role === 'user'}
              >
                <MessageItem vm={m} />
              </MessageScrollerItem>
            ))}
            {messages.length === 0 && (
              <div className="p-8 text-center text-sm text-muted-foreground">
                发送消息开始,agent 会在这里流式展示执行过程
              </div>
            )}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton />
      </MessageScroller>
    </MessageScrollerProvider>
  );
}
