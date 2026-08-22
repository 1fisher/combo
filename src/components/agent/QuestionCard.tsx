import { useState } from 'react';
import { MessageCircleQuestion } from 'lucide-react';
import { Button } from '../ui/button';
import type { Api } from '../../lib/api/types';
import { cn } from '../../lib/utils';

/** 「其他(手动输入)」合成选项 id:提交时拆为 fill_in_text 回传,不进 selected_ids */
const OTHER_ID = '__other__';

/**
 * 问题渲染类型:type 缺失/未知时兜底——有选项按单选、无选项按自由输入。
 * (后端 question.rs 已归一 type,这里防旧后端或异常数据导致选项不渲染)
 */
function kindOf(q: Api.QuestionItem): 'yes_no' | 'multi' | 'single' | 'text' {
  if (q.type === 'yes_no') return 'yes_no';
  if (q.type === 'multi_choice') return 'multi';
  if (q.type === 'free_text') return 'text';
  if (q.type === 'single_choice' || (q.choices?.length ?? 0) > 0) return 'single';
  return 'text';
}

/**
 * 问题卡片(question 工具):非模态,显示在输入坞上方(与任务进度卡片同级样式)。
 *
 * - 单选/多选问题在选项末尾追加「其他(手动输入)」;选中后展开输入框,
 *   提交时自定义文本经 `fill_in_text` 与 `selected_ids` 一并回传,
 *   后端 format_answer 会把两者合并为 agent 可读的答案。
 * - 头部「让 agent 自行决定」= 跳过回答(skipped),由 agent 自行决策。
 */
