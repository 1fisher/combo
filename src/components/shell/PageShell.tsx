import type { ComponentType, ReactNode } from 'react';
import { HeroBackdrop } from '../agent/HeroBackdrop';

/**
 * 全尺寸视图共享脚手架:自动化/搜索/技能/MCP/统计等主内容区独立视图
 * 共用的页面容器、页头、hero 空首页与表单输入样式,保证视觉语言一致。
 */

/** 页面容器:铺满内容区宽度,超宽屏封顶,保证整页观感 */
export const PAGE = 'mx-auto flex w-full max-w-[1400px] flex-col px-6 py-8 md:px-10';

/** 表单输入/标签样式(与自动化视图表单一致) */
export const INPUT_CLS =
  'h-9 w-full rounded-lg border border-border bg-surface-hover px-3 text-sm text-foreground outline-none transition-colors placeholder:text-foreground-subtlest focus:border-ring/60 focus:ring-1 focus:ring-ring/40';
export const LABEL_CLS = 'mb-1.5 block text-[13px] font-medium text-foreground-subtle';

/** 视图外层:占满高度 + 独立滚动区 */
export function ViewScroll({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
    </div>
  );
}

/** 页头:大标题 + 描述 + 右侧操作区(按钮/筛选/分段控件) */
export function PageHeader({
  title,
  desc,
  children,
}: {
  title: string;
  desc?: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h2 className="text-xl font-semibold text-foreground">{title}</h2>
        {desc && (
          <p className="mt-1.5 max-w-2xl text-[13px] leading-relaxed text-foreground-subtle">
            {desc}
          </p>
        )}
      </div>
      {children && <div className="flex shrink-0 flex-wrap items-center gap-2">{children}</div>}
    </div>
  );
}

/**
 * hero 空首页:与会话首页(ChatEmptyState)/自动化首页同构——
 * hero 背景(Combo 线框字 + 粒子流光)+ 问候语 + 内容槽(模板卡片/说明卡片)。
 */
export function HeroEmpty({
  title,
  desc,
  children,
}: {
  title: string;
  desc?: string;
  children?: ReactNode;
}) {
  return (
    <div className="relative flex min-h-full flex-col items-center justify-center gap-6 px-4 py-10 text-foreground">
      {/* 装饰背景(与会话首页共用,见 HeroBackdrop) */}
      <HeroBackdrop />

      {/* 问候语(压在背景字之上) */}
      <div className="relative z-10 flex w-full max-w-2xl flex-col items-center gap-5">
        <p className="w-full px-4 text-center font-medium max-md:text-xl text-3xl">{title}</p>
        {desc && (
          <p className="max-w-md px-4 text-center text-[13px] leading-relaxed text-foreground-subtle">
            {desc}
          </p>
        )}
      </div>

      {/* 内容槽:模板卡片 / 说明卡片等 */}
      {children}
    </div>
  );
}

/** hero 首页内容卡片(与会话首页任务模板同款样式) */
export function HeroCard({
  icon: Icon,
  title,
  desc,
  onClick,
}: {
  icon: ComponentType<{ className?: string }>;
  title: string;
  desc: string;
  onClick?: () => void;
}) {
  const cls =
    'flex w-full flex-col gap-2 rounded-2xl border border-card-border bg-background p-3 text-left';
  const body = (
    <>
      <div className="flex items-center gap-1.5">
        <span className="flex size-5 shrink-0 items-center justify-center">
          <Icon className="size-4 text-foreground-subtle" />
        </span>
        <span className="truncate text-[13px] leading-5 text-foreground">{title}</span>
      </div>
      <p className="text-xs leading-snug text-foreground-subtle line-clamp-3">{desc}</p>
    </>
  );
  if (onClick) {
    return (
      <button type="button" onClick={onClick} className={`${cls} transition-colors hover:bg-surface-hover`}>
        {body}
      </button>
    );
  }
  return <div className={cls}>{body}</div>;
}
