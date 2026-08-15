import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';

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

/**
 * 运行中指示器:贴在输入坞(composer)上方,展示「正在执行 + 累计耗时」,
 * 附带流光特效(高光自左向右循环扫过,见 index.css 的 .run-shimmer)。
 */
export function RunningIndicator({ startedAt }: { startedAt?: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  if (startedAt == null) return null;
  return (
    <div
      role="status"
      className="relative mb-2 flex w-fit items-center gap-2 overflow-hidden rounded-full border border-brand/25 bg-brand/10 px-3 py-1 text-xs"
    >
      <Loader2 className="size-3 animate-spin text-brand" />
      <span className="font-medium text-foreground">正在执行</span>
      <span className="font-mono tabular-nums text-foreground-subtle">
        {formatElapsed(now - startedAt)}
      </span>
      {/* 流光层:纯装饰 */}
      <span className="run-shimmer" aria-hidden />
    </div>
  );
}
