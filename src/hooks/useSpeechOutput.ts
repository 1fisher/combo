import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ApiError, getSpeechStatus, prepareSpeech, synthesizeSpeech } from '../lib/api';
import { useAgentStore } from '../stores/agentStore';
import { splitSentences } from '../lib/ttsSplit';

/** 待处理缓冲上限(字符):防止超长未成句内容(如大段代码块)无限累积。 */
const MAX_PENDING_CHARS = 4000;
/** 模型下载/加载等待超时(镜像 useDictation)。 */
const PREPARE_TIMEOUT_MS = 15 * 60_000;
/** 模型就绪轮询间隔。 */
const POLL_INTERVAL_MS = 1000;

/** 提取一条消息的全部 text part 文本(非 assistant 返回空)。 */
function textOf(m: { role: string; parts: Array<{ type: string; data?: unknown }> }): string {
  if (m.role !== 'assistant') return '';
  return m.parts
    .filter((p) => p.type === 'text')
    .map((p) => ((p as { data: { text?: string } }).data?.text ?? ''))
    .join('');
}

/**
 * 语音朗读 agent 回复(流式按句):
 *
 * - 仅后端配置 `[tts] enabled` 打开时工作(经 getSpeechStatus 轮询);
 * - 订阅当前会话 assistant 文本增量(只取 text part),按句末标点/换行断句
 *   (代码块围栏内容跳过,断句器跨增量保持围栏状态);
 * - 完整句子经 `POST /v1/speech` 合成 WAV,AudioContext 解码后 FIFO 顺序播放;
 * - 只朗读「本次 run 的增量」:run 开始时把历史消息全部标记为已消费;
 * - 打断:新发消息 / 切换会话 / 关闭开关 / run 出错或取消
 *   → 停播 + 清空缓冲与已消费偏移。
 */
