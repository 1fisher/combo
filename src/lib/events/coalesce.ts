import type { EventEnvelope } from './payloadTypes';

/**
 * SSE message 帧合流器:流式期间后端每个 delta 都广播全量 parts 快照,
 * 逐帧同步写入 store 会让流式消息每帧全量 react-markdown + highlight.js
 * 重渲,长消息(最后一个 turn 往往最长)渲染最贵,主线程积压时 finish /
 * run_complete 帧也被排队延后——表现为「最后一个 turn 卡很久才结束」。
 *
 * 这里按 message id 合并同一窗口(默认 80ms)内的 message 帧,只保留
 * 最新快照定时冲刷。语义保证:
 * - 后端每帧都是全量 parts 快照,丢弃中间帧不丢数据;
 *   finish part 只会出现在最后一帧,合流后仍必达。
 * - 非 message 帧(run_complete / permission / question / session 等)
 *   到达时先冲刷挂起帧再应用,保持到达顺序。
 * - message deleted 不参与合流(删除顺序敏感)。
 */
export class EventCoalescer {
  private pending = new Map<string, EventEnvelope>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly apply: (env: EventEnvelope) => void,
    private readonly intervalMs = 80,
  ) {}

  /** 收到一帧:message created/updated 可合流;其余帧冲刷后立即应用 */
  push(env: EventEnvelope): void {
    if (this.coalescible(env)) {
      // Map 保持首次插入顺序:多消息交错时按首次出现顺序冲刷,
      // 同一消息的后续快照只覆盖 value(最新帧)。
      this.pending.set(this.key(env), env);
      if (this.timer == null) {
        this.timer = setTimeout(() => this.flush(), this.intervalMs);
      }
      return;
    }
    this.flush();
    this.apply(env);
  }

  /** 立即冲刷挂起帧(stop / 非 message 帧到达时调用) */
  flush(): void {
    if (this.timer != null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.pending.size === 0) return;
    const batch = [...this.pending.values()];
    this.pending.clear();
    for (const env of batch) this.apply(env);
  }

  private coalescible(env: EventEnvelope): boolean {
    if (env.type !== 'message') return false;
    const inner = env.payload as { type?: string } | undefined;
    // deleted 不合流:upsert 与删除的先后顺序不能重排
    return inner?.type === 'created' || inner?.type === 'updated';
  }

  private key(env: EventEnvelope): string {
    const p = (env.payload as { payload?: { session_id?: string; id?: string } }).payload ?? {};
    return `${p.session_id ?? ''}:${p.id ?? ''}`;
  }
}
