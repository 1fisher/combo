import { useEffect, useRef, useState } from 'react';
import {
  BarChart3,
  Boxes,
  CalendarClock,
  FileCode2,
  Keyboard,
  MessageCirclePlus,
  Mic,
  RotateCcw,
  Search,
  Waypoints,
  WandSparkles,
  type LucideIcon,
} from 'lucide-react';
import { Button } from '../ui/button';
import { cn } from '../../lib/utils';
import {
  SHORTCUT_ACTIONS,
  comboToParts,
  eventToCombo,
  findBindingOwner,
  isModifierKey,
  shortcutAction,
  FIXED_SHORTCUTS,
  type ShortcutAction,
} from '../../lib/shortcuts';
import { useShortcutStore } from '../../stores/shortcutStore';
import { PAGE, PageHeader, ViewScroll } from './PageShell';

/** 动作图标(与侧边栏导航一致,便于识别) */
const ACTION_ICONS: Record<ShortcutAction, LucideIcon> = {
  newTask: MessageCirclePlus,
  'view:search': Search,
  'view:automation': CalendarClock,
  'view:skills': WandSparkles,
  'view:mcp': Boxes,
  'view:lsp': FileCode2,
  'view:stats': BarChart3,
  'view:graph': Waypoints,
  dictation: Mic,
};

function Kbd({ k }: { k: string }) {
  return (
    <kbd className="rounded border border-border bg-surface px-1.5 py-0.5 font-sans text-[11px] leading-none text-foreground-subtle">
      {k}
    </kbd>
  );
}

/** 单条可配置动作行:名称 + 说明 + 快捷键按钮(点击进入录制) */
function ShortcutRow({
  id,
  recording,
  conflict,
  onRecord,
}: {
  id: ShortcutAction;
  recording: boolean;
  /** 行内冲突/校验错误文案 */
  conflict: string | null;
  onRecord: (id: ShortcutAction | null) => void;
}) {
  const meta = shortcutAction(id);
  const bindings = useShortcutStore((s) => s.bindings);
  const parts = comboToParts(bindings[id]);
  const Icon = ACTION_ICONS[id];

  return (
    <div
      className={cn(
        'flex items-center gap-3 rounded-lg border border-transparent px-3 py-2.5 transition-colors hover:border-border/60 hover:bg-surface-hover/40',
        recording && 'border-ring/50 bg-surface-hover/60',
        conflict && 'border-destructive/40',
      )}
    >
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-surface-hover text-foreground-subtle">
        <Icon className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium text-foreground">{meta.label}</div>
        <div className="text-xs leading-snug text-foreground-subtle">{meta.desc}</div>
        {conflict && (
          <div className="mt-1 text-xs text-destructive" data-testid="shortcut-conflict">
            {conflict}
          </div>
        )}
      </div>
      <button
        type="button"
        aria-label={`修改「${meta.label}」快捷键`}
        title={
          recording
            ? '按下新组合;Esc 取消,Backspace 清除'
            : '点击修改;录制中 Esc 取消、Backspace 清除(禁用)'
        }
        onClick={(e) => {
          e.stopPropagation();
          onRecord(recording ? null : id);
        }}
        data-testid={`shortcut-binding-${id}`}
        className={cn(
          'flex h-8 min-w-[88px] shrink-0 items-center justify-center gap-1 rounded-lg border border-border bg-surface px-2.5 text-[12px] text-foreground-subtle transition-colors hover:border-ring/50 hover:text-foreground',
          recording && 'animate-pulse border-ring/60 text-foreground',
        )}
      >
        {recording ? (
          <span className="text-foreground-subtle">按下新组合…</span>
        ) : parts.length ? (
          parts.map((k) => <Kbd key={k} k={k} />)
        ) : (
          <span className="text-foreground-subtlest">已禁用</span>
        )}
      </button>
    </div>
  );
}

