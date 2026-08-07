import { CalendarClock, Clock, Sparkles, Zap } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '../ui/dialog';
import { Button } from '../ui/button';

interface AutomationPanelProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}

const FEATURES = [
  {
    icon: Zap,
    title: '闲时任务',
    desc: '在算力富余时段自动完成指派的任务,无需值守。',
  },
  {
    icon: Clock,
    title: '定时执行',
    desc: '设定时间自动运行,如每周五生成站会摘要。',
  },
  {
    icon: Sparkles,
    title: 'CI 监控',
    desc: '自动汇总 CI 失败和不稳定测试,并分析可能原因。',
  },
];

export function AutomationPanel({ open, onOpenChange }: AutomationPanelProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-[16px]">
            <CalendarClock className="size-4 text-brand" />
            自动化
          </DialogTitle>
          <DialogDescription className="text-[13px]">
            设置自动化任务,让 combo 在指定时间或闲时自动完成工作。
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-2.5">
          {FEATURES.map((f) => (
            <div
              key={f.title}
              className="flex items-start gap-3 rounded-xl border border-border bg-surface-hover/40 px-3 py-2.5"
            >
              <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-surface-hover">
                <f.icon className="size-4 text-brand" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-medium text-foreground">{f.title}</div>
                <div className="mt-0.5 text-[12px] leading-relaxed text-foreground-subtle">
                  {f.desc}
                </div>
              </div>
            </div>
          ))}
        </div>

        <div className="rounded-lg border border-dashed border-border px-3 py-3 text-center text-[12px] text-foreground-subtlest">
          自动化功能即将推出,敬请期待
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            关闭
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
