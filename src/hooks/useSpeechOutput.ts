import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ApiError, getSpeechStatus, streamSpeech } from '../lib/api';
import { useAgentStore } from '../stores/agentStore';
import { splitSentences } from '../lib/ttsSplit';
import { waitSpeechModelReady } from '../lib/speech';
import { pcm16ToAudioBuffer } from '../lib/pcm';
import { getSharedAudioContext, markAudioScheduled } from '../lib/sfx';

/** 待处理缓冲上限(字符):防止超长未成句内容(如大段代码块)无限累积。 */
const MAX_PENDING_CHARS = 4000;
/** 待发句子缓冲上限(条):流式请求跟不上播放时丢弃最旧句子,防内存膨胀。 */
const MAX_QUEUED_SENTENCES = 200;

/** 片段间停顿(秒):硬边界(句末)略长于软边界(逗号)。后端已裁掉模型
 * 自带的静音尾巴并把逗号切开成独立片段,这里用短间隙无缝衔接 — 消除
 * 「标点/空格长停顿」与「等下一句合成完」的空档。 */
const HARD_GAP_SEC = 0.26;
const SOFT_GAP_SEC = 0.14;

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
 * - 完整句子积压成批,经 `POST /v1/speech/stream` 流式合成:服务端把句子
 *   再切成片段(句末/逗号边界)逐个合成,每个片段到达即按播放时间轴
 *   无缝排期(`AudioBufferSourceNode.start(at)`)— 后续片段在前一段播放
 *   期间继续合成与排期,句间不再有「合成延迟」空档;
 * - 模型未就绪(首次朗读触发下载)时等待就绪并展示进度,随后重试该批;
 * - 打断:新发消息 / 切换会话 / 关闭开关 / run 出错或取消
 *   → 中止流请求、停掉全部已排期音频、清空缓冲与已消费偏移。
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

  const abortRef = useRef<AbortController | null>(null);
  /** 已排期/播放中的音频源(打断时全部停止)。 */
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  /** 播放时间轴:下一片段的排期起点(AudioContext 时间,秒)。 */
  const nextStartRef = useRef(0);
  /** 待发送的完整句子(批量经一次流式请求合成)。 */
  const queueRef = useRef<string[]>([]);
  /** 发送泵守卫:同一时刻至多一个流式请求(保证片段顺序)。 */
  const pumpingRef = useRef(false);
  /** 打断代次:每次 stop 自增,进行中的请求/排期发现代次不符即作废。 */
  const epochRef = useRef(0);
  const sessionRef = useRef<string | null>(null);
  /** 每消息已消费的文本长度(messageId → 字符偏移)。 */
  const consumedRef = useRef<Map<string, number>>(new Map());
  const pendingRef = useRef('');
  /** 已对哪个 run 做过历史基线(防止 run 期间消息变化导致重复基线化吃掉新文本)。 */
  const baselinedRunRef = useRef<string | null>(null);

  /** 打断朗读:中止在途流请求、停掉全部已排期音频,积压句子全部作废。 */
  const stop = useCallback(() => {
    epochRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    for (const src of sourcesRef.current) {
      try {
        src.stop();
      } catch {
        /* 已结束的 source 再 stop 会抛错,忽略 */
      }
    }
    sourcesRef.current.clear();
    nextStartRef.current = 0;
    queueRef.current = [];
    setModelProgress(null);
  }, []);

  /** 收到流式片段:立即解码并按播放时间轴无缝排期(不等上一段播完)。
   * 播放走 sfx 的共享 AudioContext(手势解锁后 SSE 触发的播放同样可用,
   * 且全应用只有一个播放上下文,不占 WebKit 的并发名额)。 */
  const scheduleChunk = useCallback(
    (pcm: ArrayBuffer, sampleRate: number, hard: boolean) => {
      if (pcm.byteLength === 0 || sampleRate <= 0) return;
      const ctx = getSharedAudioContext();
      if (!ctx) return;
      const buffer = pcm16ToAudioBuffer(ctx, pcm, sampleRate);
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(ctx.destination);
      const startAt = Math.max(ctx.currentTime + 0.03, nextStartRef.current);
      src.start(startAt);
      markAudioScheduled();
      nextStartRef.current = startAt + buffer.duration + (hard ? HARD_GAP_SEC : SOFT_GAP_SEC);
      sourcesRef.current.add(src);
      src.onended = () => sourcesRef.current.delete(src);
    },
    []
  );

  /** 发送泵:把积压句子批量发给流式端点,片段边收边排期;一批完成后继续取
   * 下一批(新句子在播放期间已继续积压,合成与播放重叠)。同一时刻仅一个
   * 在途请求,片段顺序即到达顺序。 */
  const pump = useCallback(() => {
    if (pumpingRef.current) return;
    pumpingRef.current = true;
    (async () => {
      for (;;) {
        const batch = queueRef.current.splice(0);
        if (batch.length === 0) return;
        const epoch = epochRef.current;
        for (let attempt = 0; ; attempt++) {
          if (epoch !== epochRef.current) return;
          abortRef.current?.abort();
          const ac = new AbortController();
          abortRef.current = ac;
          try {
            await streamSpeech(batch.join('\n'), {
              signal: ac.signal,
              onChunk: (pcm, sr, hard) => {
                if (epoch === epochRef.current) scheduleChunk(pcm, sr, hard);
              },
            });
            break;
          } catch (e) {
            if (epoch !== epochRef.current) return;
            // 模型未就绪(首次朗读触发下载):等待就绪并展示进度,然后重试该批
            if (e instanceof ApiError && e.code === 'tts_not_ready') {
              try {
                await waitSpeechModelReady(setModelProgress);
              } catch {
                return; // 准备超时/失败:放弃该批
              }
              if (attempt >= 1) return; // 就绪后仍提示未就绪:不再无限重试
              continue;
            }
            return; // tts_disabled / 已取消 / 网络错:放弃该批
          }
        }
      }
    })()
      .catch(() => {
        /* 单批失败不阻断后续句子 */
      })
      .finally(() => {
        pumpingRef.current = false;
        // 泵运行期间又有句子积压:立即补一轮
        if (queueRef.current.length > 0) pump();
      });
  }, [scheduleChunk]);

  /** 把一句文本入队朗读(积压成批流式合成,无缝排期播放)。 */
  const speak = useCallback(
    (sentence: string) => {
      const text = sentence.trim();
      if (!text) return;
      queueRef.current.push(text);
      if (queueRef.current.length > MAX_QUEUED_SENTENCES) {
        queueRef.current.splice(0, queueRef.current.length - MAX_QUEUED_SENTENCES);
      }
      pump();
    },
    [pump]
  );

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
    for (const s of sentences) speak(s);
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
    for (const s of sentences) speak(s);
  }, [run, enabled, messages, speak, stop]);

  // 卸载:清理(共享 AudioContext 不在此关闭 —— 音效/通知仍要用它)
  useEffect(() => {
    return () => {
      stop();
    };
  }, [stop]);

  return { modelProgress };
}
