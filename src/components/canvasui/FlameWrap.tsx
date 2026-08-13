"use client";

import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type {
  FlameWrapOptions,
  FlameRect,
  FlameWorkerRequest,
  FlameWorkerResponse,
} from "./flameWorker";

export interface FlameWrapElements {
  /** Canvas with layoutsubtree that hosts the HTML content. */
  source: HTMLCanvasElement;
  /** The element inside the source canvas that gets captured. */
  content: HTMLElement;
  /** Canvas the WebGL effect renders to. */
  output: HTMLCanvasElement;
}

export interface FlameWrapInstance {
  /** Update effect options live. */
  setOptions: (options: FlameWrapOptions) => void;
  /** Re-read canvas size. Call when the element is resized. */
  resize: () => void;
  /** Stop the loop and release all GPU resources. */
  destroy: () => void;
}

type PaintableCanvas = HTMLCanvasElement & {
  onpaint?: (() => void) | null;
  requestPaint?: () => void;
};

type ElementImageContext = CanvasRenderingContext2D & {
  drawElementImage?: (element: Element, x: number, y: number) => void;
};

/** 内容快照的节流间隔(毫秒):火焰的掩码只需输入框轮廓,~10fps 足够,
 *  不必跟随每次 paint 全量重捕获。 */
const CONTENT_INTERVAL_MS = 100;

/** 内容位图的最大宽度(像素),按比例缩放后再发给 worker。 */
const MAX_CONTENT_WIDTH = 1024;

export function supportsHtmlInCanvas(): boolean {
  if (typeof document === "undefined") return false;
  const probe = document.createElement("canvas") as PaintableCanvas;
  const ctx = probe.getContext("2d") as ElementImageContext | null;
  return Boolean(
    ctx &&
      typeof ctx.drawElementImage === "function" &&
      typeof probe.requestPaint === "function",
  );
}

interface FlameHandle {
  instance: FlameWrapInstance;
  /** 重新挂载时复用 worker/offscreen,只重挂 DOM 监听。 */
  attach: (elements: FlameWrapElements) => void;
  /** 卸载时摘除全部监听;worker 由 WeakMap 随画布 GC 自动回收。 */
  detach: () => void;
}

// keyed by output canvas:React StrictMode 下 effect 会卸载再重挂,
// 但 DOM 节点复用,transferControlToOffscreen 只能成功一次,必须复用同一实例。
const registry = new WeakMap<HTMLCanvasElement, FlameHandle>();

