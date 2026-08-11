import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
  useMessageScroller,
  useMessageScrollerScrollable,
} from '../ui/message-scroller';
import type { MessageVM } from '../../stores/agentStore';
import { MessageItem } from './MessageItem';

/**
 * 把「仅含 tool_result、无文本的 user/tool 消息」合并进前一条 assistant 消息,
 * 让工具调用与返回结果在同一气泡中成对展示,不再拆分成多条消息。
 * 每个 tool_result 按 tool_call_id 插入到对应 tool_call 之后;找不到配对时追加到末尾。
 */
export function mergeToolResults(messages: MessageVM[]): MessageVM[] {
  const out: MessageVM[] = [];
  for (const m of messages) {
    const last = out[out.length - 1];
    const isResultCarrier =
      (m.role === 'user' || m.role === 'tool') &&
      !m.parts.some((p) => p.type === 'text') &&
      m.parts.some((p) => p.type === 'tool_result');
    if (!isResultCarrier || !last || last.role !== 'assistant') {
      out.push(m);
      continue;
    }
    const parts = [...last.parts];
    for (const part of m.parts) {
      if (part.type !== 'tool_result') {
        parts.push(part);
        continue;
      }
      const callId = part.data.tool_call_id;
      const callIdx = parts.findIndex(
        (p) => p.type === 'tool_call' && p.data.id === callId,
      );
      if (callIdx >= 0) parts.splice(callIdx + 1, 0, part);
      else parts.push(part);
    }
    out[out.length - 1] = {
      ...last,
      parts,
      updatedAt: Math.max(last.updatedAt, m.updatedAt),
    };
  }
  return out;
}

export type ScrollDecision =
  | { behavior: 'smooth'; reason: 'send' | 'stream' }
  | { behavior: 'auto' }
  | null;

export function decideScrollBehavior(args: {
  len: number;
  firstChanged: boolean;
  last: MessageVM | undefined;
  pinned: boolean;
  now: number;
  smoothUntil: number;
}): ScrollDecision {
  const { len, firstChanged, last, pinned, now, smoothUntil } = args;
  if (len === 0) return null;
  const isUserSend =
    last?.role === 'user' && !last.parts.some((p) => p.type === 'tool_result');
  if (isUserSend) return { behavior: 'smooth', reason: 'send' };
  if (firstChanged) {
    return now < smoothUntil
      ? { behavior: 'smooth', reason: 'stream' }
      : { behavior: 'auto' };
  }
  if (now < smoothUntil) return { behavior: 'smooth', reason: 'stream' };
  if (pinned) return { behavior: 'auto' };
  return null;
}

const SMOOTH_FOLLOW_MS = 800;

function ScrollToBottomController({ messages }: { messages: MessageVM[] }) {
  const { scrollToEnd } = useMessageScroller();
  const { end } = useMessageScrollerScrollable();
  const pinnedRef = useRef(true);
  const prevFirstRef = useRef<string | null>(null);
  const smoothUntilRef = useRef(0);

  useLayoutEffect(() => {
    const len = messages.length;
    const firstId = messages[0]?.id ?? null;
    const firstChanged = firstId !== null && firstId !== prevFirstRef.current;
    prevFirstRef.current = firstId;
    const now = performance.now();
    const decision = decideScrollBehavior({
      len,
      firstChanged,
      last: messages[len - 1],
      pinned: pinnedRef.current,
      now,
      smoothUntil: smoothUntilRef.current,
    });
    if (decision?.behavior === 'smooth' && decision.reason === 'send') {
      smoothUntilRef.current = now + SMOOTH_FOLLOW_MS;
    }
    if (decision) scrollToEnd({ behavior: decision.behavior });
  }, [messages, scrollToEnd]);

  useEffect(() => {
    if (!end) {
      pinnedRef.current = true;
    } else if (performance.now() > smoothUntilRef.current) {
      pinnedRef.current = false;
    }
  }, [end]);

  return null;
}

export function MessageList({
  messages,
  workspaceId,
}: {
  messages: MessageVM[];
  workspaceId?: string;
}) {
  // 合并工具结果,使 tool_call 与其 tool_result 同框展示
  const merged = useMemo(() => mergeToolResults(messages), [messages]);
  return (
    <MessageScrollerProvider
      scrollEdgeThreshold={80}
      defaultScrollPosition={undefined}
    >
      <MessageScroller>
        <MessageScrollerViewport>
          <MessageScrollerContent>
            {merged.map((m) => (
              <MessageScrollerItem key={m.id} messageId={m.id}>
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
      <ScrollToBottomController messages={messages} />
    </MessageScrollerProvider>
  );
}
