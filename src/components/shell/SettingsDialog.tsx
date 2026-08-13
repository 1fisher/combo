import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { CheckCircle2, ChevronDown, Loader2, Trash2, Zap } from 'lucide-react';
import { Button } from '../ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import {
  clearExternalUrl,
  clearProxyUrlOverride,
  getExternalUrl,
  getProxyBaseUrl,
  getProxyUrlOverride,
  isTauri,
  setExternalUrl,
  setProxyUrlOverride,
} from '../../lib/connection';
import { useUpdater } from '../../hooks/useUpdater';
import { useFetchModels, useProviders, useSaveProviderKey } from '../../hooks/useAgentModel';
import { useAgentStore } from '../../stores/agentStore';
import { formatTokenCount } from '../../lib/tokens';
import { useQueryClient } from '@tanstack/react-query';

interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * 设置对话框:
 * 1. 模型 Provider 配置 — 为各 provider 填入 API Key 并拉取可用模型。
 * 2. 外部访问域名 — 域名部署时填写公开访问地址。
 * 3. 代理地址 — 前后端分离部署时指定 combo-cli serve 服务地址。
 */
export function SettingsDialog({ open, onOpenChange }: SettingsDialogProps) {
  const [proxyInput, setProxyInput] = useState('');
  const [hasProxyOverride, setHasProxyOverride] = useState(false);
  const [domainInput, setDomainInput] = useState('');
  const [hasDomain, setHasDomain] = useState(false);
  const updater = useUpdater();
  const [appVersion, setAppVersion] = useState('');
  // 上下文窗口区块的提交句柄(与域名/代理一样,点「保存」才生效)
  const ctxSectionRef = useRef<{ commit: () => void }>(null);

  useEffect(() => {
    if (open && isTauri()) {
      import('@tauri-apps/api/app')
        .then(({ getVersion }) => getVersion())
        .then(setAppVersion)
        .catch(() => setAppVersion(''));
    }
  }, [open]);

  useEffect(() => {
    if (open) {
      const ov = getProxyUrlOverride();
      setHasProxyOverride(ov !== null);
      setProxyInput(ov ?? getProxyBaseUrl());

      const ext = getExternalUrl();
      setHasDomain(ext !== null);
      setDomainInput(ext ?? '');
    }
  }, [open]);

  function save() {
    const proxyVal = proxyInput.trim();
    if (proxyVal) {
      setProxyUrlOverride(proxyVal);
    } else {
      clearProxyUrlOverride();
    }
    setExternalUrl(domainInput.trim());
    ctxSectionRef.current?.commit();
    onOpenChange(false);
  }

  function resetDomain() {
    setDomainInput('');
    setHasDomain(false);
    clearExternalUrl();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>设置</DialogTitle>
          <DialogDescription>
            配置模型 Provider、域名远程访问和代理服务地址。
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          {/* 模型 Provider 配置 */}
          <ProviderConfigSection open={open} />

          {/* 手动上下文窗口 */}
          <ContextWindowSection open={open} ref={ctxSectionRef} />

          {/* 外部访问域名 */}
          <div className="flex flex-col gap-2">
            <label className="text-[13px] font-medium text-foreground">外部访问域名</label>
            <input
              value={domainInput}
              onChange={(e) => setDomainInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') save();
              }}
              placeholder="https://proxy.apesoft.cn"
              className="h-9 w-full rounded-lg border border-input-border bg-background px-2.5 text-[13px] outline-none placeholder:text-foreground-subtlest focus-visible:border-input-border-focused"
            />
            <div className="text-[12px] text-foreground-subtle">
              {hasDomain
                ? '已配置自定义域名,移动端扫码将使用此地址连接'
                : '留空则使用默认中转域名(proxy.apesoft.cn),扫码即可远程访问'}
            </div>
            {hasDomain && (
              <Button variant="ghost" size="sm" className="h-7 w-fit text-[12px]" onClick={resetDomain}>
                清除域名配置
              </Button>
            )}
          </div>

          {/* 代理地址 */}
          <div className="flex flex-col gap-2">
            <label className="text-[13px] font-medium text-foreground">代理地址</label>
            <input
              value={proxyInput}
              onChange={(e) => setProxyInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') save();
              }}
              placeholder={isTauri() ? '桌面模式使用内置代理' : 'http://127.0.0.1:18234'}
              className="h-9 w-full rounded-lg border border-input-border bg-background px-2.5 text-[13px] outline-none placeholder:text-foreground-subtlest focus-visible:border-input-border-focused"
            />
            <div className="text-[12px] text-foreground-subtle">
              当前地址:{getProxyBaseUrl() || '未连接'}
            </div>
            {isTauri() && (
              <div className="text-[12px] text-foreground-subtle">
                桌面模式使用内置代理,无需手动配置。
              </div>
            )}
          </div>

          {/* 应用更新(仅桌面模式) */}
          {isTauri() && (
            <div className="flex flex-col gap-2">
              <label className="text-[13px] font-medium text-foreground">应用更新</label>
              {appVersion && (
                <div className="text-[12px] text-foreground-subtle">
                  当前版本 <span className="font-medium text-foreground">v{appVersion}</span>
                </div>
              )}
              {(updater.status === 'idle' || updater.status === 'latest') && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 w-fit text-[12px]"
                  onClick={() => updater.checkForUpdate()}
                >
                  检查更新
                </Button>
              )}
              {updater.status === 'latest' && (
                <div className="flex items-center gap-1.5 text-[12px] text-green-500">
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  已是最新版本
                </div>
              )}
              {updater.status === 'checking' && (
                <div className="text-[12px] text-foreground-subtle">正在检查更新…</div>
              )}
              {updater.status === 'available' && updater.updateInfo && (
                <div className="flex flex-col gap-2">
                  <div className="text-[12px] text-foreground-subtle">
                    发现新版本 <span className="font-medium text-foreground">v{updater.updateInfo.version}</span>
                  </div>
                  {updater.updateInfo.body && (
                    <pre className="max-h-32 overflow-auto whitespace-pre-wrap rounded-lg border border-input-border bg-background p-2.5 text-[11px] text-foreground-subtle">
                      {updater.updateInfo.body}
                    </pre>
                  )}
                  <div className="flex gap-2">
                    <Button
                      variant="default"
                      size="sm"
                      className="h-8 text-[12px]"
                      onClick={() => updater.downloadAndInstall()}
                    >
                      下载并安装
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-8 text-[12px]"
                      onClick={() => updater.checkForUpdate()}
                    >
                      重新检查
                    </Button>
                  </div>
                </div>
              )}
              {(updater.status === 'downloading' || updater.status === 'installing') && (
                <div className="text-[12px] text-foreground-subtle">
                  {updater.status === 'downloading' ? '正在下载更新…' : '正在安装更新…'}
                </div>
              )}
              {updater.status === 'done' && (
                <div className="text-[12px] text-green-500">更新已安装,请重启应用。</div>
              )}
              {updater.status === 'error' && (
                <div className="text-[12px] text-red-500">更新失败:{updater.error}</div>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          {hasProxyOverride && (
            <Button
              variant="ghost"
              onClick={() => {
                clearProxyUrlOverride();
                setHasProxyOverride(false);
                setProxyInput(getProxyBaseUrl());
              }}
            >
              恢复代理默认
            </Button>
          )}
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button onClick={save} disabled={isTauri() && !domainInput.trim()}>
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------- Provider 配置区 ----------

function ProviderConfigSection({ open }: { open: boolean }) {
  const qc = useQueryClient();
  const { data: providers } = useProviders(null);
  const fetchModels = useFetchModels(null);
  const saveProviderKey = useSaveProviderKey(null);

  // 每个 provider 的输入状态
  const [keyInputs, setKeyInputs] = useState<Record<string, string>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [statusMsg, setStatusMsg] = useState<Record<string, { ok: boolean; msg: string }>>({});

  // 对话框打开时刷新 provider 列表
  useEffect(() => {
    if (open) {
      qc.invalidateQueries({ queryKey: ['providers', null] });
      setStatusMsg({});
    }
  }, [open, qc]);

  async function handleFetch(providerId: string) {
    const apiKey = (keyInputs[providerId] ?? '').trim();
    const p = providers?.find((x) => x.id === providerId);
    const ptype = p?.type;
    setStatusMsg((s) => ({ ...s, [providerId]: { ok: false, msg: '' } }));
    if (!apiKey && !p?.has_api_key) {
      setStatusMsg((s) => ({ ...s, [providerId]: { ok: false, msg: '请输入 API Key' } }));
      return;
    }
    try {
      // 输入了新 key 才持久化保存;留空则沿用已保存的 key
      if (apiKey) {
        await saveProviderKey.mutateAsync({
          providerId,
          apiKey,
          providerType: ptype,
        });
      }
      const result = await fetchModels.mutateAsync({
        providerId,
        apiKey: apiKey || undefined,
        providerType: ptype,
      });
      setKeyInputs((prev) => ({ ...prev, [providerId]: '' }));
      setStatusMsg((s) => ({
        ...s,
        [providerId]: {
          ok: true,
          msg: `已拉取到 ${result.models.length} 个模型${apiKey ? '' : '(使用已保存的 Key)'}`,
        },
      }));
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setStatusMsg((s) => ({ ...s, [providerId]: { ok: false, msg } }));
    }
  }

  async function handleClearKey(providerId: string) {
    const p = providers?.find((x) => x.id === providerId);
    setStatusMsg((s) => ({ ...s, [providerId]: { ok: false, msg: '' } }));
    try {
      // 保存空 key 即清除(resolved_api_key 对空串返回 None,has_api_key 变 false)
      await saveProviderKey.mutateAsync({
        providerId,
        apiKey: '',
        providerType: p?.type,
      });
      setKeyInputs((prev) => ({ ...prev, [providerId]: '' }));
      setStatusMsg((s) => ({ ...s, [providerId]: { ok: true, msg: '已清除 API Key' } }));
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setStatusMsg((s) => ({ ...s, [providerId]: { ok: false, msg } }));
    }
  }

  const list = providers ?? [];
  if (list.length === 0) return null;

  return (
    <div className="flex flex-col gap-2">
      <label className="text-[13px] font-medium text-foreground">模型 Provider</label>
      <div className="flex flex-col gap-1.5">
        {list.map((p) => {
          const modelCount = Array.isArray(p.models) ? p.models.length : 0;
          const isExpanded = expanded[p.id] ?? false;
          const st = statusMsg[p.id];
          const busy = fetchModels.isPending || saveProviderKey.isPending;
          const hasKey = !!p.has_api_key;
          const typedKey = (keyInputs[p.id] ?? '').trim();
          const canFetch = hasKey || typedKey.length > 0;
          return (
            <div key={p.id} className="rounded-lg border border-input-border bg-background">
              <button
                type="button"
                onClick={() => setExpanded((prev) => ({ ...prev, [p.id]: !isExpanded }))}
                className="flex w-full items-center justify-between px-2.5 py-1.5 text-left"
              >
                <span className="flex items-center gap-1.5">
                  <span className="text-[13px] font-medium text-foreground">{p.name ?? p.id}</span>
                  <span
                    className={`rounded px-1.5 py-0.5 text-[10px] ${
                      hasKey ? 'bg-brand/10 text-brand' : 'bg-surface-hover text-foreground-subtle'
                    }`}
                  >
                    {modelCount > 0 ? `${modelCount} 个模型` : hasKey ? '已配置 Key' : '未配置'}
                  </span>
                </span>
                <ChevronDown
                  className={`size-3.5 text-foreground-subtle transition-transform ${isExpanded ? 'rotate-180' : ''}`}
                />
              </button>
              {isExpanded && (
                <div className="flex flex-col gap-1.5 border-t border-input-border px-2.5 py-2">
                  {/* 已有模型列表 */}
                  {modelCount > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {p.models!.slice(0, 8).map((m, i) => (
                        <span
                          key={`${m.id ?? i}`}
                          className="rounded bg-surface-hover px-1.5 py-0.5 text-[10px] text-foreground-subtle"
                        >
                          {m.name ?? m.id}
                        </span>
                      ))}
                      {modelCount > 8 && (
                        <span className="px-1 py-0.5 text-[10px] text-foreground-subtlest">
                          +{modelCount - 8}
                        </span>
                      )}
                    </div>
                  )}
                  {/* 已配置的脱敏 key 展示 */}
                  {hasKey && !typedKey && (
                    <div className="flex items-center gap-1 text-[11px] text-foreground-subtle">
                      已配置 API Key:
                      <span className="font-mono text-foreground">{p.api_key_masked || '****'}</span>
                      <span className="text-foreground-subtlest">(输入新 Key 可覆盖)</span>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => handleClearKey(p.id)}
                        className="ml-1 inline-flex shrink-0 items-center gap-0.5 rounded px-1 py-0.5 text-[11px] text-destructive hover:bg-surface-hover disabled:opacity-50"
                      >
                        <Trash2 className="size-3" />
                        清除
                      </button>
                    </div>
                  )}
                  <div className="flex items-center gap-1">
                    <input
                      type="password"
                      value={keyInputs[p.id] ?? ''}
                      onChange={(e) =>
                        setKeyInputs((prev) => ({ ...prev, [p.id]: e.target.value }))
                      }
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !busy && canFetch) {
                          e.preventDefault();
                          handleFetch(p.id);
                        }
                      }}
                      placeholder={
                        hasKey ? '输入新 API Key 覆盖(留空使用已保存)' : '输入 API Key...'
                      }
                      className="h-7 min-w-0 flex-1 rounded-lg border border-input-border bg-input px-2 text-[12px] text-foreground outline-none placeholder:text-foreground-subtlest focus:border-input-border-focused"
                    />
                    <Button
                      type="button"
                      size="sm"
                      disabled={busy || !canFetch}
                      onClick={() => handleFetch(p.id)}
                      className="h-7 shrink-0 gap-1 rounded-lg px-2 text-[12px]"
                    >
                      {busy ? (
                        <Loader2 className="size-3 animate-spin" />
                      ) : (
                        <Zap className="size-3" />
                      )}
                      拉取模型
                    </Button>
                  </div>
                  {st?.msg && (
                    <div className={`text-[11px] ${st.ok ? 'text-brand' : 'text-destructive'}`}>
                      {st.msg}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="text-[12px] text-foreground-subtle">
        输入 API Key 后点击「拉取模型」获取该 Provider 支持的模型列表;已配置 Key 的
        Provider 可直接点击「拉取模型」同步最新模型。
      </div>
    </div>
  );
}

// ---------- 上下文窗口设置区 ----------

const CONTEXT_QUICK = [
  { label: '128k', value: 131_072 },
  { label: '200k', value: 204_800 },
  { label: '256k', value: 262_144 },
  { label: '1M', value: 1_048_576 },
];

/** 取 provider 的默认大模型 id,未配置则取第一个模型 */
function defaultModelOf(p: {
  default_large_model_id?: string;
  models?: { id?: string }[];
} | undefined): string {
  if (!p) return '';
  const models = Array.isArray(p.models) ? p.models : [];
  return p.default_large_model_id && models.some((m) => m.id === p.default_large_model_id)
    ? p.default_large_model_id
    : (models[0]?.id ?? '');
}

/**
 * 按模型手动设置上下文窗口上限(token 数),存 agentStore contextOverrides
 * (key = 模型 id,localStorage 持久化,按模型全局生效),Composer 用量统计优先使用。
 * 输入留空 + 保存 = 清除该模型的覆盖值;未修改任何字段时点保存不生效。
 */
const ContextWindowSection = forwardRef<
  { commit: () => void },
  { open: boolean }
>(function ContextWindowSection({ open }, ref) {
  const { data: providers } = useProviders(null);
  const contextOverrides = useAgentStore((s) => s.contextOverrides);
  const setContextOverride = useAgentStore((s) => s.setContextOverride);
  const clearContextOverride = useAgentStore((s) => s.clearContextOverride);

  const [providerId, setProviderId] = useState('');
  const [modelId, setModelId] = useState('');
  const [tokenInput, setTokenInput] = useState('');
  // 用户是否改动过输入(区分「没改」与「主动清空」,避免误清除已有配置)
  const dirtyRef = useRef(false);

  // 打开时初始化:默认选中第一个 provider 及其默认/首个模型,回填已有覆盖值。
  // providerId 非空说明已初始化过(providers 异步加载完成后),不再覆盖用户选择。
  useEffect(() => {
    if (!open || providerId) return;
    const p = (providers ?? [])[0];
    if (!p) return;
    const defaultModel = defaultModelOf(p);
    setProviderId(p.id);
    setModelId(defaultModel);
    const v = contextOverrides[defaultModel];
    setTokenInput(v != null ? String(v) : '');
    dirtyRef.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, providers, providerId]);

  // 切换 provider/model 时回填该模型的覆盖值(不标记 dirty)
  useEffect(() => {
    if (!modelId) return;
    const v = contextOverrides[modelId];
    setTokenInput(v != null ? String(v) : '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providerId, modelId]);

  const provider = providers?.find((p) => p.id === providerId);
  const models = (provider && Array.isArray(provider.models) ? provider.models : []) as {
    id?: string;
    name?: string;
    context_window?: number;
  }[];
  const model = models.find((m) => m.id === modelId);
  const defaultWindow = typeof model?.context_window === 'number' ? model.context_window : undefined;
  const hasOverride = !!modelId && contextOverrides[modelId] != null;

  useImperativeHandle(
    ref,
    () => ({
      commit() {
        if (!modelId || !dirtyRef.current) return;
        dirtyRef.current = false;
        const n = Number(tokenInput.trim());
        if (tokenInput.trim() === '' || !Number.isFinite(n) || n <= 0) {
          clearContextOverride(modelId);
          return;
        }
        setContextOverride(modelId, Math.round(n));
      },
    }),
    [modelId, tokenInput, setContextOverride, clearContextOverride],
  );

  if (!providers?.length) return null;

  const selectCls =
    'h-9 w-full rounded-lg border border-input-border bg-background px-2.5 text-[13px] text-foreground outline-none [color-scheme:dark] focus-visible:border-input-border-focused';

  return (
    <div className="flex flex-col gap-2">
      <label className="text-[13px] font-medium text-foreground">上下文窗口(手动)</label>
      <div className="grid grid-cols-2 gap-1.5">
        <select
          value={providerId}
          onChange={(e) => {
            const pid = e.target.value;
            setProviderId(pid);
            // 切换 Provider 时同步重置模型为新 provider 的默认/首个模型,
            // 否则 modelId 残留旧值,模型下拉显示与实际保存的模型不一致(覆盖错模型)
            setModelId(defaultModelOf(providers?.find((p) => p.id === pid)));
            dirtyRef.current = true;
          }}
          className={selectCls}
          aria-label="选择 Provider"
        >
          {providers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name ?? p.id}
            </option>
          ))}
        </select>
        <select
          value={modelId}
          onChange={(e) => {
            setModelId(e.target.value);
            dirtyRef.current = true;
          }}
          className={selectCls}
          aria-label="选择模型"
        >
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name ?? m.id}
            </option>
          ))}
        </select>
      </div>
      <div className="flex items-center gap-1.5">
        <input
          type="number"
          min={1}
          step={1024}
          value={tokenInput}
          onChange={(e) => {
            setTokenInput(e.target.value);
            dirtyRef.current = true;
          }}
          placeholder="token 数,留空 = 恢复默认"
          className="h-9 min-w-0 flex-1 rounded-lg border border-input-border bg-background px-2.5 font-mono text-[13px] text-foreground outline-none placeholder:text-foreground-subtlest focus-visible:border-input-border-focused [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
        />
        {hasOverride && (
          <Button
            variant="ghost"
            size="sm"
            className="h-8 shrink-0 text-[12px]"
            onClick={() => {
              setTokenInput('');
              dirtyRef.current = true;
            }}
          >
            清除
          </Button>
        )}
      </div>      <div className="flex flex-wrap items-center gap-1.5">
        {CONTEXT_QUICK.map((q) => (
          <button
            key={q.label}
            type="button"
            onClick={() => {
              setTokenInput(String(q.value));
              dirtyRef.current = true;
            }}
            className="rounded border border-input-border bg-background px-2 py-0.5 text-[11px] text-foreground-subtle transition-colors hover:bg-surface-hover"
          >
            {q.label}
          </button>
        ))}
        {defaultWindow && (
          <span className="text-[11px] text-foreground-subtlest">
            默认 {formatTokenCount(defaultWindow)}
          </span>
        )}
      </div>
      <div className="text-[12px] text-foreground-subtle">
        按模型全局生效(与 Provider 无关):同一模型即使挂在多个 Provider 下也只
        存一份,优先于后端上报值;输入框留空并保存即恢复默认。
      </div>
    </div>
  );
});