export function ShortcutsView() {
  const bindings = useShortcutStore((s) => s.bindings);
  const resetAll = useShortcutStore((s) => s.resetAll);
  /** 正在录制的动作 id */
  const [recordingId, setRecordingId] = useState<ShortcutAction | null>(null);
  /** 录制错误提示(冲突/非法组合),挂在对应行下 */
  const [conflicts, setConflicts] = useState<Partial<Record<ShortcutAction, string>>>({});
  // 最新值的 ref:录制监听挂一次即可,避免每次 bindings 变化重绑
  const bindingsRef = useRef(bindings);
  bindingsRef.current = bindings;
  const setBindingRef = useRef(useShortcutStore.getState().setBinding);

  // 录制:window 捕获阶段监听,抢先于 sidebar/Composer 等全局快捷键
  useEffect(() => {
    const id = recordingId;
    if (!id) return;
    // 箭头函数(不提升)以保留上方对 id 的收窄
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') {
        setRecordingId(null);
        setConflicts({});
        return;
      }
      if (e.key === 'Backspace' || e.key === 'Delete') {
        // 清除绑定 = 禁用该动作的快捷键
        setBindingRef.current(id, null);
        setRecordingId(null);
        setConflicts({});
        return;
      }
      if (isModifierKey(e.key)) return; // 等待完整组合
      const combo = eventToCombo(e);
      if (!combo) {
        setConflicts((c) => ({
          ...c,
          [id]: '仅支持 ⌘/Ctrl(可加 Shift)的组合,且不能含 ⌥',
        }));
        return;
      }
      const owner = findBindingOwner(bindingsRef.current, combo, id);
      if (owner) {
        setConflicts((c) => ({
          ...c,
          [id]: `与「${shortcutAction(owner).label}」冲突,请换一个组合`,
        }));
        return;
      }
      setBindingRef.current(id, combo);
      setRecordingId(null);
      setConflicts({});
    };
    // 捕获阶段 + preventDefault:sidebar/Composer 的分派管线会因 defaultPrevented 让位
    window.addEventListener('keydown', onKey, true);
    const onBlur = () => setRecordingId(null);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', onBlur);
    };
  }, [recordingId]);

  const hasCustom =
    SHORTCUT_ACTIONS.some((a) => bindings[a.id] !== a.defaultCombo) ||
    Object.keys(conflicts).length > 0;

  return (
    <ViewScroll>
      <div className={PAGE} data-testid="shortcuts-view">
        <PageHeader title="快捷键" desc="自定义全局功能的快捷键组合;点击右侧键位即可重新录制。配置保存在本地,跨重启保留。">
          <Button
            variant="outline"
            size="sm"
            disabled={!hasCustom || recordingId != null}
            onClick={() => {
              resetAll();
              setConflicts({});
            }}
          >
            <RotateCcw className="size-3.5" />
            恢复默认
          </Button>
        </PageHeader>

        {/* 全局(可配置) */}
        <section className="mt-8" aria-label="全局快捷键">
          <h3 className="mb-2 text-[13px] font-medium text-foreground-subtle">
            全局操作
            <span className="ml-2 font-normal text-foreground-subtlest">
              录制中按 Esc 取消、Backspace 清除(禁用)
            </span>
          </h3>
          <div className="flex flex-col gap-1" data-testid="shortcut-list">
            {SHORTCUT_ACTIONS.map((a) => (
              <ShortcutRow
                key={a.id}
                id={a.id}
                recording={recordingId === a.id}
                conflict={conflicts[a.id] ?? null}
                onRecord={setRecordingId}
              />
            ))}
          </div>
        </section>

        {/* 上下文(固定) */}
        <section className="mt-8 pb-4" aria-label="上下文快捷键">
          <h3 className="mb-2 text-[13px] font-medium text-foreground-subtle">
            输入与编辑器
            <span className="ml-2 font-normal text-foreground-subtlest">作用域限定的固定快捷键,暂不支持配置</span>
          </h3>
          <div className="flex flex-col gap-1 rounded-lg border border-border/60 bg-surface-hover/30 p-2">
            {FIXED_SHORTCUTS.map((s) => (
              <div
                key={s.label}
                className="flex items-center justify-between rounded-lg px-3 py-1.5"
              >
                <span className="text-[13px] text-foreground">{s.label}</span>
                <span className="flex items-center gap-1">
                  {s.keys.map((k) => (
                    <Kbd key={k} k={k} />
                  ))}
                </span>
              </div>
            ))}
          </div>
          <p className="mt-3 flex items-center gap-1.5 text-xs text-foreground-subtlest">
            <Keyboard className="size-3.5" />
            ⌘ 在 Windows/Linux 上为 Ctrl。
          </p>
        </section>
      </div>
    </ViewScroll>
  );
}
