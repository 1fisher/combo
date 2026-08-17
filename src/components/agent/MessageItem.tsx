import { memo } from 'react';
import { Check, CircleAlert } from 'lucide-react';
import {
  Message,
  MessageContent,
  MessageHeader,
} from '../ui/message';
import { Bubble, BubbleContent } from '../ui/bubble';
import type { MessageVM } from '../../stores/agentStore';
import { Markdown } from './markdown';
import { ToolCallCard } from './ToolCallCard';
import { ToolResultCard } from './ToolResultCard';
import { JsonView, tryParseJson } from './JsonView';
import { TodoList } from './TodoList';
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

// memo:流式更新时 store 只更新正在流式的那条消息对象引用,
// 其余消息 vm 引用不变,直接跳过重渲染(markdown 渲染开销大)
export const MessageItem = memo(function MessageItem({
  vm,
  workspaceId,
}: {
  vm: MessageVM;
  workspaceId?: string;
}) {
  const parts = vm.parts ?? [];
  // 已归档的任务清单卡片(上一轮 todo_write 全部完成):作为消息流中的独立
  // 条目展示,不按普通消息气泡渲染(无 header / 气泡,整条就是任务清单卡片)
  if (vm.todoItems && vm.todoItems.length > 0) {
    return (
      <div className="py-1">
        <TodoList todos={vm.todoItems} variant="archived" />
      </div>
    );
  }
  const isUser = vm.role === 'user';
  // 用户消息中是否包含真正的发送文本(否则只是工具结果的载体)
  const hasUserText = isUser && parts.some((p) => p.type === 'text');
  // 仅含工具结果、无用户文本的消息:作为中间过程展示,不伪装成用户消息
  const isToolProcess = isUser && !hasUserText && parts.some((p) => p.type === 'tool_result');

  // 无任何可见 part 的消息整条隐藏(如仅 finish)
  const visibleParts = parts.filter((p) =>
    ['text', 'reasoning', 'tool_call', 'tool_result', 'shell_command'].includes(p.type),
  );
  if (visibleParts.length === 0) return null;

  const align = isToolProcess ? 'start' : isUser ? 'end' : 'start';
  // 用户消息用品牌色气泡(bg-primary + 前景色文字),内部 markdown/JSON
  // 需切换为反色配色(见 markdown.tsx),否则链接/行内代码/表格与气泡底色
  // 失去前景-背景对比,无法看清。
  const isInvertedBubble = !isToolProcess && isUser;
  const bubbleVariant = isToolProcess ? 'ghost' : isUser ? 'default' : 'muted';
  const roleLabel = isToolProcess ? '工具' : ROLE_LABEL[vm.role];

  // 提取 finish part,不参与 inline 渲染,合并进 header
  const finishPart = parts.find((p) => p.type === 'finish');
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
    <Message align={align}>
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
            <span>{roleLabel}</span>
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
        <Bubble variant={bubbleVariant} align={align}>
            <BubbleContent>
              {parts.map((part, i) => {
                const d = part.data as never as {
                  text?: string;
                  thinking?: string;
                  reason?: string;
                  name?: string;
                };
                switch (part.type) {
                  case 'text': {
                    const text = d.text ?? '';
                    // 非流式且内容为 JSON 对象/数组 → 结构化展示,不显示原始 JSON
                    const json = !vm.streaming ? tryParseJson(text) : null;
                    if (json !== null) {
                      return <JsonView key={i} data={json} inverted={isInvertedBubble} />;
                    }
                    return (
                      <Markdown
                        key={i}
                        text={text}
                        streaming={vm.streaming && vm.role === 'assistant'}
                        inverted={isInvertedBubble}
                      />
                    );
                  }
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
                      name?: string;
                      content?: string | Record<string, unknown>;
                      metadata?: string;
                      is_error?: boolean;
                    };
                    // 结构化内容(对象/数组)转为字符串;空内容但携带状态
                    // (is_error/metadata,如 bash 成功但无输出)仍需渲染卡片展示状态
                    const content =
                      typeof tr.content === 'string'
                        ? tr.content
                        : tr.content
                          ? JSON.stringify(tr.content, null, 2)
                          : '';
                    const hasStatus = !!tr.is_error || !!tr.metadata;
                    if ((!content || content.trim() === '') && !hasStatus) return null;
                    return (
                      <div key={i}>
                        <ToolResultCard
                          result={
                            { ...tr, content, name: tr.name ?? '' } as never
                          }
                        />
                      </div>
                    );
                  }
                  case 'shell_command': {
                    const sc = d as { command: string; output: string; exit_code: number };
                    return (
                      <div key={i}>
                        <ToolResultCard
                          command={sc.command}
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
      </MessageContent>
    </Message>
  );
});
