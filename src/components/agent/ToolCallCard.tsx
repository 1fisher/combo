import { Badge } from '../ui/badge';

export interface ToolCallInfo {
  id: string;
  name: string;
  input: string;
  finished: boolean;
}

export function ToolCallCard({ call }: { call: ToolCallInfo }) {
  return (
    <details className="rounded-md border bg-muted/30">
      <summary className="flex cursor-pointer items-center gap-2 px-3 py-2">
        <span className="font-mono text-xs">⚙ {call.name}</span>
        <Badge variant={call.finished ? 'secondary' : 'outline'}>
          {call.finished ? 'done' : 'pending'}
        </Badge>
      </summary>
      <pre className="overflow-x-auto border-t bg-background px-3 py-2 font-mono text-xs text-muted-foreground">
        {call.input}
      </pre>
    </details>
  );
}
