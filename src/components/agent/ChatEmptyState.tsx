import { Megaphone, Moon, X } from 'lucide-react';
import { HeroParticles } from './HeroParticles';

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
    <div className="relative flex flex-col justify-center items-center gap-6 px-4 py-10 min-h-full text-foreground">
      {/* 装饰背景:Combo 白色线框字,倾斜横贯首屏(样式/定位/动画见 index.css
          .combo-hero-*);整词始终完整可见,不裁切、不产生横向滚动条。
          叠加 HeroParticles 粒子层:粒子飘入聚合构成字形,品牌色流光周期扫过 */}
      <div
        aria-hidden
        className="combo-hero-bg absolute inset-0 overflow-hidden pointer-events-none [mask-image:linear-gradient(to_bottom,black_0%,black_60%,transparent_96%,transparent_100%)] [mask-repeat:no-repeat] [mask-size:100%_100%]"
      >
        {/* 宽度适配:svg 宽取容器宽(上限 88rem),而不是 vw——侧栏/编辑器分走
            宽度后会话区远窄于视口,按 vw 定宽必然裁字;整词经 textLength 锁定在
            画布 87% 宽,旋转 −11° 后外接框约占容器 89%,两端留边完整显示;
            居中位移与倾斜在 .combo-hero-bg svg 的 transform 里统一处理 */}
        <svg
          aria-hidden
          className="w-full max-w-[88rem]"
          viewBox="0 0 460 190"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          {/* 线框文字:白色描边 + 0.3 透明度,样式见 index.css .combo-hero-word;
              textLength 把整词锁定为 400(viewBox 单位),字体回退变宽/变窄
              也不会溢出画布,跨平台渲染一致 */}
          <text x="230" y="140" textAnchor="middle" textLength="400" lengthAdjust="spacingAndGlyphs" className="combo-hero-word">Combo</text>
        </svg>
        {/* 粒子聚合 + 流光层:置于线框字之上,plus-lighter 加法混合把流光
            「加」在字与背景上;粒子目标点按同一姿态采样,与线框字对齐 */}
        <HeroParticles />
      </div>
      {/* 问候语(压在背景字之上) */}
      <div className="relative flex flex-col justify-center items-center gap-6 mb-10 sm:mb-8 w-full max-w-2xl">
        <p className="z-10 relative px-4 w-full font-medium max-md:text-xl text-3xl text-center">
          {hasSession ? '新任务已创建，输入消息开始对话' : '把复杂交给 AI，把时间留给自己'}
        </p>
      </div>
      {/* 订阅横幅 + 模板卡片 */}
      <div className="relative z-10 flex flex-col gap-3 mt-6 w-full max-w-2xl">
        {!hasSession && (
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
