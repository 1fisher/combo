/**
 * 相机二维码扫描。
 *
 * 优先使用浏览器原生 BarcodeDetector(Android Chrome 等);
 * iOS Safari 无 BarcodeDetector,回退到纯 JS 的 `jsqr`(零依赖、兼容性好)。
 * 只在确实需要扫码时经 getUserMedia 请求相机权限(https/本地回环安全上下文)。
 */

export interface QrScanHandle {
  stop: () => void;
}

/** 每帧从 ImageData 识别二维码文本,返回 null 表示本帧未识别到。 */
type Decoder = (imageData: ImageData) => Promise<string | null>;

async function createQrDecoder(): Promise<Decoder | null> {
  const BarcodeDetectorCtor = (window as unknown as { BarcodeDetector?: new (o: { formats: string[] }) => { detect: (d: ImageData) => Promise<{ rawValue: string }[]> } }).BarcodeDetector;
  if (BarcodeDetectorCtor) {
    try {
      const detector = new BarcodeDetectorCtor({ formats: ['qr_code'] });
      return async (imageData) => {
        try {
          const codes = await detector.detect(imageData);
          return codes && codes.length > 0 ? codes[0].rawValue : null;
        } catch {
          return null;
        }
      };
    } catch {
      /* BarcodeDetector 构造失败则走 jsqr */
    }
  }
  try {
    const jsqr = (await import('jsqr')).default;
    return async (imageData) => {
      const res = jsqr(imageData.data, imageData.width, imageData.height);
      return res ? res.data : null;
    };
  } catch {
    return null;
  }
}

/**
 * 启动相机并把取景框中识别到的二维码文本回调给 onResult。
 * 返回 { stop } 用于在卸载/出错时停止相机与检测循环。
 */
export async function startQrScan(
  video: HTMLVideoElement,
  onResult: (text: string) => void,
  opts: { onError?: (e: unknown) => void } = {},
): Promise<QrScanHandle> {
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: 'environment', width: { ideal: 640 }, height: { ideal: 480 } },
    });
  } catch (e) {
    opts.onError?.(e);
    throw e;
  }

  video.srcObject = stream;
  video.setAttribute('playsinline', '');
  video.muted = true;
  video.playsInline = true;
  try {
    await video.play();
  } catch (e) {
    stream.getTracks().forEach((t) => t.stop());
    throw e;
  }

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) {
    stream.getTracks().forEach((t) => t.stop());
    throw new Error('无法创建画布');
  }

  const decoder = await createQrDecoder();
  let stopped = false;

  // 串行化识别,避免上一帧的异步检测尚未返回就开启下一帧。
  let detecting = false;
  const loop = async () => {
    if (stopped) return;
    try {
      if (video.readyState >= 2 && video.videoWidth > 0) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        ctx.drawImage(video, 0, 0);
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        if (decoder && !detecting) {
          detecting = true;
          try {
            const text = await decoder(imageData);
            if (text) {
              onResult(text);
              stop();
              return;
            }
          } finally {
            detecting = false;
          }
        }
      }
    } catch {
      /* 单帧识别异常忽略 */
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);

  const stop = () => {
    stopped = true;
    stream.getTracks().forEach((t) => t.stop());
    video.srcObject = null;
  };
  return { stop };
}
