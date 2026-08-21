import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import {
  SHORTCUT_ACTIONS,
  comboToParts,
  FIXED_SHORTCUTS,
} from '../../lib/shortcuts';
import { useShortcutStore } from '../../stores/shortcutStore';

interface HelpDialogProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}

const TIPS: { icon: string; title: string; desc: string }[] = [
  {
    icon: '@',
    title: '提及文件',
    desc: '在输入框输入 @ 可提及文件或文件夹作为上下文',
  },
  {
    icon: '/',
    title: '使用命令',
    desc: '输入 / 可调用命令或子智能体',
  },
  {
    icon: '%',
    title: '使用技能',
    desc: '输入 % 可快速调用已安装的技能',
  },
  {
    icon: '#',
    title: '关联对话',
    desc: '输入 # 可关联其他对话作为参考',
  },
];

export function HelpDialog({ open, onOpenChange }: HelpDialogProps) {
  // 可配置部分实时跟随快捷键设置(管理入口:侧边栏底部「快捷键管理」)
  const bindings = useShortcutStore((s) => s.bindings);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>帮助</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-5">
          {/* 快捷键 */}
          <div>
            <h3 className="mb-2 text-[13px] font-medium text-foreground-subtle">
              快捷键
              <span className="ml-1.5 text-xs font-normal text-foreground-subtlest">
                (可在侧边栏底部「快捷键管理」中自定义)
              </span>
            </h3>
            <div className="flex flex-col gap-1.5">
              {SHORTCUT_ACTIONS.map((a) => (
                <div
                  key={a.id}
                  className="flex items-center justify-between rounded-lg px-1 py-1"
                >
                  <span className="text-[13px] text-foreground">{a.label}</span>
                  <span className="flex items-center gap-1">
                    {comboToParts(bindings[a.id]).map((k) => (
                      <kbd
                        key={k}
                        className="rounded border border-border bg-surface px-1.5 py-0.5 text-[11px] text-foreground-subtle"
                      >
                        {k}
                      </kbd>
                    ))}
                    {bindings[a.id] == null && (
                      <span className="text-[11px] text-foreground-subtlest">已禁用</span>
                    )}
                  </span>
                </div>
              ))}
              {FIXED_SHORTCUTS.map((s) => (
                <div
                  key={s.label}
                  className="flex items-center justify-between rounded-lg px-1 py-1"
                >
                  <span className="text-[13px] text-foreground">{s.label}</span>
                  <span className="flex items-center gap-1">
                    {s.keys.map((k) => (
                      <kbd
                        key={k}
                        className="rounded border border-border bg-surface px-1.5 py-0.5 text-[11px] text-foreground-subtle"
                      >
                        {k}
                      </kbd>
                    ))}
                  </span>
                </div>
              ))}
            </div>
          </div>
          {/* 使用技巧 */}
          <div>
            <h3 className="mb-2 text-[13px] font-medium text-foreground-subtle">
              输入技巧
            </h3>
            <div className="flex flex-col gap-2">
              {TIPS.map((t) => (
                <div key={t.title} className="flex items-start gap-2.5">
                  <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-surface-hover font-mono text-[13px] text-brand">
                    {t.icon}
                  </span>
                  <div className="min-w-0">
                    <div className="text-[13px] font-medium text-foreground">
                      {t.title}
                    </div>
                    <div className="text-[12px] leading-relaxed text-foreground-subtle">
                      {t.desc}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