function createHandle(
  worker: Worker,
  offscreen: OffscreenCanvas,
  elements: FlameWrapElements,
  options: FlameWrapOptions,
  onError: () => void,
): FlameHandle {
  let source = elements.source;
  let contentEl = elements.content;
  let output = elements.output;

  const sourceCtx = source.getContext("2d") as ElementImageContext | null;
  const paintable = source as PaintableCanvas;
  const htmlInCanvas = supportsHtmlInCanvas();
  const contentSupported = Boolean(
    htmlInCanvas &&
      sourceCtx &&
      typeof sourceCtx.drawElementImage === "function" &&
      typeof paintable.requestPaint === "function",
  );

  let destroyed = false;
  let lastContentAt = 0;
  let lastMeasureAt = 0;

  const post = (msg: FlameWorkerRequest, transfer?: Transferable[]) => {
    if (transfer) worker.postMessage(msg, transfer);
    else worker.postMessage(msg);
  };

  function measure() {
    if (destroyed) return;
    const now = performance.now();
    // 几何测量含 3 次 getBoundingClientRect(force layout),节流到 ~5fps
    if (now - lastMeasureAt < 200 && lastMeasureAt > 0) return;
    lastMeasureAt = now;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cssWidth = Math.max(1, Math.round(output.clientWidth));
    const cssHeight = Math.max(1, Math.round(output.clientHeight));
    const width = Math.max(1, Math.round(cssWidth * dpr));
    const height = Math.max(1, Math.round(cssHeight * dpr));

    const box = contentSupported ? source : contentEl;
    const outRect = output.getBoundingClientRect();
    const boxRect = box.getBoundingClientRect();
    const rect: FlameRect = { cx: 0, cy: 0, hx: 1, hy: 1 };
    if (outRect.width > 0 && boxRect.width > 0) {
      rect.cx = (boxRect.left + boxRect.right) / 2 - outRect.left;
      rect.cy = outRect.bottom - (boxRect.top + boxRect.bottom) / 2;
      rect.hx = boxRect.width / 2;
      rect.hy = boxRect.height / 2;
    }

    if (contentSupported) {
      const srcCssWidth = Math.max(1, Math.round(source.clientWidth));
      const srcCssHeight = Math.max(1, Math.round(source.clientHeight));
      if (
        source.width !== srcCssWidth * dpr ||
        source.height !== srcCssHeight * dpr
      ) {
        source.width = srcCssWidth * dpr;
        source.height = srcCssHeight * dpr;
      }
      paintable.requestPaint?.();
    }

    post({ type: "geometry", width, height, cssWidth, cssHeight, rect });
  }

  function captureContent() {
    if (!contentSupported) return;
    try {
      sourceCtx!.reset();
      sourceCtx!.drawElementImage!(contentEl, 0, 0);
      const now = performance.now();
      if (now - lastContentAt < CONTENT_INTERVAL_MS) return;
      lastContentAt = now;
      const opts: ImageBitmapOptions | undefined =
        source.width > MAX_CONTENT_WIDTH
          ? { resizeWidth: MAX_CONTENT_WIDTH, resizeQuality: "low" }
          : undefined;
      createImageBitmap(source, opts)
        .then((bitmap) => {
          if (destroyed) {
            bitmap.close();
            return;
          }
          post({ type: "content", bitmap }, [bitmap]);
        })
        .catch(() => {});
    } catch {}
  }

  const resizeObserver = new ResizeObserver(() => {
    measure();
  });

  const intersection = new IntersectionObserver((entries) => {
    if (destroyed) return;
    const intersecting = entries[entries.length - 1]?.isIntersecting ?? true;
    post({ type: "visibility", visible: intersecting });
  });

  const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
  const onMotionChange = () => {
    if (destroyed) return;
    post({ type: "motion", reduced: motionQuery.matches });
  };
  motionQuery.addEventListener("change", onMotionChange);

  const onVisibilityChange = () => {
    if (destroyed) return;
    post({ type: "visibility", visible: document.visibilityState === "visible" });
  };
  document.addEventListener("visibilitychange", onVisibilityChange);

  function attach(next: FlameWrapElements) {
    source = next.source;
    contentEl = next.content;
    output = next.output;
    destroyed = false;
    if (contentSupported) {
      paintable.onpaint = captureContent;
      paintable.requestPaint?.();
    }
    resizeObserver.observe(output);
    resizeObserver.observe(contentEl);
    intersection.observe(output);
    measure();
  }

  function detach() {
    destroyed = true;
    resizeObserver.disconnect();
    intersection.disconnect();
    motionQuery.removeEventListener("change", onMotionChange);
    document.removeEventListener("visibilitychange", onVisibilityChange);
    if (contentSupported) paintable.onpaint = null;
  }

  worker.onmessage = (event: MessageEvent<FlameWorkerResponse>) => {
    if (event.data.type === "ready" && !event.data.ok) {
      detach();
      registry.delete(output);
      onError();
    }
  };
  worker.onerror = () => {
    detach();
    registry.delete(output);
    onError();
  };

  const instance: FlameWrapInstance = {
    setOptions(next) {
      post({ type: "setOptions", options: next });
    },
    resize() {
      measure();
    },
    destroy() {
      detach();
      // 注意:不 terminate worker。StrictMode 重挂会复用同一 offscreen,
      // 真实卸载时画布被 GC,WeakMap 条目随之回收,浏览器自动关闭 worker 端口。
    },
  };

  const handle: FlameHandle = { instance, attach, detach };

  // 初始挂载:转移画布控制权并启动 worker。
  const dpr0 = Math.min(window.devicePixelRatio || 1, 2);
  const cssWidth = Math.max(1, Math.round(output.clientWidth));
  const cssHeight = Math.max(1, Math.round(output.clientHeight));
  const width = Math.max(1, Math.round(cssWidth * dpr0));
  const height = Math.max(1, Math.round(cssHeight * dpr0));
  const box = contentSupported ? source : contentEl;
  const outRect = output.getBoundingClientRect();
  const boxRect = box.getBoundingClientRect();
  const rect: FlameRect = { cx: 0, cy: 0, hx: 1, hy: 1 };
  if (outRect.width > 0 && boxRect.width > 0) {
    rect.cx = (boxRect.left + boxRect.right) / 2 - outRect.left;
    rect.cy = outRect.bottom - (boxRect.top + boxRect.bottom) / 2;
    rect.hx = boxRect.width / 2;
    rect.hy = boxRect.height / 2;
  }
  post(
    {
      type: "init",
      canvas: offscreen,
      options,
      width,
      height,
      cssWidth,
      cssHeight,
      rect,
      contentSupported,
    },
    [offscreen],
  );
  attach(elements);

  return handle;
}

