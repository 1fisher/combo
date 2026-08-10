import { useConnectionStore } from '../../stores/connectionStore';
import { cn } from '../../lib/utils';

const DOT: Record<string, string> = {
  connected: 'bg-emerald-500',
  disconnected: 'bg-zinc-400',
  connecting: 'bg-amber-400',
};

export function StatusBar() {
  const status = useConnectionStore((s) => s.status);
  const lastError = useConnectionStore((s) => s.lastError);
  const label =
    status === 'connected' ? '已连接 combo' : status === 'connecting' ? '连接中…' : '已断开';
  return (
    <footer className="flex h-6 items-center gap-2 border-t px-3 text-xs text-muted-foreground">
      <span className={cn('h-2 w-2 rounded-full', DOT[status] ?? DOT.disconnected)} />
      <span>{label}</span>
      {status === 'disconnected' && !lastError && (
        <span className="text-destructive">
          (未检测到 agent 服务,请确认 combo-cli 已安装并位于 PATH)
        </span>
      )}
    </footer>
  );
}
