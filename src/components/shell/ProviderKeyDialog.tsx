import { useEffect, useMemo, useState } from 'react';
import { Check, KeyRound, Loader2, Plus, Trash2 } from 'lucide-react';
import { Button } from '../ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import { cn } from '../../lib/utils';
import { useProviders, useProviderKeys } from '../../hooks/useAgentModel';
import { useQueryClient } from '@tanstack/react-query';
import { confirmDialog } from '../../lib/confirm';
import { ProviderLogo } from '../agent/ProviderLogo';

interface ProviderKeyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** null 表示全局配置(不绑定 workspace)。 */
  workspaceId: string | null;
}

/**
 * Provider API Key 多 key 管理对话框:
 * 侧边栏底部的 Provider 入口打开。支持为每个 provider 保存多个 API Key,
 * 列表展示脱敏 key,一键「使用」切换激活 key,可追加/删除。
 * 明文 key 只发往后端落盘,前端仅展示脱敏结果。
 */
export function ProviderKeyDialog({ open, onOpenChange, workspaceId }: ProviderKeyDialogProps) {
  const qc = useQueryClient();
  const { data: providers } = useProviders(workspaceId);
  const keys = useProviderKeys(workspaceId);

  const [selectedId, setSelectedId] = useState<string>('');
  const [newKey, setNewKey] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // 打开时刷新 provider 列表,并默认选中当前已配置 key 的 provider
  useEffect(() => {
    if (open) {
      qc.invalidateQueries({ queryKey: ['providers', workspaceId] });
      setNewKey('');
      setMsg(null);
    }
  }, [open, qc, workspaceId]);

  const list = useMemo(() => providers ?? [], [providers]);
  const selected = useMemo(
    () => list.find((p) => p.id === selectedId) ?? list[0],
    [list, selectedId],
  );

  // provider 列表变化后兜底选中第一个
  useEffect(() => {
    if (open && selected && selected.id !== selectedId) {
      setSelectedId(selected.id);
    }
  }, [open, selected, selectedId]);

  const keyList = selected?.api_keys_masked ?? [];
  const activeIndex = selected?.active_key_index ?? null;
  const busy = keys.add.isPending || keys.activate.isPending || keys.remove.isPending;

  async function handleAdd() {
    const apiKey = newKey.trim();
    if (!apiKey || !selected) return;
    setMsg(null);
    try {
      await keys.add.mutateAsync({ providerId: selected.id, apiKey });
      setNewKey('');
      setMsg({ ok: true, text: '已添加 Key' });
    } catch (e: unknown) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    }
  }

  async function handleActivate(index: number) {
    if (!selected || index === activeIndex) return;
    setMsg(null);
    try {
      await keys.activate.mutateAsync({ providerId: selected.id, keyIndex: index });
      setMsg({ ok: true, text: '已切换激活 Key' });
    } catch (e: unknown) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    }
  }

  async function handleRemove(index: number) {
    if (!selected) return;
    const ok = await confirmDialog('确定删除该 API Key?');
    if (!ok) return;
    setMsg(null);
    try {
      await keys.remove.mutateAsync({ providerId: selected.id, keyIndex: index });
      setMsg({ ok: true, text: '已删除 Key' });
    } catch (e: unknown) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Provider API Key</DialogTitle>
          <DialogDescription>
            每个 Provider 可配置多个 API Key,点「使用」自由切换激活 Key(仅展示脱敏结果)。
          </DialogDescription>
        </DialogHeader>

        {/* Provider 选择 */}
        {list.length > 0 && (
          <div className="flex max-h-28 flex-wrap gap-1.5 overflow-y-auto">
            {list.map((p) => {
              const count = p.api_keys_masked?.length ?? 0;
              const isSel = selected?.id === p.id;
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setSelectedId(p.id)}
                  className={cn(
                    'flex items-center gap-1.5 rounded-lg border px-2 py-1 text-[12px] transition-colors',
                    isSel
                      ? 'border-brand/40 bg-brand/10 text-foreground'
                      : 'border-input-border bg-background text-foreground-subtle hover:bg-surface-hover',
                  )}
                >
                  <ProviderLogo providerId={p.id} name={p.name} className="size-3.5" />
                  <span className="max-w-24 truncate">{p.name ?? p.id}</span>
                  <span
                    className={cn(
                      'rounded px-1 text-[10px] leading-4',
                      count > 0 ? 'bg-brand/10 text-brand' : 'bg-surface-hover text-foreground-subtlest',
                    )}
                  >
                    {count > 0 ? `${count} Key` : '无'}
                  </span>
                </button>
              );
            })}
          </div>
        )}

        <div className="flex flex-col gap-1.5">
          {selected ? (
            <>
              {/* Key 列表 */}
              {keyList.length > 0 ? (
                keyList.map((masked, i) => {
                  const isActive = i === activeIndex;
                  return (
                    <div
                      key={`${masked}-${i}`}
                      className={cn(
                        'flex items-center gap-2 rounded-lg border px-2.5 py-1.5',
                        isActive ? 'border-brand/40 bg-brand/10' : 'border-input-border bg-background',
                      )}
                    >
                      <KeyRound
                        className={cn(
                          'size-3.5 shrink-0',
                          isActive ? 'text-brand' : 'text-foreground-subtlest',
                        )}
                      />
                      <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-foreground">
                        {masked || '****'}
                      </span>
                      {isActive ? (
                        <span className="inline-flex shrink-0 items-center gap-0.5 rounded bg-brand/10 px-1.5 py-0.5 text-[10px] font-medium text-brand">
                          <Check className="size-3" />
                          使用中
                        </span>
                      ) : (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={busy}
                          onClick={() => handleActivate(i)}
                          className="h-6 shrink-0 gap-0.5 rounded-md px-1.5 text-[11px]"
                        >
                          {keys.activate.isPending && keys.activate.variables?.keyIndex === i ? (
                            <Loader2 className="size-3 animate-spin" />
                          ) : (
                            <Check className="size-3" />
                          )}
                          使用
                        </Button>
                      )}
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        disabled={busy}
                        aria-label="删除该 Key"
                        title="删除该 Key"
                        onClick={() => handleRemove(i)}
                        className="shrink-0 text-foreground-subtle hover:text-destructive"
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    </div>
                  );
                })
              ) : (
                <div className="rounded-lg border border-input-border bg-background px-2.5 py-2 text-[12px] text-foreground-subtle">
                  {selected.has_api_key ? (
                    <>
                      当前使用已配置 Key <span className="font-mono text-foreground">{selected.api_key_masked || '****'}</span>
                      (环境变量/内置),添加 Key 后可自由切换。
                    </>
                  ) : (
                    '尚未配置 API Key,在下方添加。'
                  )}
                </div>
              )}

              {/* 添加 Key */}
              <div className="mt-1 flex items-center gap-1">
                <input
                  type="password"
                  value={newKey}
                  onChange={(e) => setNewKey(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && newKey.trim() && !busy) {
                      e.preventDefault();
                      handleAdd();
                    }
                  }}
                  placeholder="粘贴新的 API Key..."
                  className="h-7 min-w-0 flex-1 rounded-lg border border-input-border bg-input px-2 text-[12px] text-foreground outline-none placeholder:text-foreground-subtlest focus:border-input-border-focused"
                />
                <Button
                  type="button"
                  size="sm"
                  disabled={busy || !newKey.trim()}
                  onClick={handleAdd}
                  className="h-7 shrink-0 gap-1 rounded-lg px-2.5 text-[12px]"
                >
                  {keys.add.isPending ? (
                    <Loader2 className="size-3 animate-spin" />
                  ) : (
                    <Plus className="size-3" />
                  )}
                  添加
                </Button>
              </div>

              {msg && (
                <div className={cn('text-[11px]', msg.ok ? 'text-brand' : 'text-destructive')}>
                  {msg.text}
                </div>
              )}
            </>
          ) : (
            <div className="rounded-lg border border-input-border bg-background px-2.5 py-2 text-[12px] text-foreground-subtle">
              暂无可用的 Provider。
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
