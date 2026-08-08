import { useEffect, useRef, useState } from 'react';
import {
  ArrowUp,
  Brain,
  Check,
  ChevronDown,
  FileText,
  Package,
  Paperclip,
  Plus,
  Quote,
  ShieldAlert,
  Square,
  X,
} from 'lucide-react';
import { Button } from '../ui/button';
import { useAgentStore, type AgentMode } from '../../stores/agentStore';
import { useContextStore, type ContextItem } from '../../stores/contextStore';
import type { Api } from '../../lib/api/types';
import { cn } from '../../lib/utils';
import { AttachmentPicker } from './AttachmentPicker';

const MODES: { id: AgentMode; label: string; desc: string }[] = [
  { id: 'yolo', label: '完全访问', desc: '自动放行全部权限,不弹窗' },
  { id: 'edit', label: '自动编辑', desc: '自动放行写操作,其余确认' },
  { id: 'build', label: '变更前确认', desc: '所有权限均弹窗确认' },
  { id: 'plan', label: '计划模式', desc: '只读模式,不允许变更' },
];

const THOUGHT_LEVELS = [
  { id: 'nothink', label: '不思考' },
  { id: 'high', label: '高' },
  { id: 'max', label: '最高' },
] as const;

export function Composer({
  workspaceId,
  backend,
  value,
  onChange,
  onSend,
  disabled,
  running,
  onStop,
}: {
  workspaceName?: string;
  workspaceId?: string;
  backend: string;
  value: string;
  onChange: (v: string) => void;
  onSend: (attachments: Api.Attachment[], contextItems: ContextItem[]) => void;
  disabled?: boolean;
  running?: boolean;
  onStop?: () => void;
}) {
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);
  const agentMode = useAgentStore((s) => s.agentMode);
  const setAgentMode = useAgentStore((s) => s.setAgentMode);
  const mode = MODES.find((m) => m.id === agentMode) ?? MODES[0];
  const [modeMenuOpen, setModeMenuOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [attachments, setAttachments] = useState<Api.Attachment[]>([]);
  const contextItems = useContextStore((s) => s.items);
  const removeContextItem = useContextStore((s) => s.removeItem);
  const clearContextItems = useContextStore((s) => s.clear);
  const thought = THOUGHT_LEVELS[1];

  function autosize() {
    const el = areaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }

  // 外部清空 value(如发送后)时重置高度
  useEffect(() => {
    if (!value) {
      const el = areaRef.current;
      if (el) el.style.height = 'auto';
    }
  }, [value]);

  function submit() {
    if (running || disabled || (!value.trim() && attachments.length === 0 && contextItems.length === 0)) return;
    onSend(attachments, contextItems);
    setAttachments([]);
    clearContextItems();
  }

  function handlePick(files: Api.Attachment[]) {
    setAttachments((prev) => {
      const existing = new Set(prev.map((a) => a.file_path));
      const added = files.filter((f) => !existing.has(f.file_path));
      return [...prev, ...added];
    });
    setPickerOpen(false);
  }

  return (
    <div className="w-full shrink-0 px-4 pb-4 pt-2">
      <div className="mx-auto w-full max-w-2xl">
        <div className="w-full shrink-0 rounded-2xl bg-surface shadow-xl/5">
          <form
            className="relative p-0"
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <div className="relative flex flex-col gap-3 overflow-hidden rounded-2xl border border-input-border bg-input p-3 transition-colors hover:border-input-border-hover focus-within:!border-input-border-focused focus-within:bg-input-focused">
              {/* 附件 chips */}
              {(attachments.length > 0 || contextItems.length > 0) && (
                <div className="flex flex-wrap items-center gap-1.5">
                  {attachments.map((a) => (
                    <span
                      key={a.file_path}
                      className="group/att flex max-w-full min-w-0 items-center gap-1.5 rounded-lg border border-border bg-surface px-2 py-1 text-xs text-foreground"
                      title={a.file_path}
                    >
                      <Paperclip className="size-3 shrink-0 text-foreground-subtle" />
                      <span className="min-w-0 max-w-[14rem] truncate font-mono">{a.file_name}</span>
                      <button
                        type="button"
                        onClick={() =>
                          setAttachments((prev) => prev.filter((x) => x.file_path !== a.file_path))
                        }
                        className="rounded p-0.5 text-foreground-subtlest transition-colors hover:bg-surface-hover hover:text-foreground"
                        aria-label={`移除附件 ${a.file_name}`}
                      >
                        <X className="size-3" />
                      </button>
                    </span>
                  ))}
                  {contextItems.map((item) => (
                    <span
                      key={item.id}
                      className="group/ctx flex max-w-full min-w-0 items-center gap-1.5 rounded-lg border border-brand/30 bg-brand/5 px-2 py-1 text-xs text-foreground"
                      title={
                        item.type === 'snippet'
                          ? `${item.filePath}:${item.startLine ?? ''}${item.endLine && item.endLine !== item.startLine ? `-${item.endLine}` : ''}`
                          : item.filePath
                      }
                    >
                      {item.type === 'snippet' ? (
                        <Quote className="size-3 shrink-0 text-brand" />
                      ) : (
                        <FileText className="size-3 shrink-0 text-brand" />
                      )}
                      <span className="min-w-0 max-w-[12rem] truncate font-mono">
                        {item.fileName}
                        {item.startLine != null && (
                          <span className="text-foreground-subtle">
                            :{item.startLine}
                            {item.endLine != null && item.endLine !== item.startLine
                              ? `-${item.endLine}`
                              : ''}
                          </span>
                        )}
                      </span>
                      <button
                        type="button"
                        onClick={() => removeContextItem(item.id)}
                        className="rounded p-0.5 text-foreground-subtlest transition-colors hover:bg-surface-hover hover:text-foreground"
                        aria-label={`移除上下文 ${item.fileName}`}
                      >
                        <X className="size-3" />
                      </button>
                    </span>
                  ))}
                </div>
              )}
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
                  onCompositionStart={() => {
                    composingRef.current = true;
                  }}
                  onCompositionEnd={() => {
                    composingRef.current = false;
                  }}
                  onKeyDown={(e) => {
                    // keyCode 229 表示输入法正在组合中,此时回车用于确认候选词而非发送
                    if (e.key === 'Enter' && !e.shiftKey && !composingRef.current && e.keyCode !== 229) {
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
                    onClick={() => setPickerOpen(true)}
                    className="shrink-0 gap-1 rounded-lg text-foreground hover:text-foreground"
                    aria-label="添加附件"
                    title="添加附件"
                  >
                    <Plus className="size-4" />
                    <span className="sr-only">添加附件</span>
                  </Button>
                  <button
                    type="button"
                    onClick={() => setModeMenuOpen((o) => !o)}
                    className="relative flex h-7 shrink-0 items-center justify-center gap-0 rounded-lg p-0 text-warning hover:bg-surface-hover hover:text-warning"
                    aria-label="切换模式"
                    title="切换模式"
                  >
                    <ShieldAlert className="pointer-events-none size-4 text-warning" />
                    <span className="hidden whitespace-nowrap pl-1 pr-0.5 text-[13px] @xl/composer:inline-flex">
                      {mode.label}
                    </span>
                    <ChevronDown className="pointer-events-none hidden size-3.5 text-foreground-subtle" />
                  </button>
                  {modeMenuOpen && (
                    <>
                      <div
                        className="fixed inset-0 z-40"
                        onClick={() => setModeMenuOpen(false)}
                      />
                      <div className="absolute bottom-full left-0 z-50 mb-2 w-64 rounded-xl border border-border bg-popover p-1.5 shadow-xl">
                        <div className="px-2 py-1 text-xs font-medium text-foreground-subtlest">
                          Agent 模式
                        </div>
                        {MODES.map((m) => (
                          <button
                            key={m.id}
                            type="button"
                            onClick={() => {
                              setAgentMode(m.id);
                              setModeMenuOpen(false);
                            }}
                            className={cn(
                              'flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] transition-colors hover:bg-surface-hover',
                              m.id === agentMode && 'bg-surface-hover'
                            )}
                          >
                            <span className="flex min-w-0 flex-1 flex-col">
                              <span className="truncate font-medium">{m.label}</span>
                              <span className="truncate text-[11px] text-foreground-subtle">
                                {m.desc}
                              </span>
                            </span>
                            {m.id === agentMode && (
                              <Check className="size-3.5 shrink-0 text-brand" />
                            )}
                          </button>
                        ))}
                      </div>
                    </>
                  )}
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
                  {/* 发送 / 停止 */}
                  {running ? (
                    <Button
                      type="button"
                      size="icon-sm"
                      onClick={onStop}
                      className="shrink-0 gap-1 rounded-lg bg-destructive text-destructive-foreground hover:bg-destructive/90"
                      aria-label="停止"
                      title="停止"
                    >
                      <Square className="size-3.5 fill-current" />
                      <span className="sr-only">停止</span>
                    </Button>
                  ) : (
                    <Button
                      type="submit"
                      size="icon-sm"
                      disabled={(!value.trim() && attachments.length === 0 && contextItems.length === 0) || disabled}
                      className="shrink-0 gap-1 rounded-lg bg-brand text-foreground-inverse hover:bg-brand/80"
                      aria-label="发送"
                      title="发送"
                    >
                      <ArrowUp className="size-4" />
                      <span className="sr-only">发送</span>
                    </Button>
                  )}
                </div>
              </div>
            </div>
          </form>
        </div>
      </div>
      {pickerOpen && workspaceId && (
        <AttachmentPicker
          workspaceId={workspaceId}
          selected={attachments}
          onPick={handlePick}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </div>
  );
}
