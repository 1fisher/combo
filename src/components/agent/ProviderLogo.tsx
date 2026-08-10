import type { ReactNode } from 'react';
import { Server } from 'lucide-react';
import { cn } from '../../lib/utils';

/** 供应商品牌徽标:按 provider id(兼顾 name)匹配已知供应商,渲染品牌色 + 商标;
 *  未识别的 provider 回退为首字母徽标,无 id 时用通用 Server 图标。 */

// 归一化后的 id/name → 品牌 key
const KEY_MAP: Record<string, string> = {
  deepseek: 'deepseek',
  opencode: 'opencode',
  opencodezen: 'opencode',
  opencodego: 'opencode',
  openrouter: 'openrouter',
  zhipu: 'zhipu',
  zhipuai: 'zhipu',
  zhipucoding: 'zhipu',
  glm: 'zhipu',
  openai: 'openai',
  anthropic: 'anthropic',
  claude: 'anthropic',
  gemini: 'gemini',
  google: 'gemini',
  googlegemini: 'gemini',
  ollama: 'ollama',
  moonshot: 'moonshot',
  kimi: 'moonshot',
  qwen: 'qwen',
  tongyi: 'qwen',
  tongyiqianwen: 'qwen',
  xai: 'xai',
  zai: 'xai',
  grok: 'xai',
  azure: 'azure',
  azureopenai: 'azure',
  mistral: 'mistral',
};

