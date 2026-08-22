import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  Download,
  Loader2,
  RefreshCw,
  ScanLine,
  Smartphone,
  X,
} from 'lucide-react';
import { Button } from '../ui/button';
import { Tabs, TabsList, TabsTrigger } from '../ui/tabs';
import { startQrScan, type QrScanHandle } from '../../lib/qrScan';
import {
  parseConnectUrl,
  applyConnection,
  buildTargetUrl,
  rememberLastServer,
  getLastServer,
  type ConnectParams,
} from '../../lib/mobileConnect';
import { useInstallPrompt } from '../../hooks/useInstallPrompt';
import { isStandalonePwa } from '../../lib/pwa';
import { isNativeApp } from '../../lib/native';

interface MobileConnectScreenProps {
  onConnected: () => void;
}

type Mode = 'scan' | 'manual';

/**
 * 移动端连接设置屏:在「已安装/移动浏览器且未持有令牌」时展示。
 * 两种方式连接桌面端工作台:
 *  - 扫码连接:调用相机识别桌面端「移动端远程控制」二维码(内含 token/lan);
 *  - 手动配置:输入访问地址 + 访问令牌。
 * 连接成功的标准 = token 已持久化 + 目标地址 /v1/health 可达;之后进入工作台,
 * 由既有的 P2P/中转/局域网直连链路接管真实通信。
 */