export function QuestionCard({
  batch,
  onResolve,
}: {
  batch: Api.QuestionRequest;
  onResolve: (answer: Api.QuestionAnswer) => void;
}) {
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [fills, setFills] = useState<Record<string, string>>({});

  function toggleChoice(q: Api.QuestionItem, id: string) {
    setSelected((s) => {
      const cur = s[q.id] ?? [];
      if (kindOf(q) !== 'multi') return { ...s, [q.id]: [id] };
      const on = cur.includes(id);
      return { ...s, [q.id]: on ? cur.filter((x) => x !== id) : [...cur, id] };
    });
  }

  function build(): Api.QuestionAnswer {
    return {
      batch_request_id: batch.id,
      responses: batch.questions.map((q) => {
        const sel = selected[q.id] ?? [];
        const kind = kindOf(q);
        if (kind === 'yes_no') {
          return { request_id: q.id, yes: sel[0] === 'yes' };
        }
        if (kind === 'text') {
          return { request_id: q.id, fill_in_text: fills[q.id] ?? '' };
        }
        // 单选/多选:真实选项进 selected_ids;「其他」的自定义文本进 fill_in_text
        const ids = sel.filter((id) => id !== OTHER_ID);
        const custom = sel.includes(OTHER_ID) ? (fills[q.id] ?? '').trim() : '';
        const resp: Api.QuestionResponse = { request_id: q.id, selected_ids: ids };
        if (custom) resp.fill_in_text = custom;
        return resp;
      }),
    };
  }

  /** 用户选择「让 agent 自行决定」——跳过回答 */
  function buildSkipped(): Api.QuestionAnswer {
    return { batch_request_id: batch.id, responses: [], skipped: true };
  }

  /** 选项行(含「其他」):选中态高亮 */
  function choiceRow(on: boolean) {
    return cn(
      'flex cursor-pointer items-start gap-2 rounded-md border px-2.5 py-1.5 text-xs transition-colors hover:bg-muted/50',
      on ? 'border-primary/60 bg-primary/5' : 'border-border/50'
    );
  }

  return (
    <div className="mx-4 mb-2 rounded-xl border border-border bg-surface/40">
      {/* 头部:标题 + 描述 + 跳过 */}
      <div className="flex items-start gap-2 px-3 py-2">
        <MessageCircleQuestion className="mt-0.5 size-3.5 shrink-0 text-brand" />
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium leading-snug text-foreground">
            {batch.confirm_title || '需要你的输入'}
          </div>
          {batch.confirm_description && (
            <div className="mt-0.5 text-[11px] leading-relaxed text-foreground-subtle">
              {batch.confirm_description}
            </div>
          )}
        </div>
        <button
          type="button"
          className="shrink-0 text-[11px] text-foreground-subtle underline-offset-2 transition-colors hover:text-foreground hover:underline"
          onClick={() => onResolve(buildSkipped())}
        >
          让 agent 自行决定
        </button>
      </div>
      {/* 问题区:多问题时限高内部滚动,避免挤压 Composer */}
      <div className="flex max-h-72 flex-col gap-3 overflow-y-auto overscroll-contain border-t border-border/50 px-3 py-2.5">
        {batch.questions.map((q, qi) => {
          const sel = selected[q.id] ?? [];
          const kind = kindOf(q);
          const otherOn = sel.includes(OTHER_ID);
          return (
            <div key={q.id}>
              <div className="flex items-start gap-1.5">
                <span className="text-xs font-medium text-brand">{qi + 1}.</span>
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-medium leading-snug">{q.question}</div>
                  {q.description && (
                    <div className="mt-0.5 text-[11px] leading-relaxed text-foreground-subtle">
                      {q.description}
                    </div>
                  )}
                </div>
              </div>
              <div className="mt-1.5 flex flex-col gap-1 pl-4">
                {kind === 'yes_no' && (
                  <div className="flex flex-col gap-1">
                    {(
                      [
                        { id: 'yes', label: '是' },
                        { id: 'no', label: '否' },
                      ] as const
                    ).map((c) => {
                      const on = sel[0] === c.id;
                      return (
                        <label key={c.id} className={choiceRow(on)}>
                          <input
                            type="radio"
                            name={`q-${q.id}`}
                            className="mt-0.5"
                            checked={on}
                            onChange={() => setSelected((s) => ({ ...s, [q.id]: [c.id] }))}
                          />
                          <span className="flex-1 font-medium leading-relaxed">{c.label}</span>
                        </label>
                      );
                    })}
                  </div>
                )}
                {(kind === 'single' || kind === 'multi') && (
                  <div className="flex flex-col gap-1">
                    {q.choices?.map((c) => {
                      const on = sel.includes(c.id);
                      return (
                        <label key={c.id} className={choiceRow(on)}>
                          <input
                            type={kind === 'single' ? 'radio' : 'checkbox'}
                            name={kind === 'single' ? `q-${q.id}` : undefined}
                            className="mt-0.5"
                            checked={on}
                            onChange={() => toggleChoice(q, c.id)}
                          />
                          <span className="flex-1 leading-relaxed">
                            <span className="font-medium">{c.label}</span>
                            {c.description && (
                              <span className="mt-0.5 block text-[11px] text-muted-foreground">
                                {c.description}
                              </span>
                            )}
                          </span>
                        </label>
                      );
                    })}
                    {/* 其他(手动输入):选项都不合适时自由作答 */}
                    <label className={choiceRow(otherOn)}>
                      <input
                        type={kind === 'single' ? 'radio' : 'checkbox'}
                        name={kind === 'single' ? `q-${q.id}` : undefined}
                        className="mt-0.5"
                        checked={otherOn}
                        onChange={() => toggleChoice(q, OTHER_ID)}
                      />
                      <span className="flex-1 font-medium leading-relaxed">其他(手动输入)</span>
                    </label>
                    {otherOn && (
                      <input
                        className="w-full rounded-md border border-border/50 bg-transparent px-2.5 py-1.5 text-xs outline-none focus:border-primary focus:ring-1 focus:ring-primary"
                        placeholder="请输入自定义答案…"
                        value={fills[q.id] ?? ''}
                        onChange={(e) => setFills((f) => ({ ...f, [q.id]: e.target.value }))}
                      />
                    )}
                  </div>
                )}
                {kind === 'text' && (
                  <textarea
                    className="w-full resize-none rounded-md border border-border/50 bg-transparent px-2.5 py-1.5 text-xs outline-none focus:border-primary focus:ring-1 focus:ring-primary"
                    rows={2}
                    placeholder="请输入…"
                    value={fills[q.id] ?? ''}
                    onChange={(e) => setFills((f) => ({ ...f, [q.id]: e.target.value }))}
                  />
                )}
              </div>
            </div>
          );
        })}
      </div>
      {/* 底部:提交 */}
      <div className="flex items-center justify-end border-t border-border/50 px-3 py-2">
        <Button size="sm" onClick={() => onResolve(build())}>
          提交回答
        </Button>
      </div>
    </div>
  );
}
