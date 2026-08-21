import type { Api } from './api/types';
import { uploadAttachment } from './api';
import { randomUUID } from './clientId';
import { getProxyBaseUrl } from './connection';
import { getClientId } from './clientId';
import { getAccessToken } from './authToken';

/** 图片扩展名(与后端 WireAttachment::is_image 的判定保持一致) */
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp']);

/** 单个上传文件大小上限(与后端 MAX_UPLOAD_BYTES 一致)。 */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

/** 判断是否图片附件:mime 优先,扩展名兜底。 */
export function isImageFile(mime: string | undefined, name: string): boolean {
  if (mime && mime.startsWith('image/')) return true;
  const ext = name.toLowerCase().split('.').pop() ?? '';
  return IMAGE_EXTS.has(ext);
}

/**
 * 输入框附件的本地运行时态:在 wire 类型 Api.Attachment 基础上附加
 * 上传进度与预览信息,发送时剥离回纯 wire 字段。
 */
export interface LocalAttachment {
  /** 稳定 key:上传中为本地 UUID,完成后等于 file_path(chip 列表渲染去重) */
  key: string;
  file_path: string;
  file_name: string;
  mime_type?: string;
  /** 图片附件(chip 显示缩略图、乐观消息显示 image part) */
  isImage: boolean;
  /** 上传中:chip 显示 spinner,发送时过滤掉 */
  uploading: boolean;
  /** 上传失败文案:chip 显示错误态,可手动移除 */
  error?: string;
  /** 图片缩略图(blob URL,仅当前页面会话有效) */
  previewUrl?: string;
}

/** 发送给后端的 wire 附件(剥离本地运行时字段,过滤未完成/失败项)。 */
export function toWireAttachments(list: LocalAttachment[]): Api.Attachment[] {
  return list
    .filter((a) => !a.uploading && !a.error)
    .map((a) => ({
      file_path: a.file_path,
      file_name: a.file_name,
      ...(a.mime_type ? { mime_type: a.mime_type } : {}),
    }));
}

/** 立即为待上传文件构造本地态(上传中 chip),完成后由调用方回填。 */
export function pendingAttachmentFromFile(file: File): LocalAttachment {
  const isImage = isImageFile(file.type, file.name);
  const key = randomUUID();
  return {
    key,
    file_path: `pending-${key}`,
    file_name: file.name || key,
    mime_type: file.type || undefined,
    isImage,
    uploading: true,
    previewUrl: isImage ? URL.createObjectURL(file) : undefined,
  };
}

/** 读取文件字节:优先标准 Blob.arrayBuffer,jsdom 等环境回退 Response。 */
async function fileToArrayBuffer(file: File): Promise<ArrayBuffer> {
  if (typeof file.arrayBuffer === 'function') return file.arrayBuffer();
  return new Response(file).arrayBuffer();
}

/** 上传一个文件到 workspace,返回更新后的本地态。 */
export async function uploadLocalAttachment(
  workspaceId: string,
  att: LocalAttachment,
  file: File
): Promise<LocalAttachment> {
  const buf = await fileToArrayBuffer(file);
  const res = await uploadAttachment(workspaceId, att.file_name, buf, {
    contentType: file.type || undefined,
  });
  return {
    ...att,
    uploading: false,
    file_path: res.path,
    file_name: res.name || att.file_name,
  };
}

/**
 * 解析消息 image_url part 的展示地址:
 * - `blob:`(乐观消息本地预览)原样返回;
 * - 后端生成的相对 API 路径(`/v1/workspaces/...`)拼 proxy base,并附加
 *   client_id 与远程访问令牌 —— `<img>` 标签无法携带 Authorization header,
 *   远程访问时鉴权只能走 `?token=` query(后端 auth::extract_token 支持)。
 */
export function resolveImageUrl(url: string): string {
  if (!url.startsWith('/v1/')) return url;
  const q = new URLSearchParams({ client_id: getClientId() });
  const token = getAccessToken();
  if (token) q.set('token', token);
  return `${getProxyBaseUrl()}${url}${url.includes('?') ? '&' : '?'}${q.toString()}`;
}
