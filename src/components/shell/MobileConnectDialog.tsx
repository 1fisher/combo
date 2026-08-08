import { useCallback, useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { Check, Copy, KeyRound, RefreshCw, Smartphone, Wifi } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '../ui/dialog';
import { Button } from '../ui/button';
import { cn } from '../../lib/utils';
import { getExternalUrl, getProxyBaseUrl } from '../../lib/connection';
import { createAccessToken, revokeAccessToken, type CreatedToken } from '../../lib/api';

interface MobileConnectDialogProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}

export function MobileConnectDialog({ open, onOpenChange }: MobileConnectDialogProps) {
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [copied, setCopied] = useState(false);
  const [tokenInfo, setTokenInfo] = useState<CreatedToken | null>(null);
  const [loading, setLoading] = useState(false);
  // ref 持有当前令牌,供 generateToken 撤销旧令牌时读取,
  // 避免 useCallback 依赖 tokenInfo 导致与 useEffect 形成无限循环。
  const tokenRef = useRef<CreatedToken | null>(null);

  // 二维码基础地址:优先使用配置的外部域名,否则回退到当前页面地址
  const externalUrl = typeof window !== 'undefined' ? getExternalUrl() : null;
  const pageUrl = (() => {
    if (typeof window === 'undefined') return '';
    if (externalUrl) return externalUrl.replace(/\/$/, '');
    const { protocol, hostname, port, pathname } = window.location;
    return `${protocol}//${hostname}:${port}${pathname}`;
  })();

  const isLocalhost =
    typeof window !== 'undefined' &&
    !externalUrl &&
    (window.location.hostname === 'localhost' ||
      window.location.hostname === '127.0.0.1');

  const proxyUrl = typeof window !== 'undefined' ? getProxyBaseUrl() : '';

  // 扫码后移动端打开的地址:页面 URL + token 参数
  const mobileUrl = tokenInfo ? `${pageUrl}?token=${encodeURIComponent(tokenInfo.token)}` : '';

  const generateToken = useCallback(async () => {
    setLoading(true);
    try {
      // 刷新时先撤销上一枚令牌,避免令牌堆积
      if (tokenRef.current) {
        void revokeAccessToken(tokenRef.current.token).catch(() => {});
      }
      const t = await createAccessToken('移动端扫码');
      tokenRef.current = t;
      setTokenInfo(t);
    } catch {
      tokenRef.current = null;
      setTokenInfo(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) {
      tokenRef.current = null;
      setTokenInfo(null);
      setQrDataUrl('');
      return;
    }
    void generateToken();
  }, [open, generateToken]);

  useEffect(() => {
    if (!open || !mobileUrl) {
      setQrDataUrl('');
      return;
    }
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
    if (!mobileUrl) return;
    navigator.clipboard?.writeText(mobileUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  function fmtExpiry(expiresAt: number | null): string {
    if (!expiresAt) return '永久';
    const days = Math.max(0, Math.round((expiresAt * 1000 - Date.now()) / 86_400_000));
    return days > 0 ? `${days} 天后过期` : '已过期';
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
            扫描二维码,在手机上打开 combo 进行远程操作。每次生成独立访问令牌,校验通过后方可连接。
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
                {loading ? '生成中…' : '等待令牌'}
              </div>
            )}
          </div>

          {/* 令牌信息 */}
          {tokenInfo && (
            <div className="flex w-full items-center justify-between rounded-lg border border-border bg-surface-hover px-3 py-2 text-[12px]">
              <span className="flex items-center gap-1.5 text-foreground-subtle">
                <KeyRound className="size-3.5 text-brand" />
                访问令牌 · {fmtExpiry(tokenInfo.expires_at)}
              </span>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 gap-1 px-1.5 text-[12px] text-foreground-subtle"
                onClick={() => void generateToken()}
                disabled={loading}
                title="重新生成令牌"
              >
                <RefreshCw className={cn('size-3', loading && 'animate-spin')} />
                刷新
              </Button>
            </div>
          )}

          {/* 访问地址 */}
          <div className="w-full">
            <div className="mb-1.5 flex items-center gap-1.5 text-[12px] font-medium text-foreground-subtle">
              <Wifi className="size-3.5" />
              访问地址
            </div>
            <div className="flex items-center gap-1.5">
              <code className="min-w-0 flex-1 truncate rounded-lg bg-surface-hover px-2.5 py-1.5 text-[12px] text-foreground">
                {mobileUrl || '生成中…'}
              </code>
              <Button
                variant="outline"
                size="icon-sm"
                onClick={copyUrl}
                aria-label="复制地址"
                title="复制地址"
                className="shrink-0"
                disabled={!mobileUrl}
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
          {externalUrl && (
            <div className="w-full rounded-lg border border-success/30 bg-success/5 px-3 py-2 text-[12px] leading-relaxed text-foreground-subtle">
              <p className="font-medium text-success">已配置外部域名</p>
              <p className="mt-0.5">
                扫码后将通过{' '}
                <code className="break-all text-foreground">{externalUrl}</code>{' '}
                访问,手机无需额外配置代理地址。
              </p>
            </div>
          )}
          {!externalUrl && isLocalhost && (
            <div className="w-full rounded-lg border border-warning/30 bg-warning/5 px-3 py-2 text-[12px] leading-relaxed text-foreground-subtle">
              <p className="font-medium text-warning">当前使用 localhost 访问</p>
              <p className="mt-0.5">
                手机需与电脑在同一局域网。请将上方地址中的{' '}
                <code className="text-foreground">localhost</code> 替换为电脑的局域网
                IP(如 192.168.x.x),并在手机「设置」中填入代理地址{' '}
                <code className="break-all text-foreground">
                  {proxyUrl.replace('127.0.0.1', '电脑IP')}
                </code>
                。配置外部域名后可免此限制。
              </p>
            </div>
          )}
          {!externalUrl && !isLocalhost && (
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