export function MobileConnectScreen({ onConnected }: MobileConnectScreenProps) {
  const [mode, setMode] = useState<Mode>('scan');
  const [scanning, setScanning] = useState(true);
  const [scanError, setScanError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [manualServer, setManualServer] = useState<string>(() => getLastServer() ?? '');
  const [manualToken, setManualToken] = useState('');
  const videoRef = useRef<HTMLVideoElement>(null);
  const scanRef = useRef<QrScanHandle | null>(null);
  const { canInstall, isStandalone, install } = useInstallPrompt();

  const stopScan = useCallback(() => {
    scanRef.current?.stop();
    scanRef.current = null;
    setScanning(false);
  }, []);

  const connect = useCallback(
    async (params: ConnectParams) => {
      setBusy(true);
      setError(null);
      stopScan();
      try {
        // 原生壳跳过健康预检:壳内 fetch 受 CORS/混合内容影响不可靠,且导航后
        // 的页面自身带完整连接态 UI,预检失败不应阻断进入。
        const native = isNativeApp();
        const r = await applyConnection(params, { verifyHealth: !native });
        if (!r.ok) {
          setError(r.error ?? '连接失败,请重试');
          return;
        }
        if (native) {
          // 原生壳:记住地址(下次启动预填)并整页导航到移动端页面
          rememberLastServer(params.server);
          window.location.href = buildTargetUrl(params);
          return;
        }
        onConnected();
      } finally {
        setBusy(false);
      }
    },
    [onConnected, stopScan],
  );

  const handleResult = useCallback(
    (text: string) => {
      const parsed = parseConnectUrl(text);
      if (!parsed) {
        setScanError('未能识别的二维码,请对准桌面端「移动端远程控制」里的二维码重试');
        return;
      }
      void connect(parsed);
    },
    [connect],
  );

  // 扫码模式的相机生命周期:进入 scan 启动,切走/卸载停止
  useEffect(() => {
    if (mode !== 'scan') {
      stopScan();
      return;
    }
    setScanError(null);
    setScanning(true);
    let active = true;
    (async () => {
      if (!videoRef.current) return;
      try {
        const handle = await startQrScan(videoRef.current, handleResult, {
          onError: (e) => {
            if (!active) return;
            const msg = e instanceof Error ? e.message : String(e);
            setScanError(`相机未就绪:${msg}`);
            setScanning(false);
          },
        });
        if (!active) {
          handle.stop();
          return;
        }
        scanRef.current = handle;
        setScanning(true);
      } catch {
        if (!active) return;
        setScanError('无法访问相机,请检查权限,或改用手动输入地址');
        setScanning(false);
      }
    })();
    return () => {
      active = false;
      stopScan();
    };
  }, [mode, handleResult, stopScan]);

  const doManual = useCallback(() => {
    const token = manualToken.trim();
    if (!token) {
      setError('请输入访问令牌(可从桌面端「移动端远程控制」的二维码获得)');
      return;
    }
    const serverInput = manualServer.trim();
    // 原生壳的 origin 是壳自身(http://localhost),不能作为默认连接地址
    if (!serverInput && isNativeApp()) {
      setError('请输入访问地址(中转域名或桌面局域网地址)');
      return;
    }
    const server = serverInput || window.location.origin;
    void connect({ server, token, lan: null });
  }, [manualServer, manualToken, connect]);

  return (
    <div className="flex h-dvh w-full flex-col items-center justify-center overflow-y-auto bg-background p-6 text-foreground">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center gap-3 text-center">
          <img src="/combo-icon.png" alt="Combo" className="size-16 rounded-2xl" />
          <div>
            <h1 className="text-xl font-semibold">连接你的 Combo 工作台</h1>
            <p className="mt-1 text-sm text-foreground-subtle">
              扫码或输入访问地址,远程使用桌面端的 Agent IDE 与项目。
            </p>
          </div>
        </div>

        {/* 安装引导:非独立模式时提示安装到主屏幕 */}
        {!isStandalone && (
          <div className="mt-5 flex items-center gap-2 rounded-xl border border-border bg-muted/40 px-3 py-2.5 text-xs text-foreground-subtle">
            <Smartphone className="size-4 shrink-0 text-brand" />
            {canInstall ? (
              <>
                <span className="flex-1">安装为独立 App,体验更佳</span>
                <Button variant="outline" size="sm" onClick={() => void install()}>
                  <Download className="size-3.5" /> 安装
                </Button>
              </>
            ) : (
              <span className="flex-1">
                点击浏览器菜单 → <b className="text-foreground">「添加到主屏幕」</b> 安装
              </span>
            )}
          </div>
        )}

        <Tabs value={mode} onValueChange={(v) => setMode(v as Mode)} className="mt-5">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="scan">扫码连接</TabsTrigger>
            <TabsTrigger value="manual">手动配置</TabsTrigger>
          </TabsList>
        </Tabs>

        {/* 扫码连接 */}
        {mode === 'scan' && (
          <div className="mt-4">
            <div className="relative aspect-square w-full overflow-hidden rounded-2xl border border-border bg-black">
              <video
                ref={videoRef}
                className="absolute inset-0 h-full w-full object-cover"
                playsInline
                muted
              />
              {/* 取景框 */}
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                <div className="relative size-[68%]">
                  <div className="absolute inset-0 rounded-2xl border-2 border-dashed border-white/50" />
                  <div className="absolute inset-x-0 top-1/2 h-8 -translate-y-1/2 bg-[linear-gradient(rgba(84,148,255,0.35)_0,rgba(84,148,255,0.35)_100%)] bg-[length:100%_2px] bg-no-repeat" />
                  <ScanLine className="absolute left-1/2 top-1/2 size-6 -translate-x-1/2 -translate-y-1/2 text-white/60" />
                </div>
              </div>
              {busy && (
                <div className="absolute inset-0 flex items-center justify-center bg-black/60">
                  <div className="flex items-center gap-2 text-sm text-white">
                    <Loader2 className="size-4 animate-spin" /> 正在连接…
                  </div>
                </div>
              )}
            </div>

            {scanError ? (
              <div className="mt-3 flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                <span className="flex-1">{scanError}</span>
              </div>
            ) : scanning ? (
              <p className="mt-3 text-center text-xs text-foreground-subtle">
                将桌面端「移动端远程控制」的二维码对准取景框
              </p>
            ) : (
              <div className="mt-3 flex justify-center gap-2">
                <Button variant="outline" size="sm" onClick={() => setMode('manual')}>
                  改用手动输入
                </Button>
                <Button variant="outline" size="sm" onClick={() => setMode('scan')}>
                  <RefreshCw className="size-3.5" /> 重试
                </Button>
              </div>
            )}
          </div>
        )}

        {/* 手动配置 */}
        {mode === 'manual' && (
          <div className="mt-4 space-y-3">
            <div>
              <label className="mb-1 block text-xs text-foreground-subtle">
                访问地址
                {!isNativeApp() && (
                  <span className="text-foreground-subtlest">(可选,留空用当前域名)</span>
                )}
              </label>
              <input
                value={manualServer}
                onChange={(e) => setManualServer(e.target.value)}
                placeholder="https://中转域名 或 http://192.168.x.x:18236"
                className="h-9 w-full rounded-lg border border-border bg-background-alt px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs text-foreground-subtle">
                访问令牌
                <span className="text-foreground-subtlest">(桌面端二维码内容中的 token)</span>
              </label>
              <input
                value={manualToken}
                onChange={(e) => setManualToken(e.target.value)}
                placeholder="粘贴 token(64 位字符串)"
                className="h-9 w-full rounded-lg border border-border bg-background-alt px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40"
              />
            </div>
            <Button className="w-full" size="lg" onClick={doManual} disabled={busy}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : <ArrowRight className="size-4" />}
              连接
            </Button>
          </div>
        )}

        {/* 通用错误 */}
        {error && (
          <div className="mt-4 flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            <span className="flex-1">{error}</span>
            <button onClick={() => setError(null)} aria-label="关闭" className="shrink-0">
              <X className="size-3.5" />
            </button>
          </div>
        )}

        <p className="mt-6 text-center text-[11px] leading-relaxed text-foreground-subtlest">
          二维码生成方式:在桌面端侧边栏点击
          <span className="text-foreground-subtle">「移动端远程控制」</span>,
          等待隧道建立后显示二维码。
          {isStandalonePwa() || isStandalone ? '' : '扫码后可点击「安装」以直接使用。'}
        </p>
      </div>
    </div>
  );
}
