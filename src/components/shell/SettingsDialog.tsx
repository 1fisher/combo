import { useEffect, useState } from 'react';
import { CheckCircle2, ChevronDown, Loader2, Zap } from 'lucide-react';
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
import { useQueryClient } from '@tanstack/react-query';

interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * 设置对话框:
 * 1. 模型 Provider 配置 — 为各 provider 填入 API Key 并拉取可用模型。
 * 2. 外部访问域名 — 域名部署时填写公开访问地址。
 * 3. 代理地址 — 前后端分离部署时指定 combo-proxy 服务地址。
 */
export function SettingsDialog({ open, onOpenChange }: SettingsDialogProps) {
  const [proxyInput, setProxyInput] = useState('');
  const [hasProxyOverride, setHasProxyOverride] = useState(false);
  const [domainInput, setDomainInput] = useState('');
  const [hasDomain, setHasDomain] = useState(false);
  const updater = useUpdater();
  const [appVersion, setAppVersion] = useState('');

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
    const ptype = providers?.find((p) => p.id === providerId)?.type;
    setStatusMsg((s) => ({ ...s, [providerId]: { ok: false, msg: '' } }));
    if (!apiKey) {
      setStatusMsg((s) => ({ ...s, [providerId]: { ok: false, msg: '请输入 API Key' } }));
      return;
    }
    try {
      await saveProviderKey.mutateAsync({
        providerId,
        apiKey,
        providerType: ptype,
      });
      const result = await fetchModels.mutateAsync({
        providerId,
        apiKey,
        providerType: ptype,
      });
      setKeyInputs((prev) => ({ ...prev, [providerId]: '' }));
      setStatusMsg((s) => ({
        ...s,
        [providerId]: { ok: true, msg: `已拉取到 ${result.models.length} 个模型` },
      }));
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
          return (
            <div key={p.id} className="rounded-lg border border-input-border bg-background">
              <button
                type="button"
                onClick={() => setExpanded((prev) => ({ ...prev, [p.id]: !isExpanded }))}
                className="flex w-full items-center justify-between px-2.5 py-1.5 text-left"
              >
                <span className="flex items-center gap-1.5">
                  <span className="text-[13px] font-medium text-foreground">{p.name ?? p.id}</span>
                  <span className="rounded bg-surface-hover px-1.5 py-0.5 text-[10px] text-foreground-subtle">
                    {modelCount > 0 ? `${modelCount} 个模型` : '未配置'}
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
                  <div className="flex items-center gap-1">
                    <input
                      type="password"
                      value={keyInputs[p.id] ?? ''}
                      onChange={(e) =>
                        setKeyInputs((prev) => ({ ...prev, [p.id]: e.target.value }))
                      }
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !busy) {
                          e.preventDefault();
                          handleFetch(p.id);
                        }
                      }}
                      placeholder="输入 API Key..."
                      className="h-7 min-w-0 flex-1 rounded-lg border border-input-border bg-input px-2 text-[12px] text-foreground outline-none placeholder:text-foreground-subtlest focus:border-input-border-focused"
                    />
                    <Button
                      type="button"
                      size="sm"
                      disabled={busy || !(keyInputs[p.id] ?? '').trim()}
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
        输入 API Key 后点击「拉取模型」获取该 Provider 支持的模型列表。
      </div>
    </div>
  );
}
