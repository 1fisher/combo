import { useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { Check, ChevronDown, Cpu, History, Loader2, Search, X } from 'lucide-react';
import { useAgentStore } from '../../stores/agentStore';
import { useIsMobile } from '../../hooks/useIsMobile';
import type { Api } from '../../lib/api/types';
import { cn } from '../../lib/utils';
import { ProviderLogo } from './ProviderLogo';

/**
 * 弹层锚点定位(移动端适配):fixed 弹层相对锚点元素定位,水平方向钳制在视口内
 * (左右各留 8px),避免 w-72 等较宽下拉在窄屏向左溢出被裁剪(如 Composer 模型菜单
 * 移动端偏左显示不全);垂直方向贴合锚点上方/下方 8px(placement)。桌面端不启用,
 * 沿用 absolute 定位。默认右对齐锚点右边缘(与 right-0 语义一致),align='left'
 * 时左对齐锚点左边缘,空间不足时钳制进视口。
 */
export function useAnchorPopover(
  open: boolean,
  anchorRef: RefObject<HTMLElement | null>,
  opts: {
    width: number;
    enabled: boolean;
    placement?: 'top' | 'bottom';
    align?: 'right' | 'left';
    /** 垂直空间不足时自动翻转到另一侧(表单场景:下方放不下则弹到上方)。 */
    flip?: boolean;
  }
): { left: number; top?: number; bottom?: number } | null {
  const [pos, setPos] = useState<{ left: number; top?: number; bottom?: number } | null>(null);
  useLayoutEffect(() => {
    if (!open || !opts.enabled) {
      setPos(null);
      return;
    }
    const el = anchorRef.current;
    if (!el) return;
    function update() {
      const anchor = anchorRef.current;
      if (!anchor) return;
      const rect = anchor.getBoundingClientRect();
      const vw = window.innerWidth;
      const rawLeft = opts.align === 'left' ? rect.left : rect.right - opts.width;
      const left = Math.min(Math.max(rawLeft, 8), Math.max(8, vw - opts.width - 8));
      // 弹层按 max-h-80(320px)+ 边距预留 ~356px;下方放不下且开启 flip 时翻到上方
      const openUp =
        opts.placement === 'top' || (opts.flip === true && window.innerHeight - rect.bottom < 356);
      const pos = openUp
        ? { left, bottom: window.innerHeight - rect.top + 8 }
        : { left, top: rect.bottom + 8 };
      setPos(pos);
    }
    update();
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [open, anchorRef, opts.width, opts.enabled, opts.placement, opts.align, opts.flip]);
  return pos;
}

/** 当前选中模型(provider + model 同时非空才算有效选中)。 */
export interface ModelSelection {
  provider: string;
  model: string;
}

/**
 * 模型选择器:从 Composer 抽取的共用 UI,搜索 + 最近使用 + 按 provider 分组,
 * 可跨 provider 直接选模型。两种形态:
 * - variant='composer':输入坞工具栏上的紧凑按钮(logo + 模型名 + 下拉箭头),弹层向上;
 * - variant='form':表单里的整行选择器(与表单输入框同高同宽),弹层向下。
 * 选中后自动记入全局「最近使用」(agentStore 持久化);表单场景传 onClear
 * 可在菜单顶部显示「跟随默认」清除项。
 */
export function ModelPicker({
  providers,
  selected,
  onSelect,
  onClear,
  clearLabel = '跟随项目默认',
  variant = 'composer',
  placement,
  open: openProp,
  onOpenChange,
  pending = false,
  warn = false,
  placeholder,
}: {
  /** provider 列表(含 models);未加载时触发器仍可展示已保存的选中值 */
  providers?: Api.ProviderEntry[];
  /** 当前选中;null = 未单独指定(跟随默认) */
  selected: ModelSelection | null;
  /** 选中某个模型(provider + model) */
  onSelect: (provider: string, model: string) => void;
  /** 传入后菜单顶部出现「跟随默认」清除项(表单场景) */
  onClear?: () => void;
  /** 清除项文案 */
  clearLabel?: string;
  /** 触发器形态:'composer' 输入坞紧凑按钮 / 'form' 表单整行选择器 */
  variant?: 'composer' | 'form';
  /** 弹层垂直位置;缺省按形态取(composer 向上 / form 向下) */
  placement?: 'top' | 'bottom';
  /** 受控打开态(需与其它菜单互斥时使用);不传则组件自管 */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** composer 触发器:切换请求进行中转圈 */
  pending?: boolean;
  /** composer 触发器:当前 provider 缺 API Key 时告警色 */
  warn?: boolean;
  /** 未选中时 composer 触发器文案(默认「默认模型」) */
  placeholder?: string;
}) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const isOpen = openProp ?? uncontrolledOpen;
  const [search, setSearch] = useState('');
  const btnRef = useRef<HTMLButtonElement>(null);
  // 移动端(<768px)弹层用 fixed 定位并钳制在视口内,避免宽菜单溢出裁剪;
  // 表单形态桌面端也用锚点 fixed 定位(表单所在的滚动容器 overflow-y-auto,
  // absolute 弹层会被容器底缘裁剪),并在下方空间不足时翻转到锚点上方
  const isMobile = useIsMobile();
  const effPlacement = placement ?? (variant === 'form' ? 'bottom' : 'top');
  const anchored = variant === 'form' || isMobile;
  const popoverPos = useAnchorPopover(isOpen, btnRef, {
    width: 288,
    enabled: anchored,
    placement: effPlacement,
    align: variant === 'form' ? 'left' : 'right',
    flip: variant === 'form',
  });
  // 最近使用的模型(全局记录,持久化),用于菜单顶部快速切换
  const recentModels = useAgentStore((s) => s.recentModels);

  function setOpen(v: boolean) {
    // 每次打开重置搜索,避免上次的关键词残留
    if (v) setSearch('');
    onOpenChange?.(v);
    if (openProp === undefined) setUncontrolledOpen(v);
  }

  // 扁平化 provider → model 列表
  const modelList = useMemo(() => {
    if (!providers) return [];
    const out: {
      id: string;
      name: string;
      provider: string;
      providerName: string;
      contextWindow?: number;
    }[] = [];
    for (const p of providers) {
      const pName = p.name ?? p.id;
      const models = Array.isArray(p.models) ? p.models : [];
      for (const m of models) {
        out.push({
          id: m.id ?? '',
          name: m.name ?? m.id ?? '',
          provider: p.id,
          providerName: pName,
          contextWindow: typeof m.context_window === 'number' ? m.context_window : undefined,
        });
      }
    }
    // 按模型编号从大到小排序(如 glm-5.2 排在 glm-5 前面,无编号的排最后)
    const versionOf = (s: string): number => {
      const m = /\d+(?:\.\d+)*/.exec(s);
      return m ? parseFloat(m[0]) : -1;
    };
    const modelVersion = (m: { id: string; name: string }): number => {
      const v = versionOf(m.id);
      return v >= 0 ? v : versionOf(m.name);
    };
    return out.sort((a, b) => modelVersion(b) - modelVersion(a));
  }, [providers]);

  // 全部 provider 的模型,按 provider 分组(可跨 provider 直接选模型)
  const modelGroups = useMemo(() => {
    const out: {
      providerId: string;
      providerName: string;
      models: { id: string; name: string }[];
    }[] = [];
    for (const m of modelList) {
      let g = out.find((x) => x.providerId === m.provider);
      if (!g) {
        g = { providerId: m.provider, providerName: m.providerName, models: [] };
        out.push(g);
      }
      g.models.push({ id: m.id, name: m.name });
    }
    return out;
  }, [modelList]);

  // 模型搜索:按模型 id/名称(忽略大小写)过滤,命中后分组内保持原有排序,空组剔除
  const filteredModelGroups = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return modelGroups;
    const out: typeof modelGroups = [];
    for (const g of modelGroups) {
      const models = g.models.filter(
        (m) => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q)
      );
      if (models.length) out.push({ ...g, models });
    }
    return out;
  }, [modelGroups, search]);

  // 最近使用的模型:解析回当前 provider 列表中的条目(已下线的模型不再展示),
  // 同样受搜索过滤,置顶展示方便在常用模型间快速切换
  const recentModelEntries = useMemo(() => {
    const q = search.trim().toLowerCase();
    const out: { id: string; name: string; providerId: string; providerName: string }[] = [];
    for (const r of recentModels) {
      const hit = modelList.find((m) => m.id === r.model && m.provider === r.provider);
      if (!hit) continue;
      if (q && !hit.id.toLowerCase().includes(q) && !hit.name.toLowerCase().includes(q)) continue;
      out.push({
        id: hit.id,
        name: hit.name,
        providerId: hit.provider,
        providerName: hit.providerName,
      });
    }
    return out;
  }, [recentModels, modelList, search]);

  const selectedProvider = useMemo(
    () => providers?.find((p) => p.id === selected?.provider),
    [providers, selected]
  );
  // 选中的模型在当前列表中的条目(provider 已删除等情况下可能不存在,
  // 此时仍展示已保存的 id,便于用户察觉并更换)
  const selectedEntry = useMemo(
    () => (selected ? modelList.find((m) => m.id === selected.model && m.provider === selected.provider) : undefined),
    [modelList, selected]
  );

  function handleSelect(provider: string, model: string) {
    setOpen(false);
    // 记录最近使用,菜单顶部置顶展示
    useAgentStore.getState().pushRecentModel({ model, provider });
    onSelect(provider, model);
  }

  // 触发器文案:composer 显示模型 id;form 显示「模型名 · provider」或「跟随项目默认」
  const triggerLabel =
    variant === 'form'
      ? selected
        ? selectedEntry
          ? selectedEntry.name || selectedEntry.id
          : selected.model
        : clearLabel
      : selected?.model || placeholder || '默认模型';

  return (
    <div className={variant === 'form' ? 'relative w-full' : 'relative shrink-0'}>
      {variant === 'composer' ? (
        <button
          type="button"
          ref={btnRef}
          onClick={() => setOpen(!isOpen)}
          className={cn(
            'flex justify-between items-center gap-1 hover:bg-surface-hover px-1.5 py-1.5 rounded-lg w-fit h-7 text-[13px] whitespace-nowrap transition-colors',
            warn ? 'text-warning hover:text-warning' : 'text-foreground-subtle hover:text-foreground'
          )}
          aria-label="切换模型"
          title="切换模型"
        >
          {pending ? (
            <Loader2 className="size-4 animate-spin pointer-events-none" />
          ) : (
            <ProviderLogo
              providerId={selected?.provider}
              name={selectedProvider?.name}
              className="size-4 pointer-events-none shrink-0"
            />
          )}
          <span className="min-w-0 max-w-[8rem] truncate">{triggerLabel}</span>
          <ChevronDown className="size-3.5 text-foreground-subtlest pointer-events-none" />
        </button>
      ) : (
        <button
          type="button"
          ref={btnRef}
          onClick={() => setOpen(!isOpen)}
          className="flex h-9 w-full items-center justify-between gap-2 rounded-lg border border-border bg-surface-hover px-3 text-sm text-foreground outline-none transition-colors focus:border-ring/60 focus:ring-1 focus:ring-ring/40"
          aria-label="切换模型"
          title="切换模型"
        >
          <span className="flex min-w-0 flex-1 items-center gap-2">
            {selected ? (
              <ProviderLogo
                providerId={selected.provider}
                name={selectedProvider?.name}
                className="size-4 shrink-0"
              />
            ) : (
              <Cpu className="size-4 shrink-0 text-foreground-subtlest" />
            )}
            <span className="min-w-0 truncate">{triggerLabel}</span>
            {selected && (
              <span className="max-w-32 shrink-0 truncate text-xs text-foreground-subtlest">
                {selectedEntry?.providerName ?? selected.provider}
              </span>
            )}
          </span>
          <ChevronDown className="size-3.5 shrink-0 text-foreground-subtlest" />
        </button>
      )}
      {isOpen && (
        <>
          <div className="z-40 fixed inset-0" onClick={() => setOpen(false)} />
          {/* 弹层为 flex 纵向布局:标题 + 搜索框固定顶部,模型列表单独滚动,
              列表滚动时搜索框保持可见 */}
          <div
            className={cn(
              'z-50 flex flex-col bg-popover shadow-xl p-1.5 border border-border rounded-xl w-72 max-h-80',
              anchored
                ? 'fixed'
                : effPlacement === 'bottom'
                  ? 'left-0 top-full absolute mt-2'
                  : 'right-0 bottom-full absolute mb-2'
            )}
            style={
              anchored && popoverPos
                ? popoverPos.top !== undefined
                  ? { left: popoverPos.left, top: popoverPos.top }
                  : { left: popoverPos.left, bottom: popoverPos.bottom }
                : undefined
            }
          >
            <div className="flex justify-between items-center px-2 py-1 font-medium text-foreground-subtlest text-xs">
              <span>选择模型</span>
              {selected?.model && (
                <span className="text-[11px] text-foreground-subtle truncate">
                  当前: {selected.model}
                </span>
              )}
            </div>
            <div className="px-1 pb-1">
              <div className="flex items-center gap-1.5 bg-surface px-2 py-1 border border-border rounded-lg">
                <Search className="size-3.5 text-foreground-subtlest shrink-0" />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="搜索模型"
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
            <div data-testid="model-menu-list" className="flex-1 min-h-0 overflow-y-auto">
              {/* 「跟随默认」清除项:表单场景可选,未单独指定模型时选中态落在这里 */}
              {onClear && (
                <div className="pb-1">
                  <button
                    type="button"
                    onClick={() => {
                      setOpen(false);
                      onClear();
                    }}
                    className={cn(
                      'flex items-center gap-2 hover:bg-surface-hover px-2 py-1.5 rounded-lg w-full text-[13px] text-left transition-colors',
                      !selected && 'bg-surface-hover'
                    )}
                  >
                    <Cpu className="size-3.5 text-foreground-subtlest shrink-0" />
                    <span className="flex-1 min-w-0 font-medium truncate">{clearLabel}</span>
                    {!selected && <Check className="size-3.5 text-brand shrink-0" />}
                  </button>
                  <div className="mx-2 mt-1 border-border border-t" />
                </div>
              )}
              {/* 最近使用的模型置顶,方便在常用模型间快速切换 */}
              {recentModelEntries.length > 0 && (
                <div className="pb-1">
                  <div className="flex items-center gap-1.5 px-2 pt-1 pb-0.5 font-medium text-[11px] text-foreground-subtlest">
                    <History className="size-3" />
                    <span>最近使用</span>
                  </div>
                  {recentModelEntries.map((m) => {
                    const isSelected =
                      !!selected && m.id === selected.model && m.providerId === selected.provider;
                    return (
                      // 行容器:主体是「切换模型」按钮,右侧附「从最近使用移除」按钮。
                      // 删除按钮悬停行时显示(触屏无 hover,保持常驻),点击不关闭菜单可连续删除
                      <div
                        key={`recent-${m.providerId}/${m.id}`}
                        className={cn(
                          'group/recent flex items-center gap-1 hover:bg-surface-hover rounded-lg transition-colors',
                          isSelected && 'bg-surface-hover'
                        )}
                      >
                        <button
                          type="button"
                          onClick={() => handleSelect(m.providerId, m.id)}
                          aria-label={`${m.name || m.id} ${m.providerName}`}
                          className="flex flex-1 items-center gap-2 px-2 py-1.5 rounded-lg min-w-0 text-[13px] text-left transition-colors"
                        >
                          <span className="flex-1 min-w-0 font-medium truncate">
                            {m.name || m.id}
                          </span>
                          {/* 最近使用跨 provider,补充展示 provider 名便于区分同名模型 */}
                          <span className="max-w-24 text-[11px] text-foreground-subtlest truncate shrink-0">
                            {m.providerName}
                          </span>
                          {isSelected && (
                            <Check className="size-3.5 text-brand shrink-0" />
                          )}
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            useAgentStore
                              .getState()
                              .removeRecentModel({ model: m.id, provider: m.providerId })
                          }
                          aria-label={`从最近使用中移除 ${m.name || m.id}(${m.providerName})`}
                          title="从最近使用中移除"
                          className="hover:bg-surface opacity-60 md:focus-visible:opacity-100 md:group-hover/recent:opacity-100 md:opacity-0 focus-visible:opacity-100 mr-1 p-1 rounded-md text-foreground-subtlest hover:text-foreground transition-all shrink-0"
                        >
                          <X className="size-3" />
                        </button>
                      </div>
                    );
                  })}
                  <div className="mx-2 mt-1 border-border border-t" />
                </div>
              )}
              {filteredModelGroups.length === 0 ? (
                <div className="px-2 py-2 text-[13px] text-foreground-subtle">
                  {modelGroups.length === 0
                    ? '暂无可用的模型。可在「设置」中配置 API Key 后拉取模型。'
                    : '未找到匹配的模型。'}
                </div>
              ) : (
              filteredModelGroups.map((g) => (
                <div key={g.providerId}>
                  <div className="flex items-center gap-1.5 px-2 pt-1.5 pb-0.5 font-medium text-[11px] text-foreground-subtlest">
                    <ProviderLogo
                      providerId={g.providerId}
                      name={g.providerName}
                      className="size-3.5"
                    />
                    <span className="truncate">{g.providerName}</span>
                  </div>
                  {g.models.map((m) => {
                    // 选中态必须同时匹配 provider + 模型 id:不同 provider 下
                    // 可能存在同名模型(如 deepseek / opencode-zen 都有
                    // deepseek-v4-flash-free),只比较 id 会全部高亮打勾
                    const isSelected =
                      !!selected && m.id === selected.model && g.providerId === selected.provider;
                    return (
                      <button
                        key={`${g.providerId}/${m.id}`}
                        type="button"
                        onClick={() => handleSelect(g.providerId, m.id)}
                        className={cn(
                          'flex items-center gap-2 hover:bg-surface-hover px-2 py-1.5 rounded-lg w-full text-[13px] text-left transition-colors',
                          isSelected && 'bg-surface-hover'
                        )}
                      >
                        <span className="flex-1 min-w-0 font-medium truncate">
                          {m.name || m.id}
                        </span>
                        {isSelected && (
                          <Check className="size-3.5 text-brand shrink-0" />
                        )}
                      </button>
                    );
                  })}
                </div>
              ))
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
