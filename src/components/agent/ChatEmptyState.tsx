import { useState } from 'react';
import { Megaphone, Moon, X } from 'lucide-react';
import { HeroParticles } from './HeroParticles';

/** 订阅横幅关闭状态持久化 key(与 combo.agent/combo.clientId 同一命名约定) */
const BANNER_DISMISSED_KEY = 'combo.bannerDismissed';

function readBannerDismissed(): boolean {
  try {
    return localStorage.getItem(BANNER_DISMISSED_KEY) === '1';
  } catch {
    return false;
  }
}


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
  // 横幅关闭后写入 localStorage,刷新/重启后不再重复出现
  const [bannerDismissed, setBannerDismissed] = useState(readBannerDismissed);
  const dismissBanner = () => {
    setBannerDismissed(true);
    try {
      localStorage.setItem(BANNER_DISMISSED_KEY, '1');
    } catch {
      // 忽略写入失败(隐私模式等),仅本次会话内隐藏
    }
  };
  return (
    <div className="relative flex flex-col justify-center items-center gap-6 px-4 py-10 min-h-full text-foreground">
      {/* 装饰背景(Combo 线框字 + 粒子流光),与会话/自动化首页共用,见 HeroParticles */}
      <HeroParticles />
      {/* 问候语(压在背景字之上) */}
      <div className="relative flex flex-col justify-center items-center gap-6 mb-10 sm:mb-8 w-full max-w-2xl">
        <p className="z-10 relative px-4 w-full font-medium max-md:text-xl text-3xl text-center">
          {hasSession ? '新任务已创建，输入消息开始对话' : '把复杂交给 AI，把时间留给自己'}
        </p>
      </div>
      {/* 订阅横幅 + 模板卡片 */}
      <div className="relative z-10 flex flex-col gap-3 mt-6 w-full max-w-2xl">
        {!hasSession && !bannerDismissed && (
        <div className="flex justify-between items-center">
          <div className="flex items-center gap-1 opacity-80 min-w-0 text-[13px] text-foreground-subtle">
            <span className="flex justify-center items-center size-8 shrink-0">
              <Megaphone className="size-4" />
            </span>
            <span className="min-w-0 leading-snug cursor-default">
              Combo 是开源免费的 Agent IDE，喜欢就分享给朋友，一起体验 AI 编程的乐趣。
            </span>
          </div>
          <button
            type="button"
            aria-label="关闭"
            onClick={dismissBanner}
            className="flex justify-center items-center hover:bg-surface-hover opacity-80 hover:opacity-100 rounded-md size-8 text-foreground-subtle shrink-0"
          >
            <X className="size-4" />
          </button>
        </div>
        )}
        <div className="gap-4 grid grid-cols-1 sm:grid-cols-3">
          {TEMPLATES.map((t) => (
            <button
              key={t.title}
              type="button"
              onClick={() => onPickTemplate(t.prompt)}
              className="flex flex-col gap-2 bg-background hover:bg-surface-hover p-3 border border-card-border rounded-2xl text-left transition-colors"
            >
              <div className="flex items-center gap-1.5">
                <span className="flex justify-center items-center size-5 shrink-0">
                  <t.icon className="size-4 text-foreground-subtle" />
                </span>
                <span className="text-[13px] text-foreground truncate leading-5">{t.title}</span>
              </div>
              <p className="text-foreground-subtle text-xs line-clamp-3 leading-snug">{t.desc}</p>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
