import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Check, CheckCircle2, ChevronDown, Loader2, Pencil, Plus, Trash2, Zap } from 'lucide-react';
import { Button } from '../ui/button';
import { Switch } from '../ui/switch';
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
import { useCommitAttribution } from '../../hooks/useCommitAttribution';
import { requestNotifyPermission } from '../../lib/notify';
import { useFetchModels, useProviderCrud, useProviderKeys, useProviders, useSaveProviderKey, useSetModelContextWindow } from '../../hooks/useAgentModel';
import { useUIPreferences } from '../../stores/uiPreferencesStore';
import { formatTokenCount } from '../../lib/tokens';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { confirmDialog } from '../../lib/confirm';
import { listDirGrants, revokeDirGrant, getTranscribeStatus, setTranscribeModel, getSpeechStatus, setSpeechEnabled, setSpeechModel, setSpeechSpeed, prepareSpeech } from '../../lib/api';
import type { Api } from '../../lib/api/types';
import { cn } from '../../lib/utils';

interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * 设置对话框:
 * 1. 模型 Provider 配置 — 为各 provider 填入 API Key 并拉取可用模型。
 * 2. 特效与音效 — Liquid 流体特效 / Combo 连击气泡音。
 * 3. Git 提交署名 — 所有 git 提交自动追加 Generated with Combo(服务端全局 hook,命令行/其他工具同样生效)。
 * 4. 系统通知 — 免打扰 / 任务结束 / 需要交互时发送系统通知(可选同时播放提示音)。
 * 5. 目录访问授权 — 管理已记住的敏感目录授权(允许一次后不再询问)。
 * 6. 外部访问域名 — 域名部署时填写公开访问地址。
 * 7. 代理地址 — 前后端分离部署时指定 combo-cli serve 服务地址。
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
  const liquidEnabled = useUIPreferences((s) => s.liquidEnabled);
  const setLiquidEnabled = useUIPreferences((s) => s.setLiquidEnabled);
  const comboSoundEnabled = useUIPreferences((s) => s.comboSoundEnabled);
  const setComboSoundEnabled = useUIPreferences((s) => s.setComboSoundEnabled);
  const dndEnabled = useUIPreferences((s) => s.dndEnabled);
  const setDndEnabled = useUIPreferences((s) => s.setDndEnabled);
  const notifyRunComplete = useUIPreferences((s) => s.notifyRunComplete);
  const setNotifyRunComplete = useUIPreferences((s) => s.setNotifyRunComplete);
  const notifyInteraction = useUIPreferences((s) => s.notifyInteraction);
  const setNotifyInteraction = useUIPreferences((s) => s.setNotifyInteraction);
  const notifySoundEnabled = useUIPreferences((s) => s.notifySoundEnabled);
  const setNotifySoundEnabled = useUIPreferences((s) => s.setNotifySoundEnabled);
  // 通知权限被拒时的提示(开启开关时请求权限,失败则提示去系统设置开启)
  const [notifyBlocked, setNotifyBlocked] = useState(false);
  const attribution = useCommitAttribution();

  async function toggleNotify(next: boolean, apply: (v: boolean) => void) {
    apply(next);
    if (next) {
      setNotifyBlocked(!(await requestNotifyPermission()));
    } else {
      setNotifyBlocked(false);
    }
  }

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
          {/* Liquid 流体特效 */}
          <div className="flex items-center justify-between">
            <div className="flex flex-col gap-0.5">
              <label className="text-[13px] font-medium text-foreground">Liquid 流体特效</label>
              <span className="text-[12px] text-foreground-subtle">
                鼠标移动时的全屏 WebGL 流体动效
              </span>
            </div>
            <Switch checked={liquidEnabled} onCheckedChange={setLiquidEnabled} aria-label="Liquid 流体特效" />
          </div>

          {/* Combo 特效音效 */}
          <div className="flex items-center justify-between">
            <div className="flex flex-col gap-0.5">
              <label className="text-[13px] font-medium text-foreground">Combo 特效音效</label>
              <span className="text-[12px] text-foreground-subtle">
                连击特效弹出与增长时播放气泡音,连击越高气泡越大越饱满
              </span>
            </div>
            <Switch
              checked={comboSoundEnabled}
              onCheckedChange={setComboSoundEnabled}
              aria-label="Combo 特效音效"
            />
          </div>

          {/* Git 提交署名 */}
          <div className="flex items-center justify-between">
            <div className="flex flex-col gap-0.5">
              <label className="text-[13px] font-medium text-foreground">Git 提交署名</label>
              <span className="text-[12px] text-foreground-subtle">
                git 提交自动追加 Generated with Combo 署名,覆盖命令行与其他工具
              </span>
            </div>
            <Switch
              checked={attribution.enabled}
              onCheckedChange={attribution.toggle}
              disabled={attribution.isPending}
              aria-label="Git 提交署名"
            />
          </div>

          {/* 系统通知 */}
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <div className="flex flex-col gap-0.5">
                <label className="text-[13px] font-medium text-foreground">免打扰模式</label>
                <span className="text-[12px] text-foreground-subtle">
                  开启后暂停任务结束与交互请求的全部通知及提示音,下方通知开关暂不生效
                </span>
              </div>
              <Switch
                checked={dndEnabled}
                onCheckedChange={setDndEnabled}
                aria-label="免打扰模式"
              />
            </div>
            <div className="flex items-center justify-between">
              <div className="flex flex-col gap-0.5">
                <label
                  className={cn(
                    'text-[13px] font-medium',
                    dndEnabled ? 'text-foreground-subtle' : 'text-foreground',
                  )}
                >
                  任务结束通知
                </label>
                <span className="text-[12px] text-foreground-subtle">
                  任务运行结束时发送系统通知
                  {dndEnabled && (
                    <span className="text-amber-500">(免打扰模式开启期间不生效)</span>
                  )}
                </span>
              </div>
              <Switch
                checked={notifyRunComplete}
                onCheckedChange={(v) => void toggleNotify(v, setNotifyRunComplete)}
                disabled={dndEnabled}
                aria-label="任务结束通知"
              />
            </div>
            <div className="flex items-center justify-between">
              <div className="flex flex-col gap-0.5">
                <label
                  className={cn(
                    'text-[13px] font-medium',
                    dndEnabled ? 'text-foreground-subtle' : 'text-foreground',
                  )}
                >
                  交互请求通知
                </label>
                <span className="text-[12px] text-foreground-subtle">
                  需要确认工具或回答问题时发送系统通知
                  {dndEnabled && (
                    <span className="text-amber-500">(免打扰模式开启期间不生效)</span>
                  )}
                </span>
              </div>
              <Switch
                checked={notifyInteraction}
                onCheckedChange={(v) => void toggleNotify(v, setNotifyInteraction)}
                disabled={dndEnabled}
                aria-label="交互请求通知"
              />
            </div>
            <div className="flex items-center justify-between">
              <div className="flex flex-col gap-0.5">
                <label
                  className={cn(
                    'text-[13px] font-medium',
                    dndEnabled ? 'text-foreground-subtle' : 'text-foreground',
                  )}
                >
                  通知音效
                </label>
                <span className="text-[12px] text-foreground-subtle">
                  发送系统通知时同时播放提示音(任务完成与交互提醒音色不同)
                  {dndEnabled && (
                    <span className="text-amber-500">(免打扰模式开启期间不生效)</span>
                  )}
                </span>
              </div>
              <Switch
                checked={notifySoundEnabled}
                onCheckedChange={setNotifySoundEnabled}
                disabled={dndEnabled}
                aria-label="通知音效"
              />
            </div>
            {notifyBlocked && (
              <div className="text-[12px] text-amber-500">
                未能获取通知权限,请在系统或浏览器设置中允许 combo 发送通知。
              </div>
            )}
          </div>

          {/* 模型 Provider 配置 */}
          <ProviderConfigSection open={open} />

          {/* 手动上下文窗口 */}
          <ContextWindowSection open={open} ref={ctxSectionRef} />

          {/* 语音识别(ASR)模型 */}
          <AsrModelSection open={open} />

          {/* 语音合成(TTS)朗读 */}
          <TtsSection open={open} />

          {/* 目录访问授权(敏感目录允许一次后持久记住) */}
          <DirGrantsSection open={open} />

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
              placeholder={isTauri() ? '桌面模式使用内置代理' : 'http://127.0.0.1:18236'}
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

