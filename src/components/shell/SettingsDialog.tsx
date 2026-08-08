import { useEffect, useState } from 'react';
import { CheckCircle2 } from 'lucide-react';
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

interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * 设置对话框:
 * 1. 外部访问域名 — 域名部署时填写公开访问地址(如 https://combo.example.com),
 *    二维码和远程连接会使用此地址。
 * 2. 代理地址 — 前后端分离部署时指定 combo-proxy 服务地址。
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
      <DialogContent showCloseButton={false} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>设置</DialogTitle>
          <DialogDescription>
            配置域名远程访问和代理服务地址。域名部署时,外部设备通过此域名访问 combo。
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          {/* 外部访问域名 */}
          <div className="flex flex-col gap-2">
            <label className="text-[13px] font-medium text-foreground">外部访问域名</label>
            <input
              value={domainInput}
              onChange={(e) => setDomainInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') save();
              }}
              placeholder="https://relay.example.com"
              className="h-9 w-full rounded-lg border border-input-border bg-background px-2.5 text-[13px] outline-none placeholder:text-foreground-subtlest focus-visible:border-input-border-focused"
            />
            <div className="text-[12px] text-foreground-subtle">
              {hasDomain
                ? '已配置自定义域名,移动端扫码将使用此地址连接'
                : '留空则使用默认中转域名(relay.example.com),扫码即可远程访问'}
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