export function createFlameWrap(
  elements: FlameWrapElements,
  options: FlameWrapOptions = {},
  onError?: () => void,
): FlameWrapInstance | null {
  const { output } = elements;
  const existing = registry.get(output);
  if (existing) {
    existing.attach(elements);
    return existing.instance;
  }

  let offscreen: OffscreenCanvas | null = null;
  try {
    offscreen = output.transferControlToOffscreen();
  } catch {
    return null;
  }
  if (!offscreen) return null;

  let worker: Worker;
  try {
    worker = new Worker(new URL("./flameWorker.ts", import.meta.url), {
      type: "module",
    });
  } catch {
    return null;
  }

  const handle = createHandle(
    worker,
    offscreen,
    elements,
    options,
    onError ?? (() => {}),
  );
  registry.set(output, handle);
  return handle.instance;
}

export interface FlameWrapProps extends FlameWrapOptions {
  children: ReactNode;
  className?: string;
  style?: React.CSSProperties;
}

const emptySubscribe = () => () => {};

export function FlameWrap({
  children,
  className,
  style,
  ...options
}: FlameWrapProps) {
  const sourceRef = useRef<HTMLCanvasElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const outputRef = useRef<HTMLCanvasElement>(null);
  const instanceRef = useRef<FlameWrapInstance | null>(null);
  const [initialOptions] = useState(options);
  const [failed, setFailed] = useState(false);

  const supported = useSyncExternalStore(
    emptySubscribe,
    supportsHtmlInCanvas,
    () => false,
  );
  const native = supported && !failed;

  const reach = Math.round(Math.max(options.height ?? 170, 24) * 1.5) + 40;
  const glow = Math.round(Math.max(options.spread ?? 8, 8) * 3) + 16;

  useEffect(() => {
    const source = sourceRef.current;
    const content = contentRef.current;
    const output = outputRef.current;
    if (!source || !content || !output) return;
    instanceRef.current = createFlameWrap(
      { source, content, output },
      initialOptions,
      () => setFailed(true),
    );
    if (native && !instanceRef.current) setFailed(true);
    return () => {
      instanceRef.current?.destroy();
      instanceRef.current = null;
    };
  }, [initialOptions, native]);

  useEffect(() => {
    instanceRef.current?.setOptions(options);
  });

  return (
    <div className={className} style={{ position: "relative", ...style }}>
      <canvas
        ref={sourceRef}
        // @ts-expect-error experimental html-in-canvas attribute
        layoutsubtree="true"
        suppressHydrationWarning
        style={
          native
            ? { position: "absolute", inset: 0, width: "100%", height: "100%" }
            : { display: "none" }
        }
      >
        {native ? (
          <div
            ref={contentRef}
            style={{
              position: "relative",
              width: "100%",
              height: "100%",
              overflow: "auto",
            }}
          >
            {children}
          </div>
        ) : null}
      </canvas>
      {!native ? (
        <div
          ref={contentRef}
          style={{
            position: "relative",
            width: "100%",
            height: "100%",
            overflow: "auto",
          }}
        >
          {children}
        </div>
      ) : null}
      <canvas
        ref={outputRef}
        aria-hidden
        style={{
          position: "absolute",
          top: -reach,
          right: -glow,
          bottom: -glow,
          left: -glow,
          width: `calc(100% + ${glow * 2}px)`,
          height: `calc(100% + ${reach + glow}px)`,
          pointerEvents: "none",
        }}
      />
    </div>
  );
}

export default FlameWrap;
