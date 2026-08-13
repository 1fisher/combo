import { useState } from 'react';
import { Button } from '../ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
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

  /** 用户选择"跳过"——让 agent 自行决定 */
  function buildSkipped(): Api.QuestionAnswer {
    return {
      batch_request_id: batch.id,
      responses: [],
      skipped: true,
    };
  }

  return (
    <Dialog open>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{batch.confirm_title || '需要你的输入'}</DialogTitle>
          {batch.confirm_description && (
            <DialogDescription className="text-sm text-muted-foreground leading-relaxed">
              {batch.confirm_description}
            </DialogDescription>
          )}
        </DialogHeader>
        <div className="flex max-h-[60vh] flex-col gap-4 overflow-auto pr-1">
          {batch.questions.map((q, qi) => (
            <div key={q.id} className="rounded-lg border border-border/50 p-3">
              <div className="mb-1 flex items-start gap-2">
                <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[10px] font-bold text-primary">
                  {qi + 1}
                </span>
                <div className="flex-1">
                  <div className="text-sm font-medium leading-snug">{q.question}</div>
                  {q.description && (
                    <div className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                      {q.description}
                    </div>
                  )}
                </div>
              </div>
              <div className="mt-2 pl-7">
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
                  <div className="flex flex-col gap-1.5">
                    {q.choices?.map((c) => {
                      const on = selected[q.id]?.includes(c.id) ?? false;
                      return (
                        <label
                          key={c.id}
                          className="flex cursor-pointer items-start gap-2 rounded-md border border-border/50 px-3 py-2 text-sm transition-colors hover:bg-muted/50"
                        >
                          <input
                            type={q.type === 'single_choice' ? 'radio' : 'checkbox'}
                            name={q.type === 'single_choice' ? `q-${q.id}` : undefined}
                            className="mt-0.5"
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
                          <span className="flex-1">
                            <span className="font-medium">{c.label}</span>
                            {c.description && (
                              <span className="mt-0.5 block text-xs text-muted-foreground">
                                {c.description}
                              </span>
                            )}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                )}
                {q.type === 'free_text' && (
                  <textarea
                    className="w-full resize-none rounded-md border border-border/50 bg-transparent px-3 py-2 text-sm outline-none focus:border-primary focus:ring-1 focus:ring-primary"
                    rows={2}
                    placeholder="请输入…"
                    value={fills[q.id] ?? ''}
                    onChange={(e) =>
                      setFills((f) => ({ ...f, [q.id]: e.target.value }))
                    }
                  />
                )}
              </div>
            </div>
          ))}
        </div>
        <DialogFooter className="flex-row justify-end gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onResolve(buildSkipped())}
          >
            让 agent 自行决定
          </Button>
          <Button size="sm" onClick={() => onResolve(build())}>
            提交回答
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