// ---------- 目录访问授权区(敏感目录允许一次后持久记住) ----------

function DirGrantsSection({ open }: { open: boolean }) {
  const qc = useQueryClient();
  const { data: grants } = useQuery({
    queryKey: ['dir-grants'],
    queryFn: listDirGrants,
    enabled: open,
  });
  const revoke = useMutation({
    mutationFn: (id: number) => revokeDirGrant(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['dir-grants'] }),
  });

  return (
    <div className="flex flex-col gap-2">
      <label className="text-[13px] font-medium text-foreground">目录访问授权</label>
      <div className="text-[12px] text-foreground-subtle">
        访问 文稿/桌面/下载、iCloud 或移动硬盘等受保护目录时询问一次,允许后不再重复询问。
        撤销后下次访问会重新询问。
      </div>
      {(grants ?? []).length === 0 ? (
        <div className="text-[12px] text-foreground-subtlest">暂无已授权目录</div>
      ) : (
        <div className="flex max-h-40 flex-col gap-1.5 overflow-auto">
          {(grants ?? []).map((g) => (
            <div key={g.id} className="flex items-center gap-2">
              <span
                className="min-w-0 flex-1 truncate font-mono text-[12px] text-foreground-subtle"
                title={g.path}
              >
                {g.path}
              </span>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 shrink-0 px-2 text-[12px] text-destructive hover:text-destructive"
                disabled={revoke.isPending}
                onClick={() => void revoke.mutateAsync(g.id).catch(() => undefined)}
              >
                撤销
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ProviderConfigSection({ open }: { open: boolean }) {
  const qc = useQueryClient();
  const { data: providers } = useProviders(null);
  const fetchModels = useFetchModels(null);
  const saveProviderKey = useSaveProviderKey(null);
  const providerKeys = useProviderKeys(null);

  // 每个 provider 的输入状态
  const [keyInputs, setKeyInputs] = useState<Record<string, string>>({});
  const [nameInputs, setNameInputs] = useState<Record<string, string>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [statusMsg, setStatusMsg] = useState<Record<string, { ok: boolean; msg: string }>>({});
  // 行内重命名状态
  const [renaming, setRenaming] = useState<{ providerId: string; keyIndex: number } | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  // 自定义 provider 增删
  const providerCrud = useProviderCrud(null);
  const [showAddProvider, setShowAddProvider] = useState(false);
  const [newProvider, setNewProvider] = useState({
    id: '',
    name: '',
    type: 'openai-compat',
    baseUrl: '',
    apiKey: '',
  });
  const [providerMsg, setProviderMsg] = useState<{ ok: boolean; msg: string } | null>(null);

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

  /** 仅保存新 Key 到当前 Provider(不拉取模型),供多 Key 切换使用;可带名称便于记忆。 */
  async function handleAddKey(providerId: string) {
    const apiKey = (keyInputs[providerId] ?? '').trim();
    if (!apiKey) return;
    const name = (nameInputs[providerId] ?? '').trim() || undefined;
    setStatusMsg((s) => ({ ...s, [providerId]: { ok: false, msg: '' } }));
    try {
      await providerKeys.add.mutateAsync({ providerId, apiKey, name });
      setKeyInputs((prev) => ({ ...prev, [providerId]: '' }));
      setNameInputs((prev) => ({ ...prev, [providerId]: '' }));
      setStatusMsg((s) => ({ ...s, [providerId]: { ok: true, msg: '已添加 Key' } }));
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setStatusMsg((s) => ({ ...s, [providerId]: { ok: false, msg } }));
    }
  }

  /** 开始行内重命名指定 key。 */
  function startRename(providerId: string, keyIndex: number, currentName: string) {
    setRenaming({ providerId, keyIndex });
    setRenameDraft(currentName);
  }

  /** 提交重命名;名称为空则清除名称。 */
  async function commitRename(providerId: string, keyIndex: number) {
    const name = renameDraft.trim() || undefined;
    setRenaming(null);
    setStatusMsg((s) => ({ ...s, [providerId]: { ok: false, msg: '' } }));
    try {
      await providerKeys.rename.mutateAsync({ providerId, keyIndex, name });
      setStatusMsg((s) => ({ ...s, [providerId]: { ok: true, msg: '已更新 Key 名称' } }));
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setStatusMsg((s) => ({ ...s, [providerId]: { ok: false, msg } }));
    }
  }

  async function handleActivateKey(providerId: string, index: number) {
    setStatusMsg((s) => ({ ...s, [providerId]: { ok: false, msg: '' } }));
    try {
      await providerKeys.activate.mutateAsync({ providerId, keyIndex: index });
      setStatusMsg((s) => ({ ...s, [providerId]: { ok: true, msg: '已切换激活 Key' } }));
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setStatusMsg((s) => ({ ...s, [providerId]: { ok: false, msg } }));
    }
  }

  async function handleRemoveKey(providerId: string, index: number) {
    const ok = await confirmDialog('确定删除该 API Key?');
    if (!ok) return;
    setStatusMsg((s) => ({ ...s, [providerId]: { ok: false, msg: '' } }));
    try {
      await providerKeys.remove.mutateAsync({ providerId, keyIndex: index });
      setStatusMsg((s) => ({ ...s, [providerId]: { ok: true, msg: '已删除 API Key' } }));
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setStatusMsg((s) => ({ ...s, [providerId]: { ok: false, msg } }));
    }
  }

  /** 创建自定义 provider;失败在表单下方内联提示。 */
  async function handleCreateProvider() {
    const id = newProvider.id.trim();
    if (!id) return;
    setProviderMsg(null);
    try {
      await providerCrud.create.mutateAsync({
        id,
        name: newProvider.name.trim() || undefined,
        providerType: newProvider.type || undefined,
        baseUrl: newProvider.baseUrl.trim() || undefined,
        apiKey: newProvider.apiKey.trim() || undefined,
      });
      setNewProvider({ id: '', name: '', type: 'openai-compat', baseUrl: '', apiKey: '' });
      setShowAddProvider(false);
      setProviderMsg({ ok: true, msg: `Provider「${id}」已创建` });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setProviderMsg({ ok: false, msg });
    }
  }

  /** 删除自定义 provider(连同其全部 Key 与模型缓存),失败时展开该行提示。 */
  async function handleRemoveProvider(p: { id: string; name?: string }) {
    const ok = await confirmDialog(
      `确定删除 Provider「${p.name ?? p.id}」?其全部 API Key 与模型缓存将一并删除。`,
    );
    if (!ok) return;
    setStatusMsg((s) => ({ ...s, [p.id]: { ok: false, msg: '' } }));
    try {
      await providerCrud.remove.mutateAsync({ providerId: p.id });
      setExpanded((prev) => ({ ...prev, [p.id]: false }));
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setExpanded((prev) => ({ ...prev, [p.id]: true }));
      setStatusMsg((s) => ({ ...s, [p.id]: { ok: false, msg } }));
    }
  }

  const list = providers ?? [];
  const providerBusy = providerCrud.create.isPending || providerCrud.remove.isPending;
  const inputCls =
    'h-7 w-full rounded-lg border border-input-border bg-input px-2 text-[12px] text-foreground outline-none placeholder:text-foreground-subtlest focus:border-input-border-focused';

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <label className="text-[13px] font-medium text-foreground">模型 Provider</label>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 gap-1 px-2 text-[12px]"
          onClick={() => {
            setShowAddProvider((v) => !v);
            setProviderMsg(null);
          }}
        >
          <Plus className="size-3" />
          添加 Provider
        </Button>
      </div>
      {/* 新增自定义 provider 表单 */}
      {showAddProvider && (
        <div className="flex flex-col gap-1.5 rounded-lg border border-input-border bg-background px-2.5 py-2">
          <div className="grid grid-cols-2 gap-1">
            <input
              type="text"
              value={newProvider.id}
              onChange={(e) => setNewProvider((s) => ({ ...s, id: e.target.value }))}
              placeholder="ID(必填,如 my-relay)"
              className={inputCls}
            />
            <input
              type="text"
              value={newProvider.name}
              onChange={(e) => setNewProvider((s) => ({ ...s, name: e.target.value }))}
              placeholder="显示名称(可选)"
              className={inputCls}
            />
            <select
              value={newProvider.type}
              onChange={(e) => setNewProvider((s) => ({ ...s, type: e.target.value }))}
              aria-label="Provider 类型"
              className={`${inputCls} [color-scheme:dark]`}
            >
              <option value="openai-compat">OpenAI 兼容</option>
              <option value="openai">OpenAI</option>
              <option value="anthropic">Anthropic</option>
              <option value="google">Google Gemini</option>
              <option value="azure">Azure</option>
            </select>
            <input
              type="text"
              value={newProvider.baseUrl}
              onChange={(e) => setNewProvider((s) => ({ ...s, baseUrl: e.target.value }))}
              placeholder="Base URL(可选,如 https://api.example.com/v1)"
              className={inputCls}
            />
          </div>
          <input
            type="password"
            value={newProvider.apiKey}
            onChange={(e) => setNewProvider((s) => ({ ...s, apiKey: e.target.value }))}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !providerBusy && newProvider.id.trim()) {
                e.preventDefault();
                void handleCreateProvider();
              }
            }}
            placeholder="API Key(可选,创建后也可在列表中添加)"
            className={inputCls}
          />
          <div className="flex items-center gap-1">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 px-2 text-[12px]"
              onClick={() => setShowAddProvider(false)}
            >
              取消
            </Button>
            <Button
              type="button"
              size="sm"
              className="h-7 gap-1 px-2 text-[12px]"
              disabled={providerBusy || !newProvider.id.trim()}
              onClick={() => void handleCreateProvider()}
            >
              {providerCrud.create.isPending ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <Plus className="size-3" />
              )}
              创建
            </Button>
          </div>
        </div>
      )}
      {providerMsg?.msg && (
        <div className={`text-[11px] ${providerMsg.ok ? 'text-brand' : 'text-destructive'}`}>
          {providerMsg.msg}
        </div>
      )}
      <div className="flex flex-col gap-1.5">
        {list.map((p) => {
          const modelCount = Array.isArray(p.models) ? p.models.length : 0;
          const isExpanded = expanded[p.id] ?? false;
          const st = statusMsg[p.id];
          const busy = fetchModels.isPending || saveProviderKey.isPending || providerKeys.add.isPending || providerKeys.activate.isPending || providerKeys.rename.isPending || providerKeys.remove.isPending || providerCrud.create.isPending || providerCrud.remove.isPending;
          const hasKey = !!p.has_api_key;
          const typedKey = (keyInputs[p.id] ?? '').trim();
          const canFetch = hasKey || typedKey.length > 0;
          return (
            <div key={p.id} className="rounded-lg border border-input-border bg-background">
              <div className="flex items-center gap-1 pr-2">
                <button
                  type="button"
                  onClick={() => setExpanded((prev) => ({ ...prev, [p.id]: !isExpanded }))}
                  className="flex min-w-0 flex-1 items-center justify-between px-2.5 py-1.5 text-left"
                >
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate text-[13px] font-medium text-foreground">
                      {p.name ?? p.id}
                    </span>
                    {p.custom && (
                      <span className="shrink-0 rounded bg-surface-hover px-1.5 py-0.5 text-[10px] text-foreground-subtle">
                        自定义
                      </span>
                    )}
                    <span
                      className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] ${
                        hasKey ? 'bg-brand/10 text-brand' : 'bg-surface-hover text-foreground-subtle'
                      }`}
                    >
                      {modelCount > 0 ? `${modelCount} 个模型` : hasKey ? '已配置 Key' : '未配置'}
                    </span>
                  </span>
                  <ChevronDown
                    className={`size-3.5 shrink-0 text-foreground-subtle transition-transform ${isExpanded ? 'rotate-180' : ''}`}
                  />
                </button>
                {p.custom && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void handleRemoveProvider(p)}
                    aria-label="删除 Provider"
                    title="删除该自定义 Provider(连同全部 Key 与模型缓存)"
                    className="inline-flex shrink-0 items-center rounded p-1 text-foreground-subtlest hover:bg-surface-hover hover:text-destructive disabled:opacity-50"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                )}
              </div>
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
                  {/* 已保存的多 key 列表:脱敏展示(可带名称),支持「使用」切换 / 重命名 / 删除 */}
                  {(p.api_keys_masked?.length ?? 0) > 0 && (
                    <div className="flex flex-col gap-1">
                      {p.api_keys_masked!.map((k, i) => {
                        const isActive = i === (p.active_key_index ?? -1);
                        const masked = k.masked || '****';
                        const name = k.name ?? '';
                        const isRenaming = renaming?.providerId === p.id && renaming.keyIndex === i;
                        return (
                          <div
                            key={`${masked}-${i}`}
                            className={cn(
                              'flex items-center gap-1.5 text-[11px]',
                              isActive && 'text-brand',
                            )}
                          >
                            {isRenaming ? (
                              <input
                                autoFocus
                                value={renameDraft}
                                onChange={(e) => setRenameDraft(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') {
                                    e.preventDefault();
                                    void commitRename(p.id, i);
                                  }
                                  if (e.key === 'Escape') setRenaming(null);
                                }}
                                onBlur={() => setRenaming(null)}
                                placeholder="Key 名称(留空清除)"
                                className="h-6 min-w-0 flex-1 rounded border border-input-border bg-input px-1.5 text-[11px] text-foreground outline-none placeholder:text-foreground-subtlest focus:border-input-border-focused"
                              />
                            ) : (
                              <span className="min-w-0 flex-1 truncate" title={masked}>
                                {name ? (
                                  <>
                                    <span className={isActive ? 'text-brand' : 'text-foreground'}>
                                      {name}
                                    </span>
                                    <span
                                      className={cn(
                                        'ml-1.5 font-mono',
                                        isActive ? 'text-brand/80' : 'text-foreground-subtlest',
                                      )}
                                    >
                                      {masked}
                                    </span>
                                  </>
                                ) : (
                                  <span className="font-mono text-foreground-subtle">{masked}</span>
                                )}
                              </span>
                            )}
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => startRename(p.id, i, name)}
                              title={name ? '重命名' : '添加名称'}
                              className="inline-flex shrink-0 items-center rounded p-0.5 text-foreground-subtlest hover:bg-surface-hover hover:text-foreground disabled:opacity-50"
                            >
                              <Pencil className="size-3" />
                            </button>
                            {isActive ? (
                              <span className="inline-flex shrink-0 items-center gap-0.5 rounded bg-brand/10 px-1 py-0.5 text-[10px] font-medium text-brand">
                                <Check className="size-3" />
                                使用中
                              </span>
                            ) : (
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() => handleActivateKey(p.id, i)}
                                className="inline-flex shrink-0 items-center gap-0.5 rounded px-1 py-0.5 text-[11px] text-foreground-subtle hover:bg-surface-hover hover:text-foreground disabled:opacity-50"
                              >
                                <Check className="size-3" />
                                使用
                              </button>
                            )}
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => handleRemoveKey(p.id, i)}
                              className="inline-flex shrink-0 items-center gap-0.5 rounded px-1 py-0.5 text-[11px] text-destructive hover:bg-surface-hover disabled:opacity-50"
                            >
                              <Trash2 className="size-3" />
                              删除
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                  {/* 仅环境变量/内置 key(不在列表中):提示添加后可切换 */}
                  {hasKey && !typedKey && (p.api_keys_masked?.length ?? 0) === 0 && (
                    <div className="text-[11px] text-foreground-subtle">
                      当前 Key:
                      <span className="font-mono text-foreground">{p.api_key_masked || '****'}</span>
                      (环境变量/内置,添加 Key 后可切换)
                    </div>
                  )}
                  {/* Key 名称 + Key 同一行:名称选填便于记忆,回车即添加 */}
                  <div className="flex items-center gap-1">
                    <input
                      type="text"
                      value={nameInputs[p.id] ?? ''}
                      onChange={(e) =>
                        setNameInputs((prev) => ({ ...prev, [p.id]: e.target.value }))
                      }
                      title="Key 名称,方便记忆,如:工作/测试"
                      placeholder="Key 名称(可选)"
                      className="h-7 w-32 shrink-0 rounded-lg border border-input-border bg-input px-2 text-[12px] text-foreground outline-none placeholder:text-foreground-subtlest focus:border-input-border-focused"
                    />
                    <input
                      type="password"
                      value={keyInputs[p.id] ?? ''}
                      onChange={(e) =>
                        setKeyInputs((prev) => ({ ...prev, [p.id]: e.target.value }))
                      }
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !busy && typedKey) {
                          e.preventDefault();
                          void handleAddKey(p.id);
                        }
                      }}
                      placeholder={hasKey ? '输入新 API Key(拉取模型或仅添加保存)' : '输入 API Key...'}
                      className="h-7 min-w-0 flex-1 rounded-lg border border-input-border bg-input px-2 text-[12px] text-foreground outline-none placeholder:text-foreground-subtlest focus:border-input-border-focused"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={busy || !typedKey}
                      onClick={() => void handleAddKey(p.id)}
                      className="h-7 shrink-0 gap-1 rounded-lg px-2 text-[12px]"
                      title="仅保存 Key,不拉取模型"
                    >
                      {providerKeys.add.isPending ? (
                        <Loader2 className="size-3 animate-spin" />
                      ) : (
                        <Plus className="size-3" />
                      )}
                      添加
                    </Button>
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
        每个 Provider 可保存多个 API Key:同一行填写「名称(可选)+ Key」,点「添加」仅保存,
        点「拉取模型」保存并同步模型列表(已配置 Key 可直接拉取);铅笔可命名/改名,点
        「使用」切换激活 Key,点「删除」移除。右上角可添加自定义 Provider
        (OpenAI 兼容中转等),自定义 Provider 可整项删除,内置 Provider 不可删除。
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

/** ---------- 语音识别(ASR)模型设置区 ---------- */

/** 可选的本地语音识别模型(与后端 AsrModel 一致)。 */
const ASR_MODELS = [
  {
    id: 'sense-voice',
    label: 'SenseVoice · 中文',
    desc: '中英日韩粤多语,自带标点与数字规整,约 230MB',
  },
  {
    id: 'moonshine-zh',
    label: 'Moonshine · 中文',
    desc: 'Moonshine v2 中英双语,约 135MB',
  },
  {
    id: 'moonshine-en',
    label: 'Moonshine · 英文',
    desc: 'Moonshine v2 英文,约 135MB',
  },
] as const;

/**
 * 选择语音输入的本地识别模型:POST /v1/transcribe/model 即时切换并写入
 * 配置 `[asr] model`,跨重启保留;切换后回到未就绪,首次使用自动下载。
 */
function AsrModelSection({ open }: { open: boolean }) {
  const { data: status } = useQuery({
    queryKey: ['asr-model-status'],
    queryFn: getTranscribeStatus,
    enabled: open,
  });
  const [current, setCurrent] = useState<string>('sense-voice');
  const [error, setError] = useState('');
  const switchModel = useMutation({
    mutationFn: (model: string) => setTranscribeModel(model),
    onSuccess: (_d, model) => {
      setCurrent(model);
      setError('');
    },
    onError: (e) => setError(e instanceof Error ? e.message : '切换失败'),
  });

  // 后端状态返回后同步当前模型(覆盖本地默认值)
  useEffect(() => {
    if (status?.model) setCurrent(status.model);
  }, [status?.model]);

  const desc = ASR_MODELS.find((m) => m.id === current)?.desc;
  const selectCls =
    'h-9 w-full rounded-lg border border-input-border bg-background px-2.5 text-[13px] text-foreground outline-none [color-scheme:dark] focus-visible:border-input-border-focused disabled:opacity-50';

  return (
    <div className="flex flex-col gap-2">
      <label className="text-[13px] font-medium text-foreground">语音识别模型</label>
      <select
        value={current}
        disabled={switchModel.isPending}
        onChange={(e) => switchModel.mutate(e.target.value)}
        className={selectCls}
        aria-label="选择语音识别模型"
      >
        {ASR_MODELS.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label}
          </option>
        ))}
      </select>
      <div className="text-[12px] text-foreground-subtle">
        {desc}。切换即时生效并跨重启保留;新模型首次使用时自动下载,输入框语音输入即触发。
      </div>
      {error && <div className="text-[12px] text-destructive">{error}</div>}
    </div>
  );
}

/** ---------- 语音合成(TTS)设置区 ---------- */

/** 可选的本地语音合成模型(与后端 TtsModel 一致)。 */
const TTS_MODELS = [
  {
    id: 'piper-zh-xiaoya',
    label: 'Piper 小雅 · 中文女声',
    desc: 'piper 中文女声(int8),约 14MB,清晰自然',
  },
  {
    id: 'piper-zh-chaowen',
    label: 'Piper 超闻 · 中文男声',
    desc: 'piper 中文男声(int8),约 14MB',
  },
  {
    id: 'vits-zh-fanchen-c',
    label: 'VITS 凡尘-C · 高质量女声',
    desc: 'HF 高质量中文女声,约 113MB,音色更细腻',
  },
] as const;

/**
 * 语音朗读设置:开关 + 模型选择。开关经 POST /v1/speech/config 写入配置
 * `[tts] enabled`,模型经 POST /v1/speech/model 即时切换并写入 `[tts] model`,
 * 均跨重启保留;新模型首次使用时自动下载。
 */
function TtsSection({ open }: { open: boolean }) {
  const qc = useQueryClient();
  const { data: status } = useQuery({
    queryKey: ['tts-status'],
    queryFn: getSpeechStatus,
    enabled: open,
    // 下载/加载进行中持续轮询,展示实时进度;就绪后停止
    refetchInterval: open
      ? (q) => {
          const st = q.state.data as Api.SpeechStatus | undefined;
          return st && (st.phase === 'downloading' || st.phase === 'loading') ? 1000 : false;
        }
      : false,
  });
  const [current, setCurrent] = useState<string>('piper-zh-xiaoya');
  const [error, setError] = useState('');
  /** 朗读语速倍率(0.5~2.0);滑块拖动本地即时更新,松手提交。 */
  const [speed, setSpeed] = useState(1);
  const toggleEnabled = useMutation({
    mutationFn: (on: boolean) => setSpeechEnabled(on),
    onSuccess: () => {
      // 朗读 hook 监听同一查询,关闭后立即停读
      void qc.invalidateQueries({ queryKey: ['tts-status'] });
      setError('');
    },
    onError: (e) => setError(e instanceof Error ? e.message : '保存失败'),
  });
  const switchModel = useMutation({
    mutationFn: (model: string) => setSpeechModel(model),
    onSuccess: (_d, model) => {
      setCurrent(model);
      setError('');
    },
    onError: (e) => setError(e instanceof Error ? e.message : '切换失败'),
  });
  /** 手动触发模型下载/加载(幂等;后台执行,轮询状态展示进度)。 */
  const prepare = useMutation({
    mutationFn: () => prepareSpeech(),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['tts-status'] }),
    onError: (e) => setError(e instanceof Error ? e.message : '下载触发失败'),
  });
  /** 设置朗读语速倍率(POST /v1/speech/speed,写入 `[tts] speed`)。 */
  const setSpeedMut = useMutation({
    mutationFn: (v: number) => setSpeechSpeed(v),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['tts-status'] });
      setError('');
    },
    onError: (e) => setError(e instanceof Error ? e.message : '保存失败'),
  });

  // 后端状态返回后同步当前模型与语速(覆盖本地默认值)
  useEffect(() => {
    if (status?.model) setCurrent(status.model);
  }, [status?.model]);
  useEffect(() => {
    if (typeof status?.speed === 'number') setSpeed(status.speed);
  }, [status?.speed]);

  const desc = TTS_MODELS.find((m) => m.id === current)?.desc;
  const selectCls =
    'h-9 w-full rounded-lg border border-input-border bg-background px-2.5 text-[13px] text-foreground outline-none [color-scheme:dark] focus-visible:border-input-border-focused disabled:opacity-50';

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <div className="flex flex-col gap-0.5">
          <label className="text-[13px] font-medium text-foreground">语音朗读</label>
          <span className="text-[12px] text-foreground-subtle">
            打开后自动朗读 agent 的回复(流式按句朗读;发送新消息或切换会话即停)
          </span>
        </div>
        <Switch
          checked={status?.enabled ?? false}
          onCheckedChange={(on) => toggleEnabled.mutate(on)}
          disabled={toggleEnabled.isPending}
          aria-label="语音朗读"
        />
      </div>
      <select
        value={current}
        disabled={switchModel.isPending}
        onChange={(e) => switchModel.mutate(e.target.value)}
        className={selectCls}
        aria-label="选择语音朗读模型"
      >
        {TTS_MODELS.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label}
          </option>
        ))}
      </select>
      {/* 朗读语速(0.5x~2.0x,滑块拖动实时预览,松手保存) */}
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between">
          <label className="text-[13px] font-medium text-foreground">朗读语速</label>
          <span className="text-[12px] tabular-nums text-foreground-subtle">
            {speed.toFixed(1)}x
          </span>
        </div>
        <input
          type="range"
          min={0.5}
          max={2}
          step={0.1}
          value={speed}
          onChange={(e) => setSpeed(Number(e.target.value))}
          onMouseUp={() => setSpeedMut.mutate(speed)}
          onTouchEnd={() => setSpeedMut.mutate(speed)}
          onKeyUp={() => setSpeedMut.mutate(speed)}
          className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-surface-hover accent-brand"
          aria-label="朗读语速"
        />
        <div className="flex justify-between text-[10px] text-foreground-subtle">
          <span>0.5x 慢</span>
          <span>2.0x 快</span>
        </div>
      </div>
      <div className="text-[12px] text-foreground-subtle">
        {desc}。切换即时生效并跨重启保留;新模型首次使用时自动下载,也可点下方按钮提前下载。
      </div>
      {status && !status.ready && (
        <div className="flex items-center gap-2">
          {status.phase === 'downloading' && typeof status.progress === 'number' ? (
            <>
              <div className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-surface-hover">
                <div
                  className="h-full rounded-full bg-brand"
                  style={{ width: `${Math.round(status.progress * 100)}%` }}
                />
              </div>
              <span className="shrink-0 text-[11px] tabular-nums text-foreground-subtle">
                模型下载 {Math.round(status.progress * 100)}%
              </span>
            </>
          ) : status.phase === 'failed' ? (
            <span className="shrink-0 text-[11px] text-destructive">
              模型下载失败:{status.error ?? '请重试'}
            </span>
          ) : (
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-[12px]"
              onClick={() => prepare.mutate()}
              disabled={prepare.isPending}
            >
              {prepare.isPending
                ? '准备中…'
                : status.phase === 'loading'
                  ? '模型加载中…'
                  : '立即下载'}
            </Button>
          )}
        </div>
      )}
      {error && <div className="text-[12px] text-destructive">{error}</div>}
    </div>
  );
}

/**
 * 按模型手动设置上下文窗口上限(token 数),写入 combo-cli 配置
 * (POST /v1/providers/context-window,持久化到 `[providers.<id>].context_windows`)。
 * 压缩触发阈值与 Composer 用量环共用后端解析出的同一份有效值,前后端
 * 不再各存一份(旧版前端本地覆盖会导致「显示未满却频繁触发压缩」)。
 * 输入留空 + 保存 = 恢复默认;未修改任何字段时点保存不生效。
 */
const ContextWindowSection = forwardRef<
  { commit: () => void },
  { open: boolean }
>(function ContextWindowSection({ open }, ref) {
  const { data: providers } = useProviders(null);
  const { mutate: saveContextWindow, isPending } = useSetModelContextWindow();

  const [providerId, setProviderId] = useState('');
  const [modelId, setModelId] = useState('');
  const [tokenInput, setTokenInput] = useState('');
  // 用户是否改动过输入(区分「没改」与「主动清空」,避免误清除已有配置)
  const dirtyRef = useRef(false);

  // 打开时初始化:默认选中第一个 provider 及其默认/首个模型。
  // providerId 非空说明已初始化过(providers 异步加载完成后),不再覆盖用户选择。
  useEffect(() => {
    if (!open || providerId) return;
    const p = (providers ?? [])[0];
    if (!p) return;
    setProviderId(p.id);
    setModelId(defaultModelOf(p));
    dirtyRef.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, providers, providerId]);

  // 回填某模型当前生效的窗口值(后端已合并手动覆盖)
  const refillEffective = (pid: string, mid: string) => {
    const p = (providers ?? []).find((pp) => pp.id === pid);
    const m = (p?.models ?? []).find((mm) => mm.id === mid);
    setTokenInput(typeof m?.context_window === 'number' ? String(m.context_window) : '');
  };

  // 切换 provider/model:回填该模型生效值并重置未修改标记
  useEffect(() => {
    if (!modelId) return;
    refillEffective(providerId, modelId);
    dirtyRef.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providerId, modelId]);

  // providers 数据刷新(保存后失效重取):用户未编辑输入时同步最新生效值,
  // 编辑中(dirty)不覆盖
  useEffect(() => {
    if (!modelId || dirtyRef.current) return;
    refillEffective(providerId, modelId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providers]);

  const provider = providers?.find((p) => p.id === providerId);
  const models = (provider && Array.isArray(provider.models) ? provider.models : []) as {
    id?: string;
    name?: string;
    context_window?: number;
    /** 手动覆盖的原始值(后端返回;null = 未覆盖,前端据此显示清除入口)。 */
    context_window_override?: number | null;
  }[];
  const model = models.find((m) => m.id === modelId);
  const effectiveWindow = typeof model?.context_window === 'number' ? model.context_window : undefined;
  const hasOverride = model?.context_window_override != null;

  useImperativeHandle(
    ref,
    () => ({
      commit() {
        if (!providerId || !modelId || !dirtyRef.current) return;
        dirtyRef.current = false;
        const t = tokenInput.trim();
        const n = Number(t);
        if (t === '' || !Number.isFinite(n) || n <= 0) {
          // 留空 = 清除后端覆盖、恢复默认
          saveContextWindow({ providerId, modelId });
          return;
        }
        saveContextWindow({ providerId, modelId, contextWindow: Math.round(n) });
      },
    }),
    [providerId, modelId, tokenInput, saveContextWindow],
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
        {(hasOverride || isPending) && (
          <span
            className={cn(
              'shrink-0 text-[11px] text-foreground-subtlest',
              isPending && 'animate-pulse',
            )}
          >
            {isPending ? '保存中…' : '已手动设置'}
          </span>
        )}
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
        {effectiveWindow != null && (
          <span className="text-[11px] text-foreground-subtlest">
            {hasOverride ? '已手动覆盖' : '默认'} {formatTokenCount(effectiveWindow)}
          </span>
        )}
      </div>
      <div className="text-[12px] text-foreground-subtle">
        写入 combo-cli 配置并即时生效:上下文压缩阈值与用量环共用该值,
        前后端不再各存一份;输入框留空并保存即恢复默认。
      </div>
    </div>
  );
});