function normalizeKey(providerId?: string, name?: string): string | null {
  const raw = (providerId || name || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (!raw) return null;
  return KEY_MAP[raw] ?? null;
}

const LOGOS: Record<string, { bg: string; mark: ReactNode; ring?: boolean }> = {
  deepseek: {
    bg: '#4D6BFE',
    mark: (
      <svg viewBox="0 0 24 24" className="size-3" aria-hidden>
        <circle cx="9.5" cy="13.5" r="6.2" fill="#fff" />
        <path d="M15.4 10.8 21.6 7.6l-.3 5.4-4.6-.4Z" fill="#fff" />
        <path d="M6.2 6.8c.7.5 1.1 1.2 1.4 1.9" stroke="#fff" strokeWidth="1.1" strokeLinecap="round" fill="none" />
        <circle cx="5" cy="6.1" r=".9" fill="#fff" />
        <circle cx="7.6" cy="12.3" r=".8" fill="#2b3f9e" />
      </svg>
    ),
  },
  zhipu: {
    bg: 'linear-gradient(135deg, #2E5BFF, #1E3FD8)',
    mark: (
      <svg viewBox="0 0 24 24" className="size-3.5" aria-hidden>
        <text
          x="12"
          y="16.5"
          textAnchor="middle"
          fontSize="13"
          fontWeight="700"
          fill="#fff"
          fontFamily="'PingFang SC','Microsoft YaHei','Noto Sans SC',sans-serif"
        >
          智
        </text>
      </svg>
    ),
  },
  opencode: {
    bg: '#09090B',
    ring: true,
    mark: (
      <svg
        viewBox="0 0 24 24"
        className="size-3"
        fill="none"
        stroke="#fff"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <path d="M6.5 7.5 11 12l-4.5 4.5" />
        <path d="M13 16.5h5" />
      </svg>
    ),
  },
  openrouter: {
    bg: 'linear-gradient(135deg, #9061F9, #5B21B6)',
    mark: (
      <svg viewBox="0 0 24 24" className="size-3" fill="none" aria-hidden>
        <path d="M12 2.8 20 7.4v9.2l-8 4.6-8-4.6V7.4l8-4.6Z" stroke="#fff" strokeWidth="1.7" strokeLinejoin="round" />
        <circle cx="12" cy="12" r="3" fill="#fff" />
      </svg>
    ),
  },
  openai: {
    bg: '#10A37F',
    mark: (
      <svg viewBox="0 0 24 24" className="size-3.5" fill="#fff" aria-hidden>
        <path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z" />
      </svg>
    ),
  },
  anthropic: {
    bg: '#D97757',
    mark: (
      <svg viewBox="0 0 24 24" className="size-3" fill="#fff" aria-hidden>
        <path d="M12 .5 15.6 8.4 23.5 12 15.6 15.6 12 23.5 8.4 15.6.5 12 8.4 8.4Z" />
      </svg>
    ),
  },
  gemini: {
    bg: 'linear-gradient(135deg, #4C6FFF, #A35CFF)',
    mark: (
      <svg viewBox="0 0 24 24" className="size-3" fill="#fff" aria-hidden>
        <path d="M12 2c.7 5.3 4.7 9.3 10 10-5.3.7-9.3 4.7-10 10-.7-5.3-4.7-9.3-10-10 5.3-.7 9.3-4.7 10-10Z" />
      </svg>
    ),
  },
  ollama: {
    bg: '#0F172A',
    ring: true,
    mark: (
      <svg
        viewBox="0 0 24 24"
        className="size-3.5"
        fill="none"
        stroke="#fff"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <path d="M8.6 8.2 7.2 3.6l4.8 2.8" />
        <path d="M15.4 8.2 16.8 3.6 12 6.4" />
        <path d="M4.5 12.8c0-2.6 3.4-4.6 7.5-4.6s7.5 2 7.5 4.6-3.4 4.6-7.5 4.6-7.5-2-7.5-4.6Z" />
        <circle cx="9.2" cy="12.6" r="1" fill="#fff" stroke="none" />
        <circle cx="14.8" cy="12.6" r="1" fill="#fff" stroke="none" />
      </svg>
    ),
  },
  moonshot: {
    bg: '#6366F1',
    mark: (
      <svg viewBox="0 0 24 24" className="size-3" aria-hidden>
        <circle cx="13.5" cy="13.5" r="8.5" fill="#fff" />
        <circle cx="9" cy="9" r="8.5" fill="#6366F1" />
      </svg>
    ),
  },
  qwen: {
    bg: '#FF6A00',
    mark: (
      <svg viewBox="0 0 24 24" className="size-3" aria-hidden>
        <circle cx="10" cy="10" r="5.6" fill="#fff" />
        <path d="M15.4 15.4 20.4 20.4" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" />
      </svg>
    ),
  },
  xai: {
    bg: '#09090B',
    ring: true,
    mark: (
      <svg
        viewBox="0 0 24 24"
        className="size-3"
        fill="none"
        stroke="#fff"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <path d="M5.5 5.5c3.5 2.6 7.5 3 13-1M5.5 18.5l6.5-6.5 6.5 6.5" />
      </svg>
    ),
  },
  azure: {
    bg: '#0078D4',
    mark: (
      <svg viewBox="0 0 24 24" className="size-3" fill="#fff" aria-hidden>
        <path d="M12 3 5 20h4l3-6.5L15 20h4L12 3Z" />
      </svg>
    ),
  },
  mistral: {
    bg: '#FF7000',
    mark: (
      <svg viewBox="0 0 24 24" className="size-3.5" aria-hidden>
        <text
          x="12"
          y="16.5"
          textAnchor="middle"
          fontSize="13"
          fontWeight="700"
          fill="#fff"
          fontFamily="system-ui,-apple-system,sans-serif"
        >
          M
        </text>
      </svg>
    ),
  },
};

const BADGE_BASE = 'inline-flex shrink-0 items-center justify-center overflow-hidden rounded-[5px]';

export function ProviderLogo({
  providerId,
  name,
  className,
}: {
  providerId?: string;
  name?: string;
  className?: string;
}) {
  const key = normalizeKey(providerId, name);
  const spec = key ? LOGOS[key] : undefined;
  if (!spec || !key) {
    // 无 id 时(如加载中)用通用图标;仅有 name 的未知供应商回退首字母
    if (!providerId) {
      return <Server className={cn('size-4 text-foreground-subtle', className)} />;
    }
    const ch = (name || providerId || '?').trim().charAt(0).toUpperCase();
    return (
      <span
        className={cn(BADGE_BASE, 'size-4 bg-foreground/10 text-[9px] font-semibold text-foreground-subtle', className)}
      >
        {ch}
      </span>
    );
  }
  return (
    <span
      className={cn(BADGE_BASE, 'size-4', spec.ring && 'ring-1 ring-white/25', className)}
      style={{ background: spec.bg }}
    >
      {spec.mark}
    </span>
  );
}