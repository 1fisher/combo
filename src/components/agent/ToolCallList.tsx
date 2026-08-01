import type { Api } from '../../lib/api/types';
import { ToolCallCard, type ToolCallInfo } from './ToolCallCard';

export function ToolCallList({ parts }: { parts: Api.ContentPart[] }) {
  const calls: ToolCallInfo[] = [];
  for (const p of parts) {
    if (p.type === 'tool_call') {
      const d = p.data as never as {
        id: string;
        name: string;
        input: string;
        finished?: boolean;
      };
      calls.push({ id: d.id, name: d.name, input: d.input, finished: !!d.finished });
    }
  }
  if (calls.length === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      {calls.map((c) => (
        <ToolCallCard key={c.id} call={c} />
      ))}
    </div>
  );
}
