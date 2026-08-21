import { useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, Search, X } from 'lucide-react';
import type { Api } from '../../lib/api/types';
import { cn } from '../../lib/utils';
import { ProviderLogo } from './ProviderLogo';
import { useAnchorPopover } from './ModelPicker';

/**
 * Provider 选择器(表单形态):与 ModelPicker 同风格的整行可搜索下拉,
 * 供「上下文窗口(手动)」等需要先选 Provider、再在其模型范围内选模型的
 * 场景使用(与 ModelPicker 的 providerFilter 搭配)。搜索按 id/名称过滤。
 * 弹层复用 useAnchorPopover 锚点定位(对话框内 transformed 祖先包含块
 * 已在 hook 内换算,下方空间不足自动翻转)。
 */
export function ProviderPicker({
  providers,
  value,
  onChange,
  placeholder = '选择 Provider',
  ariaLabel = '选择 Provider',
}: {
  /** provider 列表 */
  providers?: Api.ProviderEntry[];
  /** 当前选中的 provider id;'' = 未选择 */
  value: string;
  onChange: (providerId: string) => void;
  /** 未选中时触发器文案 */
  placeholder?: string;
  /** 触发器的无障碍标签 */
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const btnRef = useRef<HTMLButtonElement>(null);
  const popoverPos = useAnchorPopover(open, btnRef, {
    width: 288,
    enabled: true,
    placement: 'bottom',
    align: 'left',
    flip: true,
  });

  const list = useMemo(
    () =>
      (providers ?? []).map((p) => ({
        id: p.id,
        name: p.name ?? p.id,
        hasKey: p.has_api_key === true,
      })),
    [providers],
  );
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return list;
    return list.filter((p) => p.id.toLowerCase().includes(q) || p.name.toLowerCase().includes(q));
  }, [list, search]);
  const current = list.find((p) => p.id === value);

  return (
    <div className="relative w-full">
      <button
        type="button"
        ref={btnRef}
        onClick={() => setOpen(!open)}
        className="flex h-9 w-full items-center justify-between gap-2 rounded-lg border border-border bg-surface-hover px-3 text-sm text-foreground outline-none transition-colors focus:border-ring/60 focus:ring-1 focus:ring-ring/40"
        aria-label={ariaLabel}
        title="切换 Provider"
      >
        <span className="flex min-w-0 flex-1 items-center gap-2">
          {current ? (
            <ProviderLogo providerId={current.id} name={current.name} className="size-4 shrink-0" />
          ) : null}
          <span className="min-w-0 truncate">{current?.name ?? placeholder}</span>
        </span>
        <ChevronDown className="size-3.5 shrink-0 text-foreground-subtlest" />
      </button>
      {open && (
        <>
          <div className="z-40 fixed inset-0" onClick={() => setOpen(false)} />
          {/* 弹层布局与 ModelPicker 一致:标题 + 搜索框固定顶部,列表单独滚动 */}
          <div
            className={cn(
              'z-50 flex flex-col bg-popover shadow-xl p-1.5 border border-border rounded-xl w-72 max-h-80',
              'fixed',
            )}
            style={
              popoverPos
                ? popoverPos.top !== undefined
                  ? { left: popoverPos.left, top: popoverPos.top }
                  : { left: popoverPos.left, bottom: popoverPos.bottom }
                : undefined
            }
          >
            <div className="flex justify-between items-center px-2 py-1 font-medium text-foreground-subtlest text-xs">
              <span>选择 Provider</span>
              {current && (
                <span className="text-[11px] text-foreground-subtle truncate">当前: {current.name}</span>
              )}
            </div>
            <div className="px-1 pb-1">
              <div className="flex items-center gap-1.5 bg-surface px-2 py-1 border border-border rounded-lg">
                <Search className="size-3.5 text-foreground-subtlest shrink-0" />
                <input
                  autoFocus
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="搜索 Provider"
                  className="bg-transparent outline-none w-full text-[13px] text-foreground placeholder:text-foreground-subtlest"
                />
                {search && (
                  <button
                    type="button"
                    onClick={() => setSearch('')}
                    className="text-foreground-subtlest hover:text-foreground transition-colors shrink-0"
                    aria-label="清空搜索"
                  >
                    <X className="size-3.5" />
                  </button>
                )}
              </div>
            </div>
            <div data-testid="provider-menu-list" className="flex-1 min-h-0 overflow-y-auto">
              {filtered.length === 0 ? (
                <div className="px-3 py-4 text-center text-xs text-foreground-subtlest">
                  无匹配的 Provider
                </div>
              ) : (
                filtered.map((p) => {
                  const isSelected = p.id === value;
                  return (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => {
                        onChange(p.id);
                        setOpen(false);
                      }}
                      className={cn(
                        'flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] text-foreground hover:bg-surface-hover transition-colors',
                        isSelected && 'bg-surface-hover/60',
                      )}
                    >
                      <ProviderLogo providerId={p.id} name={p.name} className="size-4 shrink-0" />
                      <span className="flex-1 min-w-0 truncate">{p.name}</span>
                      {!p.hasKey && (
                        <span className="shrink-0 text-[11px] text-warning">未配置 Key</span>
                      )}
                      {isSelected && <Check className="size-3.5 text-brand shrink-0" />}
                    </button>
                  );
                })
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
