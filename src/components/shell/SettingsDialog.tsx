import { useEffect, useState } from 'react';
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
              placeholder="https://combo.example.com"
              className="h-9 w-full rounded-lg border border-input-border bg-background px-2.5 text-[13px] outline-none placeholder:text-foreground-subtlest focus-visible:border-input-border-focused"
            />
            <div className="text-[12px] text-foreground-subtle">
              {hasDomain
                ? '已配置域名,移动端扫码将使用此地址连接'
                : '域名部署时填写;留空则使用当前页面地址(仅限局域网)'}
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
