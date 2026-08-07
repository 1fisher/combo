import { useCallback, useEffect, useRef, useState } from 'react';
import { Minus, Plus, RotateCcw, ZoomIn } from 'lucide-react';

const MIN_SCALE = 0.1;
const MAX_SCALE = 10;

/**
 * 可缩放图片预览:滚轮缩放(以鼠标位置为中心)、双击切换、
 * 拖拽平移、底部工具栏。
 */
export function ImageViewer({ src, alt }: { src: string; alt: string }) {
  const [scale, setScale] = useState(1);
  const [tx, setTx] = useState(0);
  const [ty, setTy] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ startX: number; startY: number; ox: number; oy: number } | null>(null);

  const clamp = useCallback((s: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s)), []);

  const reset = useCallback(() => {
    setScale(1);
    setTx(0);
    setTy(0);
  }, []);

  const zoomBy = useCallback(
    (factor: number) => {
      setScale((prev) => clamp(prev * factor));
    },
    [clamp]
  );

  function onWheel(e: React.WheelEvent<HTMLDivElement>) {
    e.preventDefault();
    zoomBy(e.deltaY < 0 ? 1.1 : 1 / 1.1);
  }

  function onDoubleClick() {
    setScale((s) => (s >= 1 ? 0.5 : 1));
  }

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = { startX: e.clientX, startY: e.clientY, ox: tx, oy: ty };
  }

  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!dragRef.current) return;
    setTx(dragRef.current.ox + (e.clientX - dragRef.current.startX));
    setTy(dragRef.current.oy + (e.clientY - dragRef.current.startY));
  }

  function onPointerUp(e: React.PointerEvent<HTMLDivElement>) {
    dragRef.current = null;
    (e.target as HTMLElement).releasePointerCapture(e.pointerId);
  }

  // 切换图片时重置
  useEffect(() => {
    reset();
  }, [src, reset]);

  return (
    <div className="relative flex h-full w-full flex-col bg-background">
      {/* 图片画布 */}
      <div
        ref={containerRef}
        onWheel={onWheel}
        onDoubleClick={onDoubleClick}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        className="relative flex min-h-0 flex-1 touch-none items-center justify-center overflow-hidden"
      >
        <img
          src={src}
          alt={alt}
          draggable={false}
          className="select-none object-contain"
          style={{
            maxWidth: '90%',
            maxHeight: '90%',
            transform: `translate(${tx}px, ${ty}px) scale(${scale})`,
            transformOrigin: 'center center',
            cursor: dragRef.current ? 'grabbing' : 'grab',
          }}
        />
      </div>
      {/* 工具栏 */}
      <div className="flex shrink-0 items-center justify-center gap-1 border-t bg-muted/30 px-2 py-1.5">
        <button
          onClick={() => zoomBy(1 / 1.2)}
          className="rounded p-1 text-muted-foreground transition-colors hover:bg-surface-hover hover:text-foreground"
          title="缩小"
        >
          <Minus className="size-3.5" />
        </button>
        <span className="min-w-[3rem] text-center text-xs tabular-nums text-muted-foreground">
          {Math.round(scale * 100)}%
        </span>
        <button
          onClick={() => zoomBy(1.2)}
          className="rounded p-1 text-muted-foreground transition-colors hover:bg-surface-hover hover:text-foreground"
          title="放大"
        >
          <Plus className="size-3.5" />
        </button>
        <button
          onClick={() => setScale(1)}
          className="rounded p-1 text-muted-foreground transition-colors hover:bg-surface-hover hover:text-foreground"
          title="实际大小"
        >
          <ZoomIn className="size-3.5" />
        </button>
        <button
          onClick={reset}
          className="rounded p-1 text-muted-foreground transition-colors hover:bg-surface-hover hover:text-foreground"
          title="重置"
        >
          <RotateCcw className="size-3.5" />
        </button>
      </div>
    </div>
  );
}
