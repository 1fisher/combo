import { cn } from '../../lib/utils';

/**
 * 尝试把文本解析为 JSON 对象/数组(解析失败返回 null)。
 * 仅识别以 { / [ 开头、以 } / ] 结尾的文本,避免把普通文本误判为 JSON。
 */
export function tryParseJson(text: string): unknown | null {
  if (!text) return null;
  const t = text.trim();
  if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
    try {
      return JSON.parse(t);
    } catch {
      return null;
    }
  }
  return null;
}

/** 嵌套深度上限,防止极端深层 JSON 拖垮渲染 */
const MAX_DEPTH = 12;

function JsonValue({ data, depth }: { data: unknown; depth: number }) {
  if (depth > MAX_DEPTH) {
    return <span className="text-foreground-subtlest">…</span>;
  }
  if (data === null) {
    return <span className="font-mono italic text-foreground-subtlest">null</span>;
  }
  if (typeof data === 'string') {
    return <span className="break-all text-foreground">{data}</span>;
  }
  if (typeof data === 'number') {
    return <span className="font-mono text-brand tabular-nums">{String(data)}</span>;
  }
  if (typeof data === 'boolean') {
    return <span className="font-mono text-success">{String(data)}</span>;
  }
  if (Array.isArray(data)) {
    return <JsonArray items={data} depth={depth} />;
  }
  if (typeof data === 'object') {
    return <JsonObject obj={data as Record<string, unknown>} depth={depth} />;
  }
  return <span className="break-all text-foreground">{String(data)}</span>;
}

function JsonObject({ obj, depth }: { obj: Record<string, unknown>; depth: number }) {
  const entries = Object.entries(obj);
  if (entries.length === 0) {
    return <span className="font-mono text-foreground-subtlest">{'{ }'}</span>;
  }
  return (
    <div className="overflow-hidden rounded-md border border-border/70 bg-background/60">
      {entries.map(([k, v]) => (
        <div
          key={k}
          className="flex items-baseline gap-x-2 border-b border-border/60 px-2 py-1 last:border-b-0"
        >
          <span className="shrink-0 font-mono text-[11px] leading-relaxed text-foreground-subtle">
            {k}
          </span>
          <div className="min-w-0 flex-1">
            <JsonValue data={v} depth={depth + 1} />
          </div>
        </div>
      ))}
    </div>
  );
}

function JsonArray({ items, depth }: { items: unknown[]; depth: number }) {
  if (items.length === 0) {
    return <span className="font-mono text-foreground-subtlest">[ ]</span>;
  }
  return (
    <div className="overflow-hidden rounded-md border border-border/70 bg-background/60">
      {items.map((item, i) => (
        <div
          key={i}
          className="flex items-baseline gap-x-2 border-b border-border/60 px-2 py-1 last:border-b-0"
        >
          <span className="shrink-0 font-mono text-[10px] leading-relaxed text-foreground-subtlest">
            {i}
          </span>
          <div className="min-w-0 flex-1">
            <JsonValue data={item} depth={depth + 1} />
          </div>
        </div>
      ))}
    </div>
  );
}

/** 把 JSON 值渲染成键值对/列表形式的结构化展示,替代原始 JSON 文本 */
export function JsonView({ data, className }: { data: unknown; className?: string }) {
  return (
    <div className={cn('max-h-[50vh] overflow-auto text-xs leading-relaxed', className)}>
      <JsonValue data={data} depth={0} />
    </div>
  );
}
