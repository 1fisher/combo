import { Megaphone, Moon, X } from 'lucide-react';

const TEMPLATES: { icon: typeof Moon; title: string; desc: string; prompt: string }[] = [
  {
    icon: Moon,
    title: 'Git 站会摘要',
    desc: '每周五总结这一周发生的事情。',
    prompt: '请查看这个项目最近的 Git 提交记录,生成一份本周的站会摘要。',
  },
  {
    icon: Moon,
    title: 'CI 失败与不稳定测试报告',
    desc: '汇总近期 CI 失败和不稳定测试，并分析可能原因。',
    prompt: '请查看项目的 CI 配置与最近运行结果,汇总失败和不稳定的测试,并分析可能原因。',
  },
  {
    icon: Moon,
    title: '自定义',
    desc: '跳过模板,直接告诉它你想做什么。',
    prompt: '',
  },
];

/** 空会话首页:问候语 + 订阅横幅 + 任务模板 */
export function ChatEmptyState({
  onPickTemplate,
  hasSession = false,
}: {
  onPickTemplate: (prompt: string) => void;
  hasSession?: boolean;
}) {
  return (
    <div className="flex min-h-full flex-col items-center justify-center gap-6 px-4 py-10 text-foreground">
      {/* 问候语 + 装饰背景 */}
      <div className="relative mb-10 flex w-full max-w-2xl flex-col items-center justify-center gap-6 sm:mb-8">
        <div
          aria-hidden
          className="pointer-events-none absolute left-1/2 top-1/2 aspect-[5/4] w-[min(72vw,25rem)] -mt-10 -translate-x-1/2 -translate-y-1/2 text-foreground-subtlest opacity-70 [mask-image:linear-gradient(to_bottom,black_0%,transparent_70%,transparent_100%)] [mask-repeat:no-repeat] [mask-size:100%_100%]"
        >
          <svg
            aria-hidden
            className="h-full w-full"
            width="400"
            height="320"
            viewBox="0 0 400 320"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
          >
            <path
              d="M398.97 0.5L147.576 319.5H1.03027L37.5996 273.081L120.167 169.603L120.171 169.598L215.342 47.5605L215.343 47.5615L252.424 0.5H398.97ZM264.544 273.271H372.527L336.082 319.498H189.886L202.642 303.307C217.584 284.34 240.398 273.271 264.544 273.271ZM209.164 0.5L202.786 8.58887C183.782 32.6885 154.782 46.752 124.091 46.752H25.9805L62.4268 0.5H209.164Z"
              stroke="currentColor"
            />
          </svg>
        </div>
        <p className="relative z-10 w-full px-4 text-center text-3xl font-medium max-md:text-xl">
          {hasSession ? '新任务已创建，输入消息开始对话' : '把复杂交给 AI，把时间留给自己'}
        </p>
      </div>
      {/* 订阅横幅 + 模板卡片 */}
      <div className="mt-6 flex w-full max-w-2xl flex-col gap-3">
        {!hasSession && (
        <div className="flex items-center justify-between">
          <div className="flex min-w-0 items-center gap-1 text-[13px] text-foreground-subtle opacity-80">
            <span className="flex size-8 shrink-0 items-center justify-center">
              <Megaphone className="size-4" />
            </span>
            <span className="min-w-0 cursor-default leading-snug">
              combo 是开源免费的 Agent IDE，喜欢就分享给朋友，一起体验 AI 编程的乐趣。
            </span>
          </div>
          <button
            type="button"
            aria-label="关闭"
            className="flex size-8 shrink-0 items-center justify-center rounded-md text-foreground-subtle opacity-80 hover:bg-surface-hover hover:opacity-100"
          >
            <X className="size-4" />
          </button>
        </div>
        )}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          {TEMPLATES.map((t) => (
            <button
              key={t.title}
              type="button"
              onClick={() => onPickTemplate(t.prompt)}
              className="flex flex-col gap-2 rounded-2xl border border-card-border bg-background p-3 text-left transition-colors hover:bg-surface-hover"
            >
              <div className="flex items-center gap-1.5">
                <span className="flex size-5 shrink-0 items-center justify-center">
                  <t.icon className="size-4 text-foreground-subtle" />
                </span>
                <span className="truncate text-[13px] leading-5 text-foreground">{t.title}</span>
              </div>
              <p className="line-clamp-3 text-xs leading-snug text-foreground-subtle">{t.desc}</p>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
