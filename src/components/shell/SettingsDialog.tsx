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
  clearProxyUrlOverride,
  getProxyBaseUrl,
  getProxyUrlOverride,
  isTauri,
  setProxyUrlOverride,
} from '../../lib/connection';

interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * 设置对话框:前后端分离部署时,允许运行时指定 combo-proxy 服务地址
 * (浏览器/移动端访问远端服务器上的代理)。覆盖保存在 localStorage。
 */
export function SettingsDialog({ open, onOpenChange }: SettingsDialogProps) {
  const [input, setInput] = useState('');
  const [hasOverride, setHasOverride] = useState(false);

  useEffect(() => {
    if (open) {
      const ov = getProxyUrlOverride();
      setHasOverride(ov !== null);
      setInput(ov ?? getProxyBaseUrl());
    }
  }, [open]);

  function save() {
    const v = input.trim();
    if (!v) return;
    setProxyUrlOverride(v);
    onOpenChange(false);
  }

  function reset() {
    clearProxyUrlOverride();
    setHasOverride(false);
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>设置</DialogTitle>
          <DialogDescription>
            前后端分离部署时,在此填写 combo-proxy 服务地址(服务器上运行的代理,例如
            http://192.168.1.10:18234)。保存后立即生效并存储在本地浏览器。
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
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
        <DialogFooter>
          {hasOverride && (
            <Button variant="ghost" onClick={reset}>
              恢复默认
            </Button>
          )}
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button onClick={save} disabled={!input.trim() || isTauri()}>
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
