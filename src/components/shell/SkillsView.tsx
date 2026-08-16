import { useState } from 'react';
import { FolderGit2, Loader2, Search, WandSparkles } from 'lucide-react';
import { Switch } from '../ui/switch';
import { useSkills, useWorkspaceDisabledSkills } from '../../hooks/useSkills';
import { useActiveWorkspaceId } from '../../hooks/useActiveWorkspaceId';
import { useWorkspaces } from '../../hooks/useWorkspaces';
import { cn } from '../../lib/utils';
import { HeroCard, HeroEmpty, PAGE, PageHeader, ViewScroll } from './PageShell';

/**
 * 技能视图(主内容区独立视图):技能是包含 SKILL.md 的目录,description 自动
 * 注入 agent 系统提示词。无技能时是 hero 首页(说明三个扫描目录);有技能时
 * 全宽卡片列表 + 筛选框 + 每项目开关(per-workspace disabled_skills)。
 */

/** 技能扫描目录(与后端 skills.rs::discover 一致,项目级优先) */
const SKILL_DIRS: { icon: typeof FolderGit2; label: string; path: string; desc: string }[] = [
  {
    icon: FolderGit2,
    label: '项目级技能',
    path: '<项目>/.combo/skills',
    desc: '放在项目里的技能,仅该项目生效,优先级最高。',
  },
  {
    icon: WandSparkles,
    label: 'Combo 专属',
    path: '~/.config/combo/skills',
    desc: '本机 combo 默认技能目录,所有项目可用。',
  },
  {
    icon: FolderGit2,
    label: '通用技能',
    path: '~/.agents/skills',
    desc: '多个 agent 工具共享的通用技能目录。',
  },
];

export function SkillsView() {
  const activeWorkspaceId = useActiveWorkspaceId();
  const { workspaces } = useWorkspaces();
  const { data: skills, isLoading } = useSkills(activeWorkspaceId);
  const { isDisabled, toggle, toggling } = useWorkspaceDisabledSkills(activeWorkspaceId);
  const [filter, setFilter] = useState('');

  const filtered = (skills ?? []).filter(
    (s) =>
      s.name.toLowerCase().includes(filter.toLowerCase()) ||
      s.description.toLowerCase().includes(filter.toLowerCase())
  );

  const activeWsName = workspaces?.find((w) => w.id === activeWorkspaceId)?.name;

  return (
    <ViewScroll>
      {isLoading ? (
        <div className={cn(PAGE)}>
          <div className="flex items-center justify-center gap-2 py-24 text-[13px] text-foreground-subtle">
            <Loader2 className="size-4 animate-spin" /> 加载中…
          </div>
        </div>
      ) : (skills ?? []).length === 0 ? (
        <HeroEmpty
          title="让 Combo 掌握更多技能"
          desc="技能是一个包含 SKILL.md 的目录,描述会自动注入 agent 的系统提示词,按需扩展领域能力。"
        >
          <div className="relative z-10 mt-6 grid w-full max-w-2xl grid-cols-1 gap-4 px-4 sm:grid-cols-3">
            {SKILL_DIRS.map((d) => (
              <HeroCard key={d.label} icon={d.icon} title={d.label} desc={d.desc} />
            ))}
          </div>
          <p className="relative z-10 mt-5 max-w-md px-4 text-center text-xs leading-relaxed text-foreground-subtlest">
            把技能目录放进以上任一路径(项目级优先),重启会话后即可在这里看到。
          </p>
        </HeroEmpty>
      ) : (
        <div className={cn(PAGE, 'gap-6')}>
          <PageHeader
            title="技能"
            desc="技能描述会注入 agent 系统提示词,agent 按需取用。开关仅影响当前项目,不影响其他项目。"
          >
            <div className="flex h-9 w-56 items-center gap-2 rounded-lg border border-border bg-surface-hover px-3 transition-colors focus-within:border-ring/60 focus-within:ring-1 focus-within:ring-ring/40">
              <Search className="size-4 shrink-0 text-foreground-subtlest" />
              <input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="搜索技能…"
                className="w-full bg-transparent text-sm text-foreground outline-none placeholder:text-foreground-subtlest"
              />
            </div>
          </PageHeader>

          {filtered.length === 0 && (
            <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border px-6 py-16 text-center">
              <span className="flex size-12 items-center justify-center rounded-xl bg-surface-hover">
                <Search className="size-6 text-foreground-subtle" />
              </span>
              <p className="mt-3 text-sm font-medium text-foreground">没有匹配的技能</p>
              <p className="mt-1 text-[13px] text-foreground-subtlest">
                换个关键词,或清空筛选查看全部技能。
              </p>
            </div>
          )}

          {filtered.map((skill) => {
            const disabled = isDisabled(skill.name);
            return (
              <div
                key={skill.dir_name}
                className="group flex flex-col gap-4 rounded-xl border border-border bg-surface-hover/40 px-6 py-5 transition-colors hover:bg-surface-hover md:flex-row md:items-center md:gap-6"
              >
                <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-surface-hover">
                  <WandSparkles className={cn('size-5', disabled ? 'text-foreground-subtlest' : 'text-brand')} />
                </span>

                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-foreground">{skill.name}</span>
                    {disabled && (
                      <span className="shrink-0 rounded-full bg-foreground-subtle/10 px-2 py-0.5 text-xs font-medium text-foreground-subtle">
                        已禁用
                      </span>
                    )}
                  </div>
                  {skill.description && (
                    <p className="mt-1 line-clamp-2 text-[13px] leading-relaxed text-foreground-subtlest">
                      {skill.description}
                    </p>
                  )}
                  <code className="mt-1 block truncate font-mono text-xs text-foreground-subtlest/70">
                    {skill.path}
                  </code>
                </div>

                <span
                  className="shrink-0"
                  title={
                    activeWorkspaceId
                      ? disabled
                        ? '点击为当前项目启用'
                        : '点击为当前项目禁用'
                      : '请先选择项目'
                  }
                >
                  <Switch
                    checked={!disabled}
                    aria-label={disabled ? '启用技能' : '禁用技能'}
                    disabled={!activeWorkspaceId || toggling}
                    onCheckedChange={() => toggle({ skillName: skill.name, enable: disabled })}
                  />
                </span>
              </div>
            );
          })}

          <p className="px-1 text-[13px] text-foreground-subtlest">
            共 {skills?.length ?? 0} 个技能
            {activeWorkspaceId
              ? ` · 开关仅影响当前项目${activeWsName ? `「${activeWsName}」` : ''}`
              : ' · 请先在左侧选择项目以管理开关'}
          </p>
        </div>
      )}
    </ViewScroll>
  );
}
