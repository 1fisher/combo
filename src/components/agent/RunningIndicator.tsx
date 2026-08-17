import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useAgentStore } from '../../stores/agentStore';
import { formatTokenCount } from '../../lib/tokens';

/** 格式化执行耗时:mm:ss,超过 1 小时为 h:mm:ss */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** 流式输出速度采样间隔(毫秒) */
const SPEED_SAMPLE_MS = 500;

/**
 * 采样当前流式消息(文本 + 思考)的字符增量,EMA 平滑为字符/秒。
 * 与 Composer 火焰热力同源:工具执行期无流式内容,速度自然衰减到 0。
 */
export function useStreamCharRate(active: boolean): number {
  const [rate, setRate] = useState(0);
  useEffect(() => {
    if (!active) {
      setRate(0);
      return;
    }
    let lastLen = -1;
    let lastTime = performance.now();
    let ema = 0;
    const tick = () => {
      const st = useAgentStore.getState();
      const rt = st.activeSessionId ? st.bySession[st.activeSessionId] : undefined;
      let len = 0;
      for (const m of rt?.messages ?? []) {
        if (!m.streaming) continue;
        for (const p of m.parts) {
          if (p.type === 'text') len += p.data.text.length;
          else if (p.type === 'reasoning') len += p.data.thinking.length;
        }
      }
      const now = performance.now();
      const dt = (now - lastTime) / 1000;
      lastTime = now;
      if (lastLen >= 0 && dt > 0) {
        const target = Math.max((len - lastLen) / dt, 0);
        ema = ema === 0 ? target : ema * 0.7 + target * 0.3;
        setRate(ema);
      }
      lastLen = len;
    };
    tick();
    const id = window.setInterval(tick, SPEED_SAMPLE_MS);
    return () => window.clearInterval(id);
  }, [active]);
  return rate;
}

/**
 * 运行中指示器:贴在输入坞(composer)上方,展示「正在执行 + 流式输出速度 +
 * 累计耗时」,附带流光特效(高光自左向右循环扫过,见 index.css 的 .run-shimmer,
 * 光带宽度随胶囊宽度自适应)。
 */
export function RunningIndicator({ startedAt }: { startedAt?: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const streamRate = useStreamCharRate(startedAt != null);
  if (startedAt == null) return null;
  return (
    <div
      role="status"
      className="relative mb-2 flex w-fit items-center gap-2 overflow-hidden rounded-full border border-brand/25 bg-brand/10 px-3 py-1 text-xs"
    >
      <Loader2 className="size-3 animate-spin text-brand" />
      <span className="font-medium text-foreground">正在执行</span>
      {streamRate >= 1 && (
        <span className="font-mono tabular-nums text-foreground-subtle">
          {formatTokenCount(streamRate)} 字/s
        </span>
      )}
      <span className="font-mono tabular-nums text-foreground-subtle">
        {formatElapsed(now - startedAt)}
      </span>
      {/* 流光层:纯装饰 */}
      <span className="run-shimmer" aria-hidden />
    </div>
  );
}
