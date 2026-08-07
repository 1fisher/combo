import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal as TerminalIcon, X } from 'lucide-react';
import { ensureProxyBaseUrl } from '../../lib/connection';
import { useWorkspaces } from '../../hooks/useWorkspaces';
import '@xterm/xterm/css/xterm.css';

function basename(p: string): string {
  const clean = p.replace(/[\\/]+$/, '');
  const idx = Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\'));
  return idx >= 0 ? clean.slice(idx + 1) : clean;
}

export function TerminalPanel({
  workspaceId,
  onClose,
}: {
  workspaceId: string | null;
  onClose: () => void;
}) {
  const { workspaces } = useWorkspaces();
  const ws = workspaces?.find((w) => w.id === workspaceId) ?? null;
  const wsName = ws ? (ws.name?.trim() ? ws.name : basename(ws.path)) : '默认目录';

  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new Terminal({
      fontFamily: "'Geist Mono', 'Menlo', 'Monaco', 'Courier New', monospace",
      fontSize: 13,
      cursorBlink: true,
      theme: {
        background: '#0d0d0d',
        foreground: '#e0e0e0',
        cursor: '#e0e0e0',
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(containerRef.current);
    fit.fit();
    termRef.current = term;

    // 构建 WebSocket URL:有 workspace 用项目目录,否则用默认终端(主目录)。
    // 代理地址可能尚未由 connectLoop 解析完成:等待就绪后再建连(见下方)。
    term.writeln(`\x1b[36m连接终端: ${wsName}\x1b[0m`);

    let socket: WebSocket | null = null;
    let cancelled = false;

    // 用户输入 → WS
    const dataDisposable = term.onData((data) => {
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(new TextEncoder().encode(data));
      }
    });

    // 尺寸变化 → WS
    const resizeDisposable = term.onResize(({ cols, rows }) => {
      if (socket && socket.readyState === WebSocket.OPEN) {
        sendResize(socket, cols, rows);
      }
    });

    // 窗口 resize 时重新 fit
    const onWindowResize = () => {
      fit.fit();
    };
    window.addEventListener('resize', onWindowResize);

    // 容器尺寸变化观察器
    const resizeObserver = new ResizeObserver(() => {
      fit.fit();
    });
    resizeObserver.observe(containerRef.current);

    // 代理地址可能尚未由 connectLoop 解析完成:等待就绪后再建连
    void ensureProxyBaseUrl().then((httpBase) => {
      if (cancelled) return;
      const wsBase = httpBase.replace(/^http/, 'ws');
      const wsUrl = workspaceId
        ? `${wsBase}/v1/workspaces/${workspaceId}/terminal`
        : `${wsBase}/v1/terminal`;

      socket = new WebSocket(wsUrl);
      socket.binaryType = 'arraybuffer';
      wsRef.current = socket;

      socket.onopen = () => {
        // 发送初始尺寸
        sendResize(socket!, term.cols, term.rows);
      };

      socket.onmessage = (ev) => {
        if (ev.data instanceof ArrayBuffer) {
          term.write(new Uint8Array(ev.data));
        } else if (typeof ev.data === 'string') {
          term.write(ev.data);
        }
      };

      socket.onerror = () => {
        term.writeln('\r\n\x1b[31m连接错误\x1b[0m');
      };

      socket.onclose = () => {
        term.writeln('\r\n\x1b[33m终端已断开\x1b[0m');
      };
    });

    // 聚焦终端
    term.focus();

    return () => {
      cancelled = true;
      dataDisposable.dispose();
      resizeDisposable.dispose();
      window.removeEventListener('resize', onWindowResize);
      resizeObserver.disconnect();
      socket?.close();
      term.dispose();
      termRef.current = null;
      wsRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  return (
    <div className="flex h-full min-h-0 w-full flex-1 flex-col">
      {/* 终端标签栏 */}
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3">
        <TerminalIcon className="size-3.5 text-foreground-subtlest" />
        <span className="text-xs font-medium text-foreground-subtle">终端</span>
        <span className="text-xs text-foreground-subtlest">— {wsName}</span>
        <div className="flex-1" />
        <button
          onClick={onClose}
          className="rounded p-0.5 text-foreground-subtlest transition-colors hover:bg-surface-hover hover:text-foreground"
          title="关闭终端"
        >
          <X className="size-3.5" />
        </button>
      </div>
      {/* xterm 挂载点 */}
      <div
        ref={containerRef}
        className="min-h-0 flex-1 bg-[#0d0d0d] px-2 py-1"
      />
    </div>
  );
}

function sendResize(socket: WebSocket, cols: number, rows: number) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: 'resize', cols, rows }));
  }
}
