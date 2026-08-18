import { useCallback, useEffect, useRef, useState } from 'react';
import { getTranscribeStatus, prepareTranscribe, ApiError } from '../lib/api';
import { float32ToPcm16, mergeDictationTail, playDictationChime } from '../lib/audio';
import { AsrStream } from '../lib/asrStream';

/** 单次录音上限(秒):离线模型按静音分段,放宽到 10 分钟兜底。 */
const MAX_RECORD_SECONDS = 600;
/** 等待模型下载/就绪的上限(毫秒)。 */
const PREPARE_TIMEOUT_MS = 15 * 60_000;
const POLL_INTERVAL_MS = 1500;
/** 聚帧阈值(采样数):16kHz 下约 100ms 一帧,避免 WS 逐 128 采样刷屏。 */
const FRAME_SAMPLES = 1600;
/** 首次录音模型未就绪时,客户端缓存的音频上限(采样数,约 5 分钟)。 */
const MAX_BUFFERED_SAMPLES = 16000 * 60 * 5;

/**
 * AudioWorklet 处理器:立体声降混为单声道 Float32,transfer 给主线程。
 * (inline Blob 加载,避免为几十行代码单发静态资源)
 */
const WORKLET_SOURCE = `
class ComboPcmCollector extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (input && input.length > 0 && input[0]) {
      const ch0 = input[0];
      let mono = ch0;
      if (input.length > 1 && input[1]) {
        mono = new Float32Array(ch0.length);
        const ch1 = input[1];
        for (let i = 0; i < ch0.length; i++) mono[i] = (ch0[i] + ch1[i]) / 2;
      } else {
        mono = ch0.slice(0);
      }
      this.port.postMessage(mono, [mono.buffer]);
    }
    return true;
  }
}
registerProcessor('combo-pcm-collector', ComboPcmCollector);
`;

export type DictationState = 'idle' | 'recording' | 'transcribing';

/** 麦克风访问失败的分类结果:用户可读文案 + 是否需要引导打开系统权限设置。 */
function describeMicError(err: unknown): { message: string; openSettings: boolean } {
  // 非安全上下文(远程 http 访问等)下浏览器直接拒绝,引导系统设置是误导
  if (typeof window !== 'undefined' && window.isSecureContext === false) {
    return {
      message: '当前页面不是安全上下文(需 HTTPS 或 localhost),浏览器禁止访问麦克风',
      openSettings: false,
    };
  }
  const name = err instanceof DOMException ? err.name : (err as Error)?.name;
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      // 桌面端:系统设置里允许麦克风;浏览器端:站点权限或系统设置
      return {
        message: '无法访问麦克风:权限被拒绝,请在系统设置中允许 Combo 使用麦克风',
        openSettings: true,
      };
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return { message: '未检测到可用的麦克风设备,请检查连接后重试', openSettings: false };
    case 'NotReadableError':
    case 'TrackStartError':
      return { message: '麦克风正被其他应用占用,请关闭占用后重试', openSettings: false };
    case 'AbortError':
      return { message: '麦克风访问被中断,请重试', openSettings: false };
    default:
      return { message: '无法访问麦克风,请检查系统权限', openSettings: false };
  }
}

/**
 * 语音听写:点击开始录音,再点停止并把识别文本追加到输入框。
 *
 * - 后端本地离线识别模型(设置中可选 SenseVoice 中文 / Moonshine 中英),
 *   WebSocket 边说边出字(`partial` 实时刷新,停止后 `final` 一次性追加),
 *   不上传音频到第三方;
 * - 识别文本分「已确认(分段固化)」与「推断(当前段)」两部分:确认部分
 *   单调稳定、不会在说话中消失,推断部分实时修正(类似输入法组合动画);
 * - 16kHz 单声道经 AudioWorklet 直接采集,无需 MediaRecorder 离线解码;
 * - 开始录音时即触发模型准备(首次使用需下载约 272MB,期间音频在客户端
 *   缓冲,模型就绪后自动建立连接并补发,录音与下载并行)。
 */
