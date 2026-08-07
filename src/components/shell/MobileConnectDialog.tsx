import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { Check, Copy, Smartphone, Wifi } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '../ui/dialog';
import { Button } from '../ui/button';
import { getProxyBaseUrl } from '../../lib/connection';

interface MobileConnectDialogProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}

export function MobileConnectDialog({ open, onOpenChange }: MobileConnectDialogProps) {
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [copied, setCopied] = useState(false);

  // 构建移动端访问地址:把 localhost 替换为局域网 IP
  const mobileUrl = (() => {
    if (typeof window === 'undefined') return '';
    const { protocol, hostname, port, pathname } = window.location;
    // 如果是 localhost / 127.0.0.1,给出提示(需要用 IP)
    return `${protocol}//${hostname}:${port}${pathname}`;
  })();

  const isLocalhost =
    typeof window !== 'undefined' &&
    (window.location.hostname === 'localhost' ||
      window.location.hostname === '127.0.0.1');

  const proxyUrl = typeof window !== 'undefined' ? getProxyBaseUrl() : '';

  useEffect(() => {
    if (!open || !mobileUrl) return;
    QRCode.toDataURL(mobileUrl, {
      width: 240,
      margin: 1,
      color: { dark: '#0a0a0a', light: '#ffffff' },
      errorCorrectionLevel: 'M',
    })
      .then(setQrDataUrl)
      .catch(() => setQrDataUrl(''));
  }, [open, mobileUrl]);

  function copyUrl() {
    navigator.clipboard?.writeText(mobileUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false} className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-[16px]">
            <Smartphone className="size-4 text-brand" />
            移动端远程控制
          </DialogTitle>
          <DialogDescription className="text-[13px]">
            扫描二维码,在手机上打开 combo 进行远程操作。
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col items-center gap-4">
          {/* QR 码 */}
          <div className="rounded-2xl border border-border bg-white p-3">
            {qrDataUrl ? (
              <img
                src={qrDataUrl}
                alt="移动端访问二维码"
                className="size-52 rounded-lg"
                width={208}
                height={208}
              />
            ) : (
              <div className="flex size-52 items-center justify-center text-[13px] text-foreground-subtle">
                生成中…
              </div>
            )}
          </div>

          {/* 访问地址 */}
          <div className="w-full">
            <div className="mb-1.5 flex items-center gap-1.5 text-[12px] font-medium text-foreground-subtle">
              <Wifi className="size-3.5" />
              访问地址
            </div>
            <div className="flex items-center gap-1.5">
              <code className="min-w-0 flex-1 truncate rounded-lg bg-surface-hover px-2.5 py-1.5 text-[12px] text-foreground">
                {mobileUrl}
              </code>
              <Button
                variant="outline"
                size="icon-sm"
                onClick={copyUrl}
                aria-label="复制地址"
                title="复制地址"
                className="shrink-0"
              >
                {copied ? (
                  <Check className="size-3.5 text-success" />
                ) : (
                  <Copy className="size-3.5" />
                )}
              </Button>
            </div>
          </div>

          {/* 提示 */}
          {isLocalhost && (
            <div className="w-full rounded-lg border border-warning/30 bg-warning/5 px-3 py-2 text-[12px] leading-relaxed text-foreground-subtle">
              <p className="font-medium text-warning">当前使用 localhost 访问</p>
              <p className="mt-0.5">
                手机需与电脑在同一局域网。请将上方地址中的{' '}
                <code className="text-foreground">localhost</code> 替换为电脑的局域网
                IP(如 192.168.x.x),并在手机「设置」中填入代理地址{' '}
                <code className="break-all text-foreground">
                  {proxyUrl.replace('127.0.0.1', '电脑IP')}
                </code>
                。
              </p>
            </div>
          )}
          {!isLocalhost && (
            <div className="w-full rounded-lg border border-border bg-surface-hover px-3 py-2 text-[12px] leading-relaxed text-foreground-subtle">
              在手机上打开后,进入「设置」填入代理地址即可连接:
              <code className="mt-1 block break-all text-foreground">{proxyUrl}</code>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            关闭
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
