import { Check, CircleAlert } from 'lucide-react';
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
import { ToolResultCard } from './ToolResultCard';
import { cn } from '../../lib/utils';

const ROLE_LABEL: Record<MessageVM['role'], string> = {
  user: '你',
  assistant: 'Agent',
  tool: '工具',
  system: '系统',
};

/** finish reason → 中文操作标签 */
const REASON_LABELS: Record<string, string> = {
  end_turn: '文本回复',
  stop: '已完成',
  tool_use: '工具调用',
  tool_use_end: '工具调用',
  max_tokens: '长度限制',
  length: '长度限制',
  content_filter: '内容过滤',
};

export function MessageItem({
  vm,
  workspaceId,
}: {
  vm: MessageVM;
  workspaceId?: string;
}) {
  const isUser = vm.role === 'user';

  // 提取 finish part,不参与 inline 渲染,合并进 header
  const finishPart = vm.parts.find((p) => p.type === 'finish');
  const finishReason = (finishPart?.data as { reason?: string } | undefined)?.reason ?? '';
  const isAbnormal = !['end_turn', 'stop', 'tool_use', 'tool_use_end', ''].includes(finishReason);
  const reasonLabel = REASON_LABELS[finishReason] ?? finishReason ?? '回复完成';
  // assistant 且已有 finish part 时,用 reason 标签替换固定的 "Agent"
  const showFinishBadge = vm.role === 'assistant' && finishPart;

  const time = new Date(vm.createdAt).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
  });
  return (
    <Message align={isUser ? 'end' : 'start'}>
      <MessageContent>
        <MessageHeader>
          {showFinishBadge ? (
            <span
              className={cn(
                'inline-flex items-center gap-1 text-[11px] font-medium',
                isAbnormal ? 'text-warning' : 'text-success',
              )}
            >
              {isAbnormal ? (
                <CircleAlert className="size-3" />
              ) : (
                <Check className="size-3" />
              )}
              {reasonLabel}
            </span>
          ) : (
            <span>{ROLE_LABEL[vm.role]}</span>
          )}
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
                case 'tool_result': {
                  const tr = d as {
                    tool_call_id: string;
                    name: string;
                    content: string;
                    metadata?: string;
                    is_error?: boolean;
                  };
                  // 空内容的 tool_result 不渲染
                  if (!tr.content || tr.content.trim() === '') return null;
                  return (
                    <div key={i}>
                      <ToolResultCard result={tr as never} />
                    </div>
                  );
                }
                case 'shell_command': {
                  const sc = d as { command: string; output: string; exit_code: number };
                  return (
                    <div key={i}>
                      <ToolResultCard
                        result={{
                          tool_call_id: `shell-${i}`,
                          name: 'bash',
                          content: sc.output,
                          metadata: JSON.stringify({ exit_code: sc.exit_code }),
                          is_error: sc.exit_code !== 0,
                        } as never}
                      />
                    </div>
                  );
                }
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
