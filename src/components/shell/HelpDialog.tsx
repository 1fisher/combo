import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';

interface HelpDialogProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}

const SHORTCUTS: { keys: string[]; label: string }[] = [
  { keys: ['⌘', 'N'], label: '新建任务' },
  { keys: ['⌘', 'K'], label: '搜索项目或任务' },
  { keys: ['⌘', 'A'], label: '自动化' },
  { keys: ['⌘', '⇧', 'S'], label: '技能' },
  { keys: ['⌘', '⇧', 'M'], label: 'MCP 工具' },
  { keys: ['⌘', '⇧', 'D'], label: '统计' },
  { keys: ['⌘', '⇧', 'G'], label: '知识图谱' },
  { keys: ['Enter'], label: '发送消息' },
  { keys: ['Shift', 'Enter'], label: '消息内换行' },
  { keys: ['⌘', 'I'], label: '语音输入' },
  { keys: ['⌘', 'F'], label: '文件内搜索(编辑器视图)' },
  { keys: ['⌘', '⇧', 'F'], label: '跨文件内容搜索(编辑器视图)' },
  { keys: ['⌘', 'W'], label: '关闭当前文件(编辑器视图)' },
  { keys: ['⌘', 'S'], label: '保存当前文件(编辑器视图)' },
  { keys: ['⌘', '⌥', '←/→'], label: '切换打开的文件(编辑器视图)' },
];

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
    icon: '$',
    title: '使用技能',
    desc: '输入 $ 可快速调用已安装的技能',
  },
  {
    icon: '#',
    title: '关联对话',
    desc: '输入 # 可关联其他对话作为参考',
  },
];

export function HelpDialog({ open, onOpenChange }: HelpDialogProps) {
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
            </h3>
            <div className="flex flex-col gap-1.5">
              {SHORTCUTS.map((s) => (
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
