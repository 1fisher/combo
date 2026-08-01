import {
  Message,
  MessageContent,
  MessageFooter,
  MessageHeader,
} from '../ui/message';
import { Bubble, BubbleContent } from '../ui/bubble';
import type { MessageVM } from '../../stores/agentStore';
import { Markdown } from './markdown';
import { cn } from '../../lib/utils';

const ROLE_LABEL: Record<MessageVM['role'], string> = {
  user: '你',
  assistant: 'Agent',
  tool: '工具',
  system: '系统',
};

export function MessageItem({ vm }: { vm: MessageVM }) {
  const isUser = vm.role === 'user';
  return (
    <Message align={isUser ? 'end' : 'start'}>
      <MessageContent>
        <MessageHeader>
          {ROLE_LABEL[vm.role]}
          {vm.streaming && (
            <span
              className={cn('ml-2 animate-pulse text-primary', isUser && 'sr-only')}
              aria-label="流式中"
            >
              ●
            </span>
          )}
        </MessageHeader>
        <Bubble variant={isUser ? 'default' : 'muted'} align={isUser ? 'end' : 'start'}>
          <BubbleContent>
            {vm.parts.map((part, i) => {
              const d = part.data as never as {
                text?: string;
                thinking?: string;
                reason?: string;
                name?: string;
              };
              switch (part.type) {
                case 'text':
                  return <Markdown key={i} text={d.text ?? ''} />;
                case 'reasoning':
                  return (
                    <details
                      key={i}
                      className="rounded-md border bg-muted/40 px-2 py-1 text-xs text-muted-foreground"
                    >
                      <summary>思考中…</summary>
                      <div className="mt-1 whitespace-pre-wrap">{d.thinking}</div>
                    </details>
                  );
                case 'tool_call':
                  return (
                    <div
                      key={i}
                      className="rounded-md border px-3 py-2 font-mono text-xs text-muted-foreground"
                    >
                      工具: {d.name}
                    </div>
                  );
                case 'finish':
                  return (
                    <div key={i} className="text-xs text-muted-foreground">
                      finish: {d.reason ?? ''}
                    </div>
                  );
                default:
                  return null;
              }
            })}
          </BubbleContent>
        </Bubble>
        {vm.streaming && (
          <MessageFooter>
            <span className="animate-pulse">正在执行…</span>
          </MessageFooter>
        )}
      </MessageContent>
    </Message>
  );
}
