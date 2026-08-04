import { useState } from 'react';
import { Search, WandSparkles } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import { useSkills, useWorkspaceDisabledSkills } from '../../hooks/useSkills';
import { useAgentStore } from '../../stores/agentStore';
import { cn } from '../../lib/utils';

export function SkillsPanel({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const { data: skills, isLoading } = useSkills();
  const activeWorkspaceId = useAgentStore((s) => s.activeWorkspaceId);
  const { isDisabled, toggle, toggling } = useWorkspaceDisabledSkills(
    activeWorkspaceId
  );
  const [filter, setFilter] = useState('');

  const filtered = (skills ?? []).filter(
    (s) =>
      s.name.toLowerCase().includes(filter.toLowerCase()) ||
      s.description.toLowerCase().includes(filter.toLowerCase())
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[80vh] flex-col gap-0 p-0 sm:max-w-lg">
        <DialogHeader className="border-b px-4 py-3">
          <DialogTitle className="flex items-center gap-2 text-[15px]">
            <WandSparkles className="size-4 text-brand" />
            技能管理
          </DialogTitle>
        </DialogHeader>

        {/* 搜索栏 */}
        <div className="border-b px-4 py-2">
          <div className="flex items-center gap-2 rounded-lg bg-surface-hover px-2.5 py-1.5">
            <Search className="size-3.5 shrink-0 text-foreground-subtlest" />
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="搜索技能…"
              className="w-full bg-transparent text-[13px] outline-none placeholder:text-foreground-subtlest"
            />
          </div>
        </div>

        {/* 技能列表 */}
        <div className="flex-1 overflow-y-auto px-2 py-2">
          {isLoading && (
            <div className="px-2.5 py-4 text-center text-[13px] text-foreground-subtle">
              加载中…
            </div>
          )}
          {!isLoading && filtered.length === 0 && (
            <div className="px-2.5 py-4 text-center text-[13px] text-foreground-subtle">
              {skills?.length === 0
                ? '未安装任何技能。技能目录: ~/.config/crush/skills/'
                : '没有匹配的技能'}
            </div>
          )}
          {filtered.map((skill) => {
            const disabled = isDisabled(skill.name);
            return (
              <div
                key={skill.dir_name}
                className="group flex items-start gap-3 rounded-lg px-2.5 py-2 transition-colors hover:bg-surface-hover"
              >
                <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-surface-hover">
                  <WandSparkles className="size-4 text-foreground-subtle" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-medium text-foreground">
                    {skill.name}
                  </div>
                  {skill.description && (
                    <div className="mt-0.5 line-clamp-2 text-[12px] leading-relaxed text-foreground-subtle">
                      {skill.description}
                    </div>
                  )}
                </div>
                {/* 开关 */}
                <button
                  type="button"
                  disabled={
                    !activeWorkspaceId || toggling
                  }
                  onClick={() =>
                    toggle({ skillName: skill.name, enable: disabled })
                  }
                  className={cn(
                    'relative mt-0.5 inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors',
                    disabled
                      ? 'bg-border'
                      : 'bg-brand',
                    (!activeWorkspaceId || toggling) && 'opacity-50'
                  )}
                  title={
                    activeWorkspaceId
                      ? disabled
                        ? '点击启用'
                        : '点击禁用'
                      : '请先选择项目'
                  }
                >
                  <span
                    className={cn(
                      'inline-block size-4 transform rounded-full bg-white shadow transition-transform',
                      disabled ? 'translate-x-0.5' : 'translate-x-4'
                    )}
                  />
                </button>
              </div>
            );
          })}
        </div>

        {/* 底部状态 */}
        <div className="border-t px-4 py-2 text-[12px] text-foreground-subtlest">
          共 {skills?.length ?? 0} 个技能
          {activeWorkspaceId
            ? ' · 开关仅影响当前项目'
            : ' · 请先选择项目以管理开关'}
        </div>
      </DialogContent>
    </Dialog>
  );
}