export function useSpeechOutput() {
  const enabled = useQuery({
    queryKey: ['tts-status'],
    queryFn: getSpeechStatus,
  }).data?.enabled ?? false;
  /** 模型下载进度(0~1);null 表示无需展示(未下载或已就绪)。 */
  const [modelProgress, setModelProgress] = useState<number | null>(null);

  const sessionId = useAgentStore((s) => s.activeSessionId);
  const messages = useAgentStore((s) =>
    s.activeSessionId ? s.bySession[s.activeSessionId]?.messages : undefined
  );
  const run = useAgentStore((s) =>
    s.activeSessionId ? s.bySession[s.activeSessionId]?.run : undefined
  );

  const ctxRef = useRef<AudioContext | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const activeSrcRef = useRef<AudioBufferSourceNode | null>(null);
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  /** 打断代次:每次 stop 自增,已入队句子在轮到播放时发现代次不符则跳过。 */
  const epochRef = useRef(0);
  const sessionRef = useRef<string | null>(null);
  /** 每消息已消费的文本长度(messageId → 字符偏移)。 */
  const consumedRef = useRef<Map<string, number>>(new Map());
  const pendingRef = useRef('');
  /** 已对哪个 run 做过历史基线(防止 run 期间消息变化导致重复基线化吃掉新文本)。 */
  const baselinedRunRef = useRef<string | null>(null);

  /** 打断朗读:取消在途合成、停播当前音频,已入队的句子全部作废。 */
  const stop = useCallback(() => {
    epochRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    activeSrcRef.current?.stop();
    activeSrcRef.current = null;
    setModelProgress(null);
  }, []);

  /**
   * 等待语音模型就绪:未就绪/失败时触发后台下载(POST /v1/speech/prepare),
   * 轮询 /v1/speech/status 并把下载进度写入 modelProgress;就绪即返回。
   */
  const waitModelReady = useCallback(async (): Promise<void> => {
    const deadline = Date.now() + PREPARE_TIMEOUT_MS;
    for (;;) {
      let status: Awaited<ReturnType<typeof getSpeechStatus>> | undefined;
      try {
        status = await getSpeechStatus();
      } catch {
        /* 状态查询失败按未就绪处理,下一轮重试 */
      }
      if (status) {
        if (status.ready) {
          setModelProgress(null);
          return;
        }
        setModelProgress(
          status.phase === 'downloading' && typeof status.progress === 'number'
            ? status.progress
            : null
        );
        if (status.phase === 'not_ready' || status.phase === 'failed') {
          try {
            await prepareSpeech();
          } catch {
            /* 触发失败由下一轮 status 反映 */
          }
        }
      }
      if (Date.now() > deadline) {
        setModelProgress(null);
        throw new Error('语音模型准备超时,请检查网络后重试');
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
  }, []);

  /** 把一句文本合成并播放(入队,顺序播放)。 */
  const speak = useCallback((sentence: string) => {
    const text = sentence.trim();
    if (!text) return;
    const epoch = epochRef.current;
    queueRef.current = queueRef.current
      .then(async () => {
        if (epoch !== epochRef.current) return;
        abortRef.current?.abort();
        abortRef.current = new AbortController();
        let wav: ArrayBuffer;
        try {
          wav = await synthesizeSpeech(text, abortRef.current.signal);
        } catch (e) {
          // 模型未就绪(首次朗读触发下载):等待就绪并展示进度,然后重试该句
          if (e instanceof ApiError && e.code === 'tts_not_ready') {
            try {
              await waitModelReady();
            } catch {
              return; // 准备超时/失败:跳过该句
            }
            if (epoch !== epochRef.current) return;
            try {
              wav = await synthesizeSpeech(text, abortRef.current.signal);
            } catch {
              return; // 仍失败(如已关闭朗读):静默跳过
            }
          } else {
            return; // tts_disabled / 已取消:静默跳过
          }
        }
        if (epoch !== epochRef.current) return;
        const ctx =
          ctxRef.current ??
          (ctxRef.current = new AudioContext());
        if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
        const buffer = await ctx.decodeAudioData(wav);
        if (epoch !== epochRef.current) return;
        await new Promise<void>((resolve) => {
          const src = ctx.createBufferSource();
          src.buffer = buffer;
          src.connect(ctx.destination);
          src.onended = () => {
            if (activeSrcRef.current === src) activeSrcRef.current = null;
            resolve();
          };
          activeSrcRef.current = src;
          src.start();
        });
      })
      .catch(() => {
        /* 单句失败不阻断后续句子 */
      });
  }, []);

  // 开关关闭:停读并清空全部状态
  useEffect(() => {
    if (enabled) return;
    stop();
    pendingRef.current = '';
    consumedRef.current = new Map();
  }, [enabled, stop]);

  // run 开始:把该时刻的消息全部标记为已消费(只朗读本次运行的增量,不读历史);
  // runId 守卫保证同一 run 期间消息变化不会重复基线化(吃掉新文本)
  useEffect(() => {
    if (!enabled) return;
    if (run?.status !== 'running') {
      baselinedRunRef.current = null;
      return;
    }
    if (baselinedRunRef.current === run.runId) return;
    baselinedRunRef.current = run.runId;
    const cur = new Map<string, number>();
    for (const m of messages ?? []) {
      cur.set(m.id, textOf(m).length);
    }
    consumedRef.current = cur;
    pendingRef.current = '';
  }, [run, enabled, messages]);

  // 文本增量 → 断句 → 入队;切换会话 → 打断(仅 run 进行中处理)
  useEffect(() => {
    if (!enabled || run?.status !== 'running') return;
    if (sessionId !== sessionRef.current) {
      sessionRef.current = sessionId;
      consumedRef.current = new Map();
      pendingRef.current = '';
      stop();
    }
    if (!sessionId || !messages) return;
    let pending = pendingRef.current;
    for (const m of messages) {
      const text = textOf(m);
      const consumed = consumedRef.current.get(m.id) ?? 0;
      if (text.length > consumed) {
        pending += text.slice(consumed);
        consumedRef.current.set(m.id, text.length);
      }
    }
    if (pending.length > MAX_PENDING_CHARS) {
      pending = pending.slice(-MAX_PENDING_CHARS);
    }
    pendingRef.current = pending;
    const { sentences, rest } = splitSentences(pending);
    pendingRef.current = rest;
    for (const s of sentences) void speak(s);
  }, [messages, sessionId, enabled, run?.status, speak, stop]);

  // run 结束:正常结束先补消费最终版文本再冲刷;出错/取消丢弃缓冲
  useEffect(() => {
    if (!enabled || run?.status !== 'done') return;
    if (run.error) {
      pendingRef.current = '';
      stop();
      return;
    }
    let pending = pendingRef.current;
    for (const m of messages ?? []) {
      const text = textOf(m);
      const consumed = consumedRef.current.get(m.id) ?? 0;
      if (text.length > consumed) {
        pending += text.slice(consumed);
        consumedRef.current.set(m.id, text.length);
      }
    }
    pendingRef.current = '';
    if (!pending) return;
    const { sentences } = splitSentences(pending + '\n');
    for (const s of sentences) void speak(s);
  }, [run, enabled, messages, speak, stop]);

  // 卸载:清理
  useEffect(() => {
    return () => {
      stop();
      void ctxRef.current?.close().catch(() => {});
      ctxRef.current = null;
    };
  }, [stop]);

  return { modelProgress };
}
