import {
  Message,
  MessageContent,
  MessageFooter,
  MessageHeader,
} from '../ui/message';
import { Bubble, BubbleContent } from '../ui/bubble';
import type { MessageVM } from '../../stores/agentStore';
import { Markdown } from './markdown';
import { ToolCallCard } from './ToolCallCard';
import { cn } from '../../lib/utils';

const ROLE_LABEL: Record<MessageVM['role'], string> = {
  user: '你',
  assistant: 'Agent',
  tool: '工具',
  system: '系统',
};

export function MessageItem({
  vm,
  workspaceId,
}: {
  vm: MessageVM;
  workspaceId?: string;
}) {
  const isUser = vm.role === 'user';
  const time = new Date(vm.createdAt).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
  });
  return (
    <Message align={isUser ? 'end' : 'start'}>
      <MessageContent>
        <MessageHeader>
          {ROLE_LABEL[vm.role]}
          {!vm.streaming && (
            <span className="ml-2 font-mono text-[10px] text-muted-foreground/60">{time}</span>
          )}
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
                  return (
                    <Markdown
                      key={i}
                      text={d.text ?? ''}
                      streaming={vm.streaming && vm.role === 'assistant'}
                    />
                  );
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
                case 'tool_call': {
                  const tc = d as { id: string; name: string; input: string; finished?: boolean };
                  return (
                    <div key={i}>
                      <ToolCallCard call={tc as never} workspaceId={workspaceId} />
                    </div>
                  );
                }
                case 'finish':
                  return (
                    <div
                      key={i}
                      className="flex items-center gap-2 py-0.5 text-xs text-muted-foreground"
                    >
                      <span className="h-px flex-1 bg-border" />
                      <span className="font-mono">完成 · {d.reason ?? ''}</span>
                      <span className="h-px flex-1 bg-border" />
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