export function useDictation(onText: (text: string) => void) {
  const [state, setState] = useState<DictationState>('idle');
  const [seconds, setSeconds] = useState(0);
  /** 听写中的预输入文本:已确认(分段固化)部分 + 当前段推断部分。 */
  const [pending, setPending] = useState({ confirmed: '', partial: '' });
  /** 模型下载进度(0~1);null 表示无需展示。 */
  const [modelProgress, setModelProgress] = useState<number | null>(null);
  const [error, setError] = useState('');
  /** 麦克风权限被拒时提示「打开系统权限设置」的引导。 */
  const [errorAction, setErrorAction] = useState<'open-settings' | null>(null);

  const ctxRef = useRef<AudioContext | null>(null);
  const trackRef = useRef<MediaStreamTrack[] | null>(null);
  const startedAtRef = useRef(0);
  const timerRef = useRef<number | null>(null);
  const prepareKickedRef = useRef(false);
  const onTextRef = useRef(onText);
  onTextRef.current = onText;

  /** 流式识别连接;模型未就绪时为 null,就绪后由 connectStream 建立。 */
  const streamRef = useRef<AsrStream | null>(null);
  /** 建立连接的异步任务(停止录音时等待其完成再收尾)。 */
  const connectPromiseRef = useRef<Promise<void> | null>(null);
  /** 连接就绪前缓存的音频(首录下载模型期间录音不丢)。 */
  const bufferedRef = useRef<Int16Array[]>([]);
  const bufferedSamplesRef = useRef(0);
  /** 聚帧累积(不足 FRAME_SAMPLES 的尾采样)。 */
  const frameRemainderRef = useRef<Float32Array>(new Float32Array(0));
  const cancelledRef = useRef(false);

  const cleanupCapture = useCallback(() => {
    if (timerRef.current != null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
    trackRef.current?.forEach((t) => t.stop());
    trackRef.current = null;
    void ctxRef.current?.close().catch(() => {});
    ctxRef.current = null;
  }, []);

  const teardownSession = useCallback(() => {
    streamRef.current?.close();
    streamRef.current = null;
    bufferedRef.current = [];
    bufferedSamplesRef.current = 0;
    frameRemainderRef.current = new Float32Array(0);
    connectPromiseRef.current = null;
  }, []);

  useEffect(() => {
    return () => {
      cancelledRef.current = true;
      cleanupCapture();
      teardownSession();
    };
  }, [cleanupCapture, teardownSession]);

  /** 确保后端语音模型就绪(未就绪则触发下载并轮询进度)。 */
  const ensureModelReady = useCallback(async (): Promise<void> => {
    const deadline = Date.now() + PREPARE_TIMEOUT_MS;
    for (;;) {
      let status;
      try {
        status = await getTranscribeStatus();
      } catch (e) {
        throw new Error(e instanceof ApiError ? e.message : '无法连接后端语音服务');
      }
      setModelProgress(
        status.phase === 'downloading' && typeof status.progress === 'number'
          ? status.progress
          : null
      );
      if (status.ready) return;
      if (status.phase === 'not_ready' || status.phase === 'failed') {
        try {
          // not_ready:首次触发下载;failed:重新触发(如上次网络中断)
          await prepareTranscribe();
        } catch {
          /* 下载触发失败由下一轮 status 反映 */
        }
      }
      if (Date.now() > deadline) {
        throw new Error('语音模型准备超时,请检查网络后重试');
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
  }, []);

  /** 等模型就绪后建立流式连接,并补发缓存的音频。 */
  const connectStream = useCallback(async () => {
    try {
      await ensureModelReady();
    } catch (e) {
      setError(e instanceof Error ? e.message : '语音模型准备失败');
      return;
    }
    if (cancelledRef.current) return;
    try {
      const stream = await AsrStream.open(16000, {
        onPartial: (text, finalized) => {
          if (cancelledRef.current) return;
          // 保持已确认前缀稳定,只更新推断尾巴(收尾回缩时保留旧推断待替换)
          setPending((prev) =>
            mergeDictationTail(prev.confirmed + prev.partial, text, finalized)
          );
        },
      });
      // 等待期间录音可能已被取消(过短或组件卸载)
      if (cancelledRef.current) {
        stream.close();
        return;
      }
      streamRef.current = stream;
      // 补发模型下载期间缓存的音频
      const buffered = bufferedRef.current;
      bufferedRef.current = [];
      bufferedSamplesRef.current = 0;
      for (const chunk of buffered) stream.sendPcm(chunk);
    } catch (e) {
      setError(e instanceof Error ? e.message : '语音识别连接失败');
    }
  }, [ensureModelReady]);

  /** AudioWorklet 输出(Float32 帧头):聚帧 → PCM16 → 直发或缓存。 */
  const handleAudioChunk = useCallback((samples: Float32Array) => {
    const remainder = frameRemainderRef.current;
    const merged = new Float32Array(remainder.length + samples.length);
    merged.set(remainder);
    merged.set(samples, remainder.length);
    let offset = 0;
    while (merged.length - offset >= FRAME_SAMPLES) {
      const frame = merged.subarray(offset, offset + FRAME_SAMPLES);
      const pcm = float32ToPcm16(frame);
      const stream = streamRef.current;
      if (stream) {
        stream.sendPcm(pcm);
      } else if (bufferedSamplesRef.current < MAX_BUFFERED_SAMPLES) {
        bufferedRef.current.push(pcm);
        bufferedSamplesRef.current += pcm.length;
      }
      offset += FRAME_SAMPLES;
    }
    frameRemainderRef.current = merged.slice(offset);
  }, []);

  const finishRecording = useCallback(async () => {
    // 关闭提示音:用户点停止或达到时长上限自动收尾时播放
    playDictationChime('stop');
    const duration = (Date.now() - startedAtRef.current) / 1000;
    cleanupCapture();
    if (duration < 0.3) {
      cancelledRef.current = true;
      teardownSession();
      setState('idle');
      return;
    }
    setState('transcribing');
    try {
      // 连接尚未建立(首录模型还在下载)时,等连接就绪后收尾
      if (connectPromiseRef.current) {
        await connectPromiseRef.current;
      }
      const stream = streamRef.current;
      if (!stream) throw new Error('语音识别服务连接失败');
      // 补发聚帧剩余的尾采样,保证最后一句话也送进模型
      const tail = float32ToPcm16(frameRemainderRef.current);
      if (tail.length > 0) stream.sendPcm(tail);
      frameRemainderRef.current = new Float32Array(0);
      const text = await stream.finish();
      stream.close();
      streamRef.current = null;
      if (text.trim()) onTextRef.current(text);
    } catch (e) {
      setError(e instanceof Error ? e.message : '语音识别失败');
    } finally {
      setModelProgress(null);
      setPending({ confirmed: '', partial: '' });
      setState('idle');
    }
  }, [cleanupCapture, teardownSession]);

  const startRecording = useCallback(async () => {
    setError('');
    setErrorAction(null);
    setPending({ confirmed: '', partial: '' });
    cancelledRef.current = false;
    teardownSession();
    if (!navigator.mediaDevices?.getUserMedia || typeof AudioContext === 'undefined') {
      setError('当前环境不支持录音');
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
    } catch (e) {
      const detail = describeMicError(e);
      setError(detail.message);
      setErrorAction(detail.openSettings ? 'open-settings' : null);
      return;
    }
    trackRef.current = stream.getTracks();
    let ctx: AudioContext;
    try {
      ctx = new AudioContext({ sampleRate: 16000 });
    } catch {
      trackRef.current.forEach((t) => t.stop());
      trackRef.current = null;
      setError('当前环境不支持 16kHz 录音');
      return;
    }
    ctxRef.current = ctx;
    let source: MediaStreamAudioSourceNode;
    let workletUrl: string | null = null;
    try {
      workletUrl = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'application/javascript' }));
      await ctx.audioWorklet.addModule(workletUrl);
      source = ctx.createMediaStreamSource(stream);
      const node = new AudioWorkletNode(ctx, 'combo-pcm-collector');
      node.port.onmessage = (ev) => {
        if (ev.data instanceof Float32Array) handleAudioChunk(ev.data);
      };
      source.connect(node);
      // 不接 destination 时部分浏览器不会拉取 worklet(输出静音,仅用于驱动处理)
      node.connect(ctx.destination);
    } catch {
      cleanupCapture();
      setError('当前环境不支持实时音频采集');
      return;
    } finally {
      if (workletUrl) URL.revokeObjectURL(workletUrl);
    }
    // 首次使用即触发模型准备,下载与录音并行;就绪后自动建立流式连接
    if (!prepareKickedRef.current) {
      prepareKickedRef.current = true;
      void getTranscribeStatus()
        .then((s) => {
          if (!s.ready && s.phase !== 'downloading' && s.phase !== 'loading') {
            return prepareTranscribe();
          }
          return undefined;
        })
        .catch(() => {
          /* 连接流里还会重试 */
        });
    }
    connectPromiseRef.current = connectStream();
    startedAtRef.current = Date.now();
    setSeconds(0);
    setState('recording');
    timerRef.current = window.setInterval(() => {
      const s = Math.floor((Date.now() - startedAtRef.current) / 1000);
      setSeconds(s);
      if (s >= MAX_RECORD_SECONDS) {
        window.clearInterval(timerRef.current!);
        timerRef.current = null;
        void finishRecording();
      }
    }, 1000);
  }, [cleanupCapture, connectStream, finishRecording, handleAudioChunk, teardownSession]);

  const toggle = useCallback(() => {
    if (state === 'recording') {
      void finishRecording();
      return;
    }
    if (state === 'idle') {
      // 开启提示音:必须在用户点击手势内同步播放,AudioContext 才能被
      // autoplay 策略放行(await getUserMedia 之后手势已失效)
      playDictationChime('start');
      void startRecording();
    }
  }, [state, startRecording, finishRecording]);

  /** 放弃当前识别:停止录音、丢弃未提交的识别文本(不追加到输入框)。 */
  const cancel = useCallback(() => {
    cancelledRef.current = true;
    cleanupCapture();
    teardownSession();
    setModelProgress(null);
    setPending({ confirmed: '', partial: '' });
    setError('');
    setErrorAction(null);
    setState('idle');
  }, [cleanupCapture, teardownSession]);

  return {
    state,
    seconds,
    /** 已确认(分段固化)的识别文本,录音期间稳定保留、不会被回退擦除。 */
    confirmedText: pending.confirmed,
    /** 当前段的推断文本,随重解码实时修正。 */
    partialText: pending.partial,
    modelProgress,
    error,
    /** 麦克风权限被拒时置为 'open-settings',前端据此渲染「打开权限设置」按钮。 */
    errorAction,
    toggle,
    cancel,
  };
}
