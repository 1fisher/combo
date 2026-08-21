import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useAgentStore } from '../../stores/agentStore';
import { formatTokenCount } from '../../lib/tokens';

/** 格式化执行耗时:mm:ss,超过 1 小时为 h:mm:ss */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** 流式输出速度采样间隔(毫秒) */
const SPEED_SAMPLE_MS = 500;

/** 流式滚动预览的尾部截断字符数(按 Unicode 码点):足够把胶囊撑到最大宽度
 * (CJK ~12px/字 → 240 字 ≈ 2880px,超出任意面板宽度),超出保留尾部并加省略号 */
const PREVIEW_MAX_CHARS = 240;

/** 结构化 part 形状:兼容 Api.ContentPart(text/reasoning),避免耦合生成类型 */
interface PartLike {
  type: unknown;
  data?: unknown;
}

function partText(p: PartLike): string {
  if (p.type === 'text') {
    const d = p.data as { text?: unknown } | undefined;
    return typeof d?.text === 'string' ? d.text : '';
  }
  if (p.type === 'reasoning') {
    const d = p.data as { thinking?: unknown } | undefined;
    return typeof d?.thinking === 'string' ? d.thinking : '';
  }
  return '';
}

/**
 * 提取当前流式输出的滚动预览(单行):把所有流式消息的 text/reasoning part
 * (思考与正文)按出现顺序全部拼接,折叠所有空白(换行/markdown 缩进压成单空格),
 * 超长保留尾部并加「…」前缀 —— 搭配 justify-end + overflow-hidden 渲染,
 * 内容把胶囊撑到最大宽度后,最新文字始终贴右可见、旧内容从左边滚出隐藏,
 * 形成滚动条带效果。
 */
export function streamTailPreview(
  rt: { messages: { streaming: boolean; parts: ReadonlyArray<PartLike> }[] } | undefined,
  maxChars = PREVIEW_MAX_CHARS,
): string {
  const chunks: string[] = [];
  for (const m of rt?.messages ?? []) {
    if (!m.streaming) continue;
    for (const p of m.parts) {
      const v = partText(p);
      if (v) chunks.push(v);
    }
  }
  const raw = chunks.join(' ').replace(/\s+/g, ' ').trim();
  if (!raw) return '';
  const chars = Array.from(raw);
  if (chars.length <= maxChars) return raw;
  return '…' + chars.slice(-maxChars).join('');
}

/**
 * 采样当前流式输出速度,EMA 平滑为字符/秒。
 * 与 Composer 火焰热力同源:工具执行期无流式内容,速度自然衰减到 0。
 */
export function useStreamCharRate(active: boolean): number {
  const [rate, setRate] = useState(0);
  useEffect(() => {
    if (!active) {
      setRate(0);
      return;
    }
    let lastLen = -1;
    let lastTime = performance.now();
    let ema = 0;
    const tick = () => {
      const st = useAgentStore.getState();
      const rt = st.activeSessionId ? st.bySession[st.activeSessionId] : undefined;
      let len = 0;
      for (const m of rt?.messages ?? []) {
        if (!m.streaming) continue;
        for (const p of m.parts) {
          len += partText(p).length;
        }
      }
      const now = performance.now();
      const dt = (now - lastTime) / 1000;
      lastTime = now;
      if (lastLen >= 0 && dt > 0) {
        const target = Math.max((len - lastLen) / dt, 0);
        ema = ema === 0 ? target : ema * 0.7 + target * 0.3;
        setRate(ema);
      }
      lastLen = len;
    };
    tick();
    const id = window.setInterval(tick, SPEED_SAMPLE_MS);
    return () => window.clearInterval(id);
  }, [active]);
  return rate;
}

/**
 * 采样当前流式输出的尾部预览(与速度同频 500ms):SSE 每个 delta 都会更新
 * store,若用订阅式 selector 会让本组件随每帧流式内容重渲染,采样式把
 * 渲染频率钉在 2Hz,内容「滚动推进」的观感不受影响。
 */
export function useStreamPreview(active: boolean): string {
  const [preview, setPreview] = useState('');
  useEffect(() => {
    if (!active) {
      setPreview('');
      return;
    }
    const tick = () => {
      const st = useAgentStore.getState();
      const rt = st.activeSessionId ? st.bySession[st.activeSessionId] : undefined;
      setPreview(streamTailPreview(rt));
    };
    tick();
    const id = window.setInterval(tick, SPEED_SAMPLE_MS);
    return () => window.clearInterval(id);
  }, [active]);
  return preview;
}

/**
 * 运行中指示器:贴在输入坞(composer)上方,展示「正在执行 + 流式输出速度 +
 * 累计耗时 + 流式滚动预览(思考与正文拼接,单行)」:内容增长时把胶囊撑向
 * 最大宽度,到达后新文字从右侧进入、旧文字从左侧溢出裁切(justify-end +
 * overflow-hidden),附带流光特效(高光自左向右循环扫过,见 index.css 的
 * .run-shimmer,光带宽度随胶囊宽度自适应)。
 */
export function RunningIndicator({ startedAt }: { startedAt?: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const streamRate = useStreamCharRate(startedAt != null);
  const preview = useStreamPreview(startedAt != null);
  if (startedAt == null) return null;
  return (
    <div
      role="status"
      className="relative mb-2 flex w-fit max-w-full items-center gap-2 overflow-hidden rounded-full border border-brand/25 bg-brand/10 px-3 py-1 text-xs"
    >
      <Loader2 className="size-3 shrink-0 animate-spin text-brand" />
      <span className="shrink-0 font-medium text-foreground">正在执行</span>
      {streamRate >= 1 && (
        <span className="shrink-0 font-mono tabular-nums text-foreground-subtle">
          {formatTokenCount(streamRate)} 字/s
        </span>
      )}
      <span className="shrink-0 font-mono tabular-nums text-foreground-subtle">
        {formatElapsed(now - startedAt)}
      </span>
      {preview && (
        // 单行滚动预览:不设固定 max-w,内容把胶囊(w-fit max-w-full)撑向
        // 最大宽度;溢出时容器收缩(min-w-0)、内容右对齐、左侧溢出裁切
        // (justify-end + overflow-hidden),流式内容增长时最新文字始终贴右
        // 可见、旧文字从左边滚出隐藏。
        // aria-hidden:纯状态装饰,避免屏幕阅读器被不断更新的碎片打断。
        <span
          aria-hidden
          title={preview}
          className="flex min-w-0 justify-end overflow-hidden"
        >
          <span className="shrink-0 whitespace-nowrap text-foreground-subtle/80">{preview}</span>
        </span>
      )}
      {/* 流光层:纯装饰 */}
      <span className="run-shimmer" aria-hidden />
    </div>
  );
}
