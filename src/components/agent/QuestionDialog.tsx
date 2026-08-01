import { useState } from 'react';
import { Button } from '../ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import type { Api } from '../../lib/api/types';

export function QuestionDialog({
  batch,
  onResolve,
}: {
  batch: Api.QuestionRequest;
  onResolve: (answer: Api.QuestionAnswer) => void;
}) {
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [fills, setFills] = useState<Record<string, string>>({});

  function build(): Api.QuestionAnswer {
    return {
      batch_request_id: batch.id,
      responses: batch.questions.map((q) => {
        if (q.type === 'yes_no') {
          const sel = selected[q.id] ?? [];
          return { request_id: q.id, yes: sel[0] === 'yes' };
        }
        if (q.type === 'free_text') {
          return { request_id: q.id, fill_in_text: fills[q.id] ?? '' };
        }
        return { request_id: q.id, selected_ids: selected[q.id] ?? [] };
      }),
    };
  }

  return (
    <Dialog open>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="text-sm">agent 提问</DialogTitle>
        </DialogHeader>
        <div className="flex max-h-72 flex-col gap-4 overflow-auto">
          {batch.questions.map((q) => (
            <div key={q.id}>
              <div className="mb-1 text-sm font-medium">{q.question}</div>
              {q.description && (
                <div className="mb-1 text-xs text-muted-foreground">{q.description}</div>
              )}
              {q.type === 'yes_no' && (
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant={selected[q.id]?.[0] === 'yes' ? 'default' : 'outline'}
                    onClick={() => setSelected((s) => ({ ...s, [q.id]: ['yes'] }))}
                  >
                    是
                  </Button>
                  <Button
                    size="sm"
                    variant={selected[q.id]?.[0] === 'no' ? 'default' : 'outline'}
                    onClick={() => setSelected((s) => ({ ...s, [q.id]: ['no'] }))}
                  >
                    否
                  </Button>
                </div>
              )}
              {(q.type === 'single_choice' || q.type === 'multi_choice') && (
                <div className="flex flex-col gap-1">
                  {q.choices?.map((c) => {
                    const on = selected[q.id]?.includes(c.id) ?? false;
                    return (
                      <label
                        key={c.id}
                        className="flex items-center gap-2 rounded border px-2 py-1 text-sm hover:bg-muted"
                      >
                        <input
                          type={q.type === 'single_choice' ? 'radio' : 'checkbox'}
                          checked={on}
                          onChange={() =>
                            setSelected((s) => {
                              const cur = s[q.id] ?? [];
                              const next =
                                q.type === 'single_choice'
                                  ? [c.id]
                                  : on
                                    ? cur.filter((x) => x !== c.id)
                                    : [...cur, c.id];
                              return { ...s, [q.id]: next };
                            })
                          }
                        />
                        {c.label}
                      </label>
                    );
                  })}
                </div>
              )}
              {q.type === 'free_text' && (
                <input
                  className="w-full rounded border px-2 py-1 text-sm"
                  value={fills[q.id] ?? ''}
                  onChange={(e) =>
                    setFills((f) => ({ ...f, [q.id]: e.target.value }))
                  }
                />
              )}
            </div>
          ))}
        </div>
        <DialogFooter>
          <Button onClick={() => onResolve(build())}>提交回答</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
