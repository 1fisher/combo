import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  type Simulation,
  type SimulationNodeDatum,
} from 'd3-force';
import {
  FileCode2,
  Link2,
  Loader2,
  Maximize,
  Package,
  RefreshCw,
  Search,
  Waypoints,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import type { Api } from '../../lib/api/types';
import { getFileContent } from '../../lib/api';
import { useWorkspaceGraph } from '../../hooks/useGraph';
import { useEditorStore } from '../../stores/editorStore';
import { cn } from '../../lib/utils';
import { Switch } from '../ui/switch';
import { HeroEmpty, INPUT_CLS, PAGE, PageHeader, ViewScroll } from './PageShell';

/**
 * 知识图谱视图(主内容区独立视图):扫描当前项目源码构建文件级依赖图,
 * d3-force 力导向布局 + canvas 渲染。支持缩放/平移/拖拽节点/hover 高亮
 * 邻居/点选查看文件详情(依赖/被依赖/外部依赖),并可跳到编辑器打开文件。
 */

// ---------------------------------------------------------------------------
// 视觉映射
// ---------------------------------------------------------------------------

/** 语言配色(dark 主题下偏亮的辨识色)。 */
const LANG_COLORS: Record<string, string> = {
  ts: '#4c8dff',
  tsx: '#38bdf8',
  js: '#eab308',
  jsx: '#f59e0b',
  py: '#519aba',
  rs: '#f97316',
  go: '#22d3ee',
  vue: '#42d883',
  svelte: '#fb7185',
  java: '#fb923c',
  kotlin: '#a78bfa',
  ruby: '#f43f5e',
  php: '#818cf8',
  swift: '#ff6b6b',
  c: '#94a3b8',
  cpp: '#f472b6',
};

const LANG_LABELS: Record<string, string> = {
  ts: 'TypeScript',
  tsx: 'React TS',
  js: 'JavaScript',
  jsx: 'React JS',
  py: 'Python',
  rs: 'Rust',
  go: 'Go',
  vue: 'Vue',
  svelte: 'Svelte',
  java: 'Java',
  kotlin: 'Kotlin',
  ruby: 'Ruby',
  php: 'PHP',
  swift: 'Swift',
  c: 'C',
  cpp: 'C++',
};

function langColor(lang: string): string {
  return LANG_COLORS[lang] ?? '#64748b';
}

function langLabel(lang: string): string {
  return LANG_LABELS[lang] ?? lang;
}

// ---------------------------------------------------------------------------
// simulation 类型
// ---------------------------------------------------------------------------

type SimNode = Api.GraphNode & SimulationNodeDatum;
type SimLink = { source: string | SimNode; target: string | SimNode };

type Transform = { k: number; x: number; y: number };

/** 节点半径随连接度增长(平方根,封顶防巨型节点)。 */
function nodeRadius(n: { in: number; out: number }): number {
  return Math.min(15, 3.5 + Math.sqrt(n.in + n.out) * 1.8);
}

function fmtNum(n: number): string {
  return n.toLocaleString('zh-CN');
}

// ---------------------------------------------------------------------------
// 图谱画布
// ---------------------------------------------------------------------------

function GraphCanvas({
  graph,
  hideIsolated,
  dirFilter,
  query,
  showLabels,
  selectedId,
  onSelect,
  onOpenFile,
}: {
  graph: Api.WorkspaceGraph;
  hideIsolated: boolean;
  dirFilter: string | null;
  query: string;
  showLabels: boolean;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onOpenFile: (path: string) => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const simRef = useRef<Simulation<SimNode, SimLink> | null>(null);
  const nodesRef = useRef<SimNode[]>([]);
  const linksRef = useRef<SimLink[]>([]);
  const sizeRef = useRef({ w: 0, h: 0 });
  const transformRef = useRef<Transform>({ k: 1, x: 0, y: 0 });
  const drawRef = useRef<() => void>(() => {});
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [hoverPos, setHoverPos] = useState<{ x: number; y: number } | null>(null);

  const nodeById = useMemo(() => {
    const m = new Map<string, Api.GraphNode>();
    for (const n of graph.nodes) m.set(n.id, n);
    return m;
  }, [graph]);

  /** 节点是否可见(目录过滤 + 孤立文件开关)。 */
  const isVisible = useCallback(
    (n: SimNode) => {
      if (hideIsolated && n.in + n.out === 0) return false;
      if (dirFilter && n.id !== dirFilter && !n.id.startsWith(dirFilter + '/')) return false;
      return true;
    },
    [hideIsolated, dirFilter],
  );

  const queryLower = query.trim().toLowerCase();
  const isMatch = useCallback(
    (n: SimNode) =>
      !queryLower ||
      n.id.toLowerCase().includes(queryLower) ||
      n.name.toLowerCase().includes(queryLower),
    [queryLower],
  );

  // ---- 邻居索引(hover/选中高亮) ----
  const neighbors = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const e of graph.edges) {
      if (!m.has(e.source)) m.set(e.source, new Set());
      if (!m.has(e.target)) m.set(e.target, new Set());
      m.get(e.source)!.add(e.target);
      m.get(e.target)!.add(e.source);
    }
    return m;
  }, [graph]);

  // ---- 初始化 simulation(数据变化时重建) ----
  useEffect(() => {
    const count = graph.nodes.length;
    const distance = count <= 100 ? 70 : count <= 500 ? 45 : 30;
    const charge = count <= 100 ? -140 : count <= 500 ? -90 : -55;

    const nodes: SimNode[] = graph.nodes.map((n) => ({ ...n }));
    // 极坐标随机散布初始位置,避免全部堆在原点纠缠成一团
    const R = Math.sqrt(Math.max(count, 1)) * 32;
    nodes.forEach((d, i) => {
      const a = (2 * Math.PI * i) / Math.max(count, 1);
      const rr = R * (0.4 + 0.6 * Math.random());
      d.x = Math.cos(a) * rr;
      d.y = Math.sin(a) * rr;
    });
    const links: SimLink[] = graph.edges.map((e) => ({ source: e.source, target: e.target }));

    nodesRef.current = nodes;
    linksRef.current = links;

    const sim = forceSimulation<SimNode>(nodes)
      .force(
        'link',
        forceLink<SimNode, SimLink>(links)
          .id((d) => d.id)
          .distance(distance)
          .strength(0.12),
      )
      .force('charge', forceManyBody<SimNode>().strength(charge))
      .force(
        'collide',
        forceCollide<SimNode>()
          .radius((d) => nodeRadius(d) + 2)
          .iterations(1),
      )
      .force('center', forceCenter(0, 0).strength(0.05))
      .alphaDecay(0.028)
      .on('tick', () => drawRef.current());
    simRef.current = sim;
    transformRef.current = { k: 1, x: 0, y: 0 };

    // 布局几步后自动 fit 一次(等待初始散开)
    const t = window.setTimeout(() => fitRef.current(), 900);

    return () => {
      window.clearTimeout(t);
      sim.stop();
      simRef.current = null;
    };
  }, [graph]);

  // ---- 尺寸自适应 ----
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      sizeRef.current = { w: el.clientWidth, h: el.clientHeight };
      const c = canvasRef.current;
      if (c) {
        const dpr = window.devicePixelRatio || 1;
        c.width = Math.max(1, Math.round(el.clientWidth * dpr));
        c.height = Math.max(1, Math.round(el.clientHeight * dpr));
        c.style.width = `${el.clientWidth}px`;
        c.style.height = `${el.clientHeight}px`;
      }
      drawRef.current();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ---- 坐标变换 ----
  const toWorld = (px: number, py: number) => {
    const t = transformRef.current;
    return { x: (px - t.x) / t.k, y: (py - t.y) / t.k };
  };

  const fitRef = useRef<(initial?: boolean) => void>(() => {});
  const fitView = useCallback(() => {
    const { w, h } = sizeRef.current;
    const ns = nodesRef.current.filter((n) => isVisible(n));
    if (!ns.length || !w || !h) return;
    let minX = Infinity,
      maxX = -Infinity,
      minY = Infinity,
      maxY = -Infinity;
    for (const n of ns) {
      if (n.x == null || n.y == null) continue;
      minX = Math.min(minX, n.x);
      maxX = Math.max(maxX, n.x);
      minY = Math.min(minY, n.y);
      maxY = Math.max(maxY, n.y);
    }
    if (!isFinite(minX)) return;
    const bw = Math.max(maxX - minX, 1);
    const bh = Math.max(maxY - minY, 1);
    const k = Math.min((w - 100) / bw, (h - 100) / bh, 1.6);
    transformRef.current = {
      k,
      x: w / 2 - (k * (minX + maxX)) / 2,
      y: h / 2 - (k * (minY + maxY)) / 2,
    };
    drawRef.current();
  }, [isVisible]);
  fitRef.current = fitView;

  // ---- 绘制 ----
  const draw = useCallback(() => {
    const c = canvasRef.current;
    const ctx = c?.getContext('2d');
    if (!c || !ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const { w, h } = sizeRef.current;
    const t = transformRef.current;
    const nodes = nodesRef.current;
    const links = linksRef.current;
    const hovered = hoverId;
    const selected = selectedId;

    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    // 背景(径向微光)
    const bg = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.max(w, h) * 0.7);
    bg.addColorStop(0, 'rgba(76,125,255,0.05)');
    bg.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);

    ctx.translate(t.x, t.y);
    ctx.scale(t.k, t.k);

    const focus = hovered ?? selected;
    const focusSet = focus ? neighbors.get(focus) : undefined;
    const hasQuery = queryLower.length > 0;

    // ---- 边 ----
    ctx.lineWidth = 1 / t.k;
    for (const l of links) {
      const s = l.source as SimNode;
      const tg = l.target as SimNode;
      if (s.x == null || s.y == null || tg.x == null || tg.y == null) continue;
      if (!isVisible(s) || !isVisible(tg)) continue;
      let alpha = 0.1;
      if (focus) {
        alpha =
          focus === s.id || focus === tg.id || focusSet?.has(s.id) === true ? 0.55 : 0.03;
      } else if (hasQuery) {
        alpha = isMatch(s) && isMatch(tg) ? 0.4 : 0.03;
      }
      ctx.strokeStyle =
        focus && (focus === s.id || focus === tg.id)
          ? 'rgba(76,125,255,0.8)'
          : `rgba(148,163,184,${alpha})`;
      ctx.beginPath();
      ctx.moveTo(s.x, s.y);
      ctx.lineTo(tg.x, tg.y);
      ctx.stroke();
    }

    // ---- 节点 ----
    for (const n of nodes) {
      if (n.x == null || n.y == null || !isVisible(n)) continue;
      const r = nodeRadius(n);
      const inFocus = !!focus && (focus === n.id || focusSet?.has(n.id) === true);
      let alpha = 1;
      if (focus) alpha = inFocus ? 1 : 0.12;
      else if (hasQuery) alpha = isMatch(n) ? 1 : 0.07;

      ctx.globalAlpha = alpha;
      // 光晕(hover/选中)
      if (n.id === hoverId || n.id === selectedId) {
        ctx.beginPath();
        ctx.arc(n.x, n.y, r + 5 / t.k, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(76,125,255,0.18)';
        ctx.fill();
      }
      ctx.beginPath();
      ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
      ctx.fillStyle = langColor(n.lang);
      ctx.fill();
      if (n.id === selectedId) {
        ctx.lineWidth = 2 / t.k;
        ctx.strokeStyle = '#4c7dff';
        ctx.stroke();
      } else if (hasQuery && isMatch(n)) {
        ctx.lineWidth = 1.5 / t.k;
        ctx.strokeStyle = 'rgba(255,255,255,0.7)';
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }

    // ---- 标签 ----
    const showAll = showLabels && t.k > 1.15;
    if (showAll || focus || hasQuery) {
      ctx.font = '10px ui-sans-serif, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      for (const n of nodes) {
        if (n.x == null || n.y == null || !isVisible(n)) continue;
        const r = nodeRadius(n);
        const want =
          n.id === selectedId ||
          n.id === hoverId ||
          (hasQuery && isMatch(n) && t.k * r > 3) ||
          (showAll && t.k * r > 5.5) ||
          (focus === n.id);
        if (!want) continue;
        ctx.globalAlpha = focus && !(focus === n.id || focusSet?.has(n.id)) ? 0.15 : 0.9;
        ctx.fillStyle = 'rgba(0,0,0,0.55)';
        ctx.fillText(n.name, n.x + 0.5, n.y + r + 3 / t.k + 0.5);
        ctx.fillStyle = n.id === selectedId || n.id === hoverId ? '#dbeafe' : '#cbd5e1';
        ctx.fillText(n.name, n.x, n.y + r + 3 / t.k);
        ctx.globalAlpha = 1;
      }
    }

    ctx.restore();
  }, [hoverId, selectedId, isVisible, isMatch, neighbors, queryLower, showLabels]);
  drawRef.current = draw;

  // 过滤/选中/hover 变化后重绘
  useEffect(() => {
    drawRef.current();
  }, [hoverId, selectedId, hideIsolated, dirFilter, query, showLabels, graph]);

  // ---- 指针交互 ----
  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;

    let mode: 'none' | 'pan' | 'node' = 'none';
    let dragNode: SimNode | null = null;
    let last = { x: 0, y: 0 };
    let moved = 0;

    const nodeAt = (px: number, py: number): SimNode | null => {
      const p = toWorld(px, py);
      const nodes = nodesRef.current;
      for (let i = nodes.length - 1; i >= 0; i--) {
        const n = nodes[i];
        if (n.x == null || n.y == null || !isVisible(n)) continue;
        const r = nodeRadius(n) + 3 / transformRef.current.k;
        const dx = n.x - p.x;
        const dy = n.y - p.y;
        if (dx * dx + dy * dy <= r * r) return n;
      }
      return null;
    };

    const onPointerDown = (e: PointerEvent) => {
      // 合成事件/部分环境下 pointer 未激活会抛 NotFoundError,失败不影响拖拽逻辑
      try {
        c.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      const rect = c.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      const n = nodeAt(px, py);
      moved = 0;
      if (n) {
        mode = 'node';
        dragNode = n;
        n.fx = n.x;
        n.fy = n.y;
        simRef.current?.alphaTarget(0.25).restart();
      } else {
        mode = 'pan';
      }
      last = { x: px, y: py };
    };

    const onPointerMove = (e: PointerEvent) => {
      const rect = c.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      if (mode === 'node' && dragNode) {
        const p = toWorld(px, py);
        dragNode.fx = p.x;
        dragNode.fy = p.y;
        moved += Math.abs(px - last.x) + Math.abs(py - last.y);
      } else if (mode === 'pan') {
        transformRef.current.x += px - last.x;
        transformRef.current.y += py - last.y;
        moved += Math.abs(px - last.x) + Math.abs(py - last.y);
        drawRef.current();
      } else {
        // hover 命中检测
        const n = nodeAt(px, py);
        setHoverId(n ? n.id : null);
        setHoverPos(n ? { x: px, y: py } : null);
        c.style.cursor = n ? 'pointer' : 'default';
      }
      last = { x: px, y: py };
    };

    const onPointerUp = (e: PointerEvent) => {
      const rect = c.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      if (mode === 'node' && dragNode) {
        dragNode.fx = null;
        dragNode.fy = null;
        simRef.current?.alphaTarget(0);
        // 未真正拖动 → 视为点击选中
        if (moved < 5) onSelect(dragNode.id === selectedId ? null : dragNode.id);
      } else if (mode === 'pan' && moved < 5) {
        const n = nodeAt(px, py);
        onSelect(n ? (n.id === selectedId ? null : n.id) : null);
      }
      mode = 'none';
      dragNode = null;
    };

    const onDbl = (e: MouseEvent) => {
      const rect = c.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      if (!nodeAt(px, py)) fitView();
    };

    // wheel 缩放需 non-passive 才能 preventDefault
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = c.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      const t = transformRef.current;
      const factor = Math.exp(-e.deltaY * 0.0015);
      const k = Math.min(5, Math.max(0.1, t.k * factor));
      transformRef.current = {
        k,
        x: px - ((px - t.x) * k) / t.k,
        y: py - ((py - t.y) * k) / t.k,
      };
      drawRef.current();
    };

    c.addEventListener('pointerdown', onPointerDown);
    c.addEventListener('pointermove', onPointerMove);
    c.addEventListener('pointerup', onPointerUp);
    c.addEventListener('dblclick', onDbl);
    c.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      c.removeEventListener('pointerdown', onPointerDown);
      c.removeEventListener('pointermove', onPointerMove);
      c.removeEventListener('pointerup', onPointerUp);
      c.removeEventListener('dblclick', onDbl);
      c.removeEventListener('wheel', onWheel);
    };
  }, [isVisible, fitView, onSelect, selectedId]);

  const zoomBy = (factor: number) => {
    const t = transformRef.current;
    const { w, h } = sizeRef.current;
    const k = Math.min(5, Math.max(0.1, t.k * factor));
    transformRef.current = {
      k,
      x: w / 2 - ((w / 2 - t.x) * k) / t.k,
      y: h / 2 - ((h / 2 - t.y) * k) / t.k,
    };
    drawRef.current();
  };

  const hoverNode = hoverId ? nodeById.get(hoverId) : null;
  const selectedNode = selectedId ? nodeById.get(selectedId) : null;

  const depsOf = (id: string) => graph.edges.filter((e) => e.source === id).map((e) => e.target);
  const rdepsOf = (id: string) => graph.edges.filter((e) => e.target === id).map((e) => e.source);

  return (
    <div ref={wrapRef} className="relative h-full w-full overflow-hidden rounded-xl border border-border bg-background">
      <canvas ref={canvasRef} className="block h-full w-full touch-none" />

      {/* 缩放控件 */}
      <div className="absolute bottom-3 left-3 flex flex-col gap-1">
        <button
          type="button"
          aria-label="放大"
          title="放大"
          onClick={() => zoomBy(1.3)}
          className="flex size-8 items-center justify-center rounded-lg border border-border bg-background/90 text-foreground-subtle backdrop-blur transition-colors hover:text-foreground"
        >
          <ZoomIn className="size-4" />
        </button>
        <button
          type="button"
          aria-label="缩小"
          title="缩小"
          onClick={() => zoomBy(1 / 1.3)}
          className="flex size-8 items-center justify-center rounded-lg border border-border bg-background/90 text-foreground-subtle backdrop-blur transition-colors hover:text-foreground"
        >
          <ZoomOut className="size-4" />
        </button>
        <button
          type="button"
          aria-label="适应视图"
          title="适应视图(双击空白处同样生效)"
          onClick={() => fitView()}
          className="flex size-8 items-center justify-center rounded-lg border border-border bg-background/90 text-foreground-subtle backdrop-blur transition-colors hover:text-foreground"
        >
          <Maximize className="size-4" />
        </button>
      </div>

      {/* hover 浮层 */}
      {hoverNode && hoverPos && !selectedNode && (
        <div
          className="pointer-events-none absolute z-10 max-w-[280px] rounded-lg border border-border bg-popover/95 px-2.5 py-1.5 text-xs shadow-lg backdrop-blur"
          style={{ left: Math.min(hoverPos.x + 14, (sizeRef.current.w || 0) - 290), top: hoverPos.y + 14 }}
        >
          <div className="flex items-center gap-1.5">
            <span
              className="size-2 shrink-0 rounded-full"
              style={{ background: langColor(hoverNode.lang) }}
            />
            <span className="truncate font-medium text-foreground">{hoverNode.name}</span>
          </div>
          <div className="mt-0.5 truncate text-[11px] text-foreground-subtle">{hoverNode.dir}</div>
          <div className="mt-1 flex gap-2 text-[11px] text-foreground-subtle">
            <span>依赖 {hoverNode.out}</span>
            <span>被依赖 {hoverNode.in}</span>
            <span>{hoverNode.loc} 行</span>
          </div>
        </div>
      )}

      {/* 选中节点详情 */}
      {selectedNode && (
        <div className="absolute right-3 top-3 z-10 flex max-h-[calc(100%-24px)] w-80 flex-col overflow-hidden rounded-xl border border-border bg-background/95 shadow-xl backdrop-blur">
          <div className="flex items-start gap-2 border-b border-border px-3 py-2.5">
            <span
              className="mt-1 size-2.5 shrink-0 rounded-full"
              style={{ background: langColor(selectedNode.lang) }}
            />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] font-medium text-foreground">
                {selectedNode.name}
              </div>
              <div className="truncate text-[11px] text-foreground-subtle" title={selectedNode.id}>
                {selectedNode.id}
              </div>
            </div>
            <button
              type="button"
              aria-label="关闭详情"
              onClick={() => onSelect(null)}
              className="shrink-0 rounded p-0.5 text-foreground-subtlest transition-colors hover:text-foreground"
            >
              ✕
            </button>
          </div>
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-2.5">
            <div className="grid grid-cols-4 gap-2 text-center">
              {[
                { label: '语言', value: langLabel(selectedNode.lang) },
                { label: '代码行', value: fmtNum(selectedNode.loc) },
                { label: '定义', value: fmtNum(selectedNode.defs) },
                { label: '依赖', value: `${selectedNode.out}/${selectedNode.in}` },
              ].map((s) => (
                <div key={s.label} className="rounded-lg bg-surface-hover/60 px-1 py-1.5">
                  <div className="truncate text-[11px] text-foreground-subtlest">{s.label}</div>
                  <div className="truncate text-[13px] font-medium text-foreground">{s.value}</div>
                </div>
              ))}
            </div>

            <DetailList
              title={`依赖 ${depsOf(selectedNode.id).length}`}
              ids={depsOf(selectedNode.id)}
              nodeById={nodeById}
              onSelect={onSelect}
            />
            <DetailList
              title={`被依赖 ${rdepsOf(selectedNode.id).length}`}
              ids={rdepsOf(selectedNode.id)}
              nodeById={nodeById}
              onSelect={onSelect}
            />
            {selectedNode.external.length > 0 && (
              <div>
                <div className="mb-1.5 text-[11px] font-medium text-foreground-subtle">
                  外部依赖 {selectedNode.external.length}
                </div>
                <div className="flex flex-wrap gap-1">
                  {selectedNode.external.map((p) => (
                    <span
                      key={p}
                      className="rounded-full bg-surface-hover px-2 py-0.5 text-[11px] text-foreground-subtle"
                    >
                      {p}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
          <div className="border-t border-border p-2">
            <button
              type="button"
              onClick={() => onOpenFile(selectedNode.id)}
              className="flex h-8 w-full items-center justify-center gap-1.5 rounded-lg bg-brand/10 px-3 text-[13px] font-medium text-brand transition-colors hover:bg-brand/20"
            >
              <FileCode2 className="size-3.5" />
              在编辑器中打开
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function DetailList({
  title,
  ids,
  nodeById,
  onSelect,
}: {
  title: string;
  ids: string[];
  nodeById: Map<string, Api.GraphNode>;
  onSelect: (id: string | null) => void;
}) {
  if (!ids.length) return null;
  return (
    <div>
      <div className="mb-1.5 text-[11px] font-medium text-foreground-subtle">{title}</div>
      <div className="space-y-0.5">
        {ids.slice(0, 30).map((id) => {
          const n = nodeById.get(id);
          return (
            <button
              key={id}
              type="button"
              onClick={() => onSelect(id)}
              className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-surface-hover"
              title={id}
            >
              <span
                className="size-1.5 shrink-0 rounded-full"
                style={{ background: langColor(n?.lang ?? '') }}
              />
              <span className="truncate text-[12px] text-foreground-subtle">
                {n?.name ?? id}
              </span>
              <Link2 className="ml-auto size-3 shrink-0 text-foreground-subtlest" />
            </button>
          );
        })}
        {ids.length > 30 && (
          <div className="px-1.5 text-[11px] text-foreground-subtlest">… 共 {ids.length} 项</div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 视图主体
// ---------------------------------------------------------------------------

export function GraphView({
  workspaceId,
  onOpenInEditor,
}: {
  workspaceId: string | null;
  onOpenInEditor?: () => void;
}) {
  const { data, isLoading, isFetching, refetchGraph, error } = useWorkspaceGraph(workspaceId);
  const [query, setQuery] = useState('');
  const [hideIsolated, setHideIsolated] = useState(true);
  const [showLabels, setShowLabels] = useState(true);
  const [dirFilter, setDirFilter] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const openFileInStore = useEditorStore((s) => s.openFile);
  const [opening, setOpening] = useState<string | null>(null);

  // 切换项目/重新扫描后清掉选中与目录过滤
  useEffect(() => {
    setSelectedId(null);
    setDirFilter(null);
  }, [workspaceId, data]);

  const dirs = useMemo(() => {
    if (!data) return [];
    const counts = new Map<string, number>();
    for (const n of data.nodes) {
      const d = n.dir === '.' ? '(根目录)' : n.dir;
      counts.set(d, (counts.get(d) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([dir, count]) => ({ dir, count }));
  }, [data]);

  const langCounts = useMemo(() => {
    if (!data) return [];
    return Object.entries(data.stats.langs)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);
  }, [data]);

  const handleOpenFile = async (path: string) => {
    if (!workspaceId) return;
    setOpening(path);
    try {
      const name = path.split('/').pop() ?? path;
      const { content } = await getFileContent(workspaceId, path);
      openFileInStore(path, name, content);
      onOpenInEditor?.();
    } finally {
      setOpening(null);
    }
  };

  if (!workspaceId) {
    return (
      <ViewScroll>
        <div className={PAGE}>
          <PageHeader title="知识图谱" desc="以文件依赖图的方式浏览项目结构" />
          <div className="mt-16">
            <HeroEmpty
              title="先选择一个项目"
              desc="在左侧选择(或添加)一个项目后,即可查看它的代码知识图谱。"
            />
          </div>
        </div>
      </ViewScroll>
    );
  }

  return (
    <ViewScroll>
      <div className={cn(PAGE, 'py-6')}>
        <PageHeader
          title="知识图谱"
          desc="扫描项目源码构建的文件依赖图:节点是源文件,连线是 import / use / include 关系"
        >
          <button
            type="button"
            onClick={() => refetchGraph()}
            disabled={isLoading || isFetching}
            className="flex h-8 items-center gap-1.5 rounded-lg border border-border px-3 text-[13px] text-foreground-subtle transition-colors hover:text-foreground disabled:opacity-50"
          >
            <RefreshCw className={cn('size-3.5', isFetching && 'animate-spin')} />
            重新扫描
          </button>
        </PageHeader>

        {isLoading ? (
          <div className="mt-20 flex items-center justify-center gap-2 text-sm text-foreground-subtle">
            <Loader2 className="size-4 animate-spin" />
            正在扫描项目源码…
          </div>
        ) : error ? (
          <div className="mt-20 flex flex-col items-center gap-2 text-sm text-red-400">
            图谱加载失败:{error instanceof Error ? error.message : String(error)}
          </div>
        ) : !data || data.nodes.length === 0 ? (
          <div className="mt-16">
            <HeroEmpty
              title="未发现代码文件"
              desc="该项目里没有扫描到受支持的源码文件(TS/JS、Python、Rust、Go、C/C++ 等),或文件都在被忽略的目录里。"
            />
          </div>
        ) : (
          <div className="mt-5 flex min-h-0 flex-1 flex-col gap-3">
            {/* 统计 + 过滤工具行 */}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <div className="flex items-center gap-3 text-[13px] text-foreground-subtle">
                <span className="flex items-center gap-1">
                  <FileCode2 className="size-3.5 text-foreground-subtlest" />
                  {fmtNum(data.stats.files)} 个文件
                </span>
                <span className="flex items-center gap-1">
                  <Waypoints className="size-3.5 text-foreground-subtlest" />
                  {fmtNum(data.stats.edges)} 条依赖
                </span>
                <span>{fmtNum(data.stats.total_loc)} 行代码</span>
              </div>

              <div className="relative ml-auto h-8 w-56">
                <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-foreground-subtlest" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="搜索文件…"
                  className={cn(INPUT_CLS, 'h-8 pl-8 text-[13px]')}
                />
              </div>

              <label className="flex cursor-pointer items-center gap-1.5 text-[13px] text-foreground-subtle">
                <Switch checked={hideIsolated} onCheckedChange={setHideIsolated} />
                仅看有依赖的文件
              </label>
              <label className="flex cursor-pointer items-center gap-1.5 text-[13px] text-foreground-subtle">
                <Switch checked={showLabels} onCheckedChange={setShowLabels} />
                文件名(放大后)
              </label>
            </div>

            {/* 目录过滤 + 语言图例 */}
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
              <button
                type="button"
                onClick={() => setDirFilter(null)}
                className={cn(
                  'rounded-full px-2.5 py-1 text-[12px] transition-colors',
                  dirFilter === null
                    ? 'bg-brand/15 text-brand'
                    : 'bg-surface-hover text-foreground-subtle hover:text-foreground',
                )}
              >
                全部目录
              </button>
              {dirs.map((d) => (
                <button
                  key={d.dir}
                  type="button"
                  onClick={() => setDirFilter(dirFilter === d.dir ? null : d.dir === '(根目录)' ? '.' : d.dir)}
                  className={cn(
                    'rounded-full px-2.5 py-1 text-[12px] transition-colors',
                    (dirFilter ?? '') === (d.dir === '(根目录)' ? '.' : d.dir)
                      ? 'bg-brand/15 text-brand'
                      : 'bg-surface-hover text-foreground-subtle hover:text-foreground',
                  )}
                  title={`${d.dir} · ${d.count} 个文件`}
                >
                  {d.dir}
                  <span className="ml-1 text-foreground-subtlest">{d.count}</span>
                </button>
              ))}
              <span className="mx-1 h-4 w-px bg-border" />
              {langCounts.map(([lang, count]) => (
                <span
                  key={lang}
                  className="flex items-center gap-1 text-[12px] text-foreground-subtle"
                  title={langLabel(lang)}
                >
                  <span className="size-2 rounded-full" style={{ background: langColor(lang) }} />
                  {langLabel(lang)} {count}
                </span>
              ))}
            </div>

            {data.stats.truncated && (
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-[12px] text-amber-500">
                项目文件较多,仅扫描了前 {fmtNum(data.stats.files)} 个源文件,图谱可能不完整。
              </div>
            )}

            {/* 图谱画布(高度自适应视口) */}
            <div className="relative h-[calc(100dvh-320px)] min-h-[420px]">
              <GraphCanvas
                graph={data}
                hideIsolated={hideIsolated}
                dirFilter={dirFilter}
                query={query}
                showLabels={showLabels}
                selectedId={selectedId}
                onSelect={setSelectedId}
                onOpenFile={handleOpenFile}
              />
              {opening && (
                <div className="absolute inset-0 z-20 flex items-center justify-center rounded-xl bg-background/60 backdrop-blur-sm">
                  <Loader2 className="size-5 animate-spin text-brand" />
                </div>
              )}
            </div>

            {/* 外部依赖 */}
            {data.stats.external.length > 0 && (
              <div>
                <div className="mb-1.5 flex items-center gap-1 text-[12px] font-medium text-foreground-subtle">
                  <Package className="size-3.5" />
                  外部依赖 Top {Math.min(24, data.stats.external.length)}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {data.stats.external.slice(0, 24).map((d) => (
                    <span
                      key={d.name}
                      className="rounded-full bg-surface-hover px-2.5 py-1 text-[12px] text-foreground-subtle"
                      title={`被 ${d.count} 个文件引用`}
                    >
                      {d.name}
                      <span className="ml-1 text-foreground-subtlest">{d.count}</span>
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </ViewScroll>
  );
}
