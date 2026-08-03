import { useRef } from 'react';
import {
  ArrowUp,
  Brain,
  ChevronDown,
  Folder,
  Package,
  Plus,
  ShieldAlert,
} from 'lucide-react';
import { Button } from '../ui/button';

const MODES = [
  { id: 'build', label: '变更前确认' },
  { id: 'edit', label: '自动编辑' },
  { id: 'plan', label: '计划模式' },
  { id: 'yolo', label: '完全访问' },
] as const;

const THOUGHT_LEVELS = [
  { id: 'nothink', label: '不思考' },
  { id: 'high', label: '高' },
  { id: 'max', label: '最高' },
] as const;

export function Composer({
  workspaceName,
  backend,
  value,
  onChange,
  onSend,
  disabled,
  onPickWorkspace,
}: {
  workspaceName?: string;
  backend: string;
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  disabled?: boolean;
  onPickWorkspace?: () => void;
}) {
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const mode = MODES[MODES.length - 1];
  const thought = THOUGHT_LEVELS[1];

  function autosize() {
    const el = areaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }

  function submit() {
    if (!value.trim() || disabled) return;
    onSend();
  }

  return (
    <div className="w-full shrink-0 px-4 pb-4 pt-2">
      <div className="mx-auto w-full max-w-2xl">
        <div className="w-full shrink-0 rounded-2xl bg-surface shadow-xl/5">
          {/* 当前项目 chip */}
          {workspaceName && (
            <div className="flex min-w-0 flex-wrap items-center gap-0 p-1.5">
              <div className="group/chip relative flex min-w-0 items-center rounded-full hover:bg-surface-hover focus-within:bg-surface-hover">
                <button
                  type="button"
                  onClick={onPickWorkspace}
                  className="flex h-7 min-w-0 items-center gap-1 rounded-full py-1 pl-3 pr-2 text-[13px] text-foreground transition-colors hover:text-foreground"
                  aria-label="选择项目"
                  title="选择项目"
                >
                  <Folder className="size-4 shrink-0 text-foreground-subtle" />
                  <span className="block min-w-0 max-w-[15rem] truncate">{workspaceName}</span>
                  <ChevronDown className="size-3.5 shrink-0 text-foreground-subtle" />
                </button>
              </div>
            </div>
          )}
          <form
            className="relative p-0"
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <div className="relative flex flex-col gap-3 overflow-hidden rounded-2xl border border-input-border bg-input p-3 transition-colors hover:border-input-border-hover focus-within:!border-input-border-focused focus-within:bg-input-focused">
              {/* 输入区 */}
              <div className="relative flex-1">
                <textarea
                  ref={areaRef}
                  rows={1}
                  value={value}
                  onChange={(e) => {
                    onChange(e.target.value);
                    autosize();
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      submit();
                    }
                  }}
                  placeholder="向 combo 提问,@ 提及文件或文件夹,/ 使用命令或子智能体,$ 使用技能,# 关联对话"
                  disabled={disabled}
                  className="min-h-10 w-full max-h-40 resize-none border-0 bg-transparent p-0 text-sm leading-5 text-foreground shadow-none outline-none placeholder:text-foreground-subtlest disabled:cursor-not-allowed disabled:opacity-50"
                  aria-label="输入消息"
                />
              </div>
              {/* 工具栏 */}
              <div className="flex items-end gap-3">
                <div className="flex min-w-0 flex-1 items-center gap-1">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="shrink-0 gap-1 rounded-lg text-foreground hover:text-foreground"
                    aria-label="添加上下文"
                    title="添加上下文"
                  >
                    <Plus className="size-4" />
                    <span className="sr-only">添加上下文</span>
                  </Button>
                  <button
                    type="button"
                    className="flex h-7 shrink-0 items-center justify-center gap-0 rounded-lg p-0 text-warning hover:bg-surface-hover hover:text-warning"
                    aria-label="切换模式"
                    title="切换模式"
                  >
                    <ShieldAlert className="pointer-events-none size-4 text-warning" />
                    <span className="hidden whitespace-nowrap pl-1 pr-0.5 text-[13px] @xl/composer:inline-flex">
                      {mode.label}
                    </span>
                    <ChevronDown className="pointer-events-none hidden size-3.5 text-foreground-subtle" />
                  </button>
                </div>
                <div className="flex items-center gap-1.5">
                  {/* 用量圆环 */}
                  <span
                    className="flex shrink-0 items-center justify-center"
                    aria-label="剩余额度"
                    title="剩余额度"
                  >
                    <svg aria-hidden className="size-3.5" viewBox="0 0 24 24" style={{ color: 'currentcolor' }}>
                      <circle
                        cx="12"
                        cy="12"
                        fill="none"
                        opacity="0.25"
                        r="10"
                        stroke="currentColor"
                        strokeWidth="4"
                      />
                      <circle
                        cx="12"
                        cy="12"
                        fill="none"
                        opacity="0.7"
                        r="10"
                        stroke="currentColor"
                        strokeDasharray="62.83185307179586 62.83185307179586"
                        strokeDashoffset="62.83185307179586"
                        strokeLinecap="round"
                        strokeWidth="4"
                        style={{ transform: 'rotate(-90deg)', transformOrigin: 'center center' }}
                      />
                    </svg>
                  </span>
                  {/* 模型(由工作区后端决定) */}
                  <span
                    className="flex h-7 shrink-0 w-fit items-center justify-between gap-1 rounded-lg px-2 pr-1.5 text-[13px] whitespace-nowrap text-foreground-subtle"
                    title={`后端:${backend}`}
                  >
                    <Package className="pointer-events-none size-4 shrink-0" />
                    <span className="min-w-0 truncate">{backend}</span>
                    <ChevronDown className="pointer-events-none size-3.5 text-foreground-subtlest" />
                  </span>
                  {/* 思考等级 */}
                  <span
                    className="flex h-7 shrink-0 w-fit items-center justify-between gap-1 rounded-lg px-1.5 py-1.5 text-[13px] whitespace-nowrap text-foreground-subtle"
                    title="思考等级"
                  >
                    <Brain className="pointer-events-none size-4 text-current" />
                    <span className="whitespace-nowrap">{thought.label}</span>
                    <ChevronDown className="pointer-events-none size-3.5 text-foreground-subtlest" />
                  </span>
                  {/* 发送 */}
                  <Button
                    type="submit"
                    size="icon-sm"
                    disabled={!value.trim() || disabled}
                    className="shrink-0 gap-1 rounded-lg bg-brand text-foreground-inverse hover:bg-brand/80"
                    aria-label="发送"
                    title="发送"
                  >
                    <ArrowUp className="size-4" />
                    <span className="sr-only">发送</span>
                  </Button>
                </div>
              </div>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
