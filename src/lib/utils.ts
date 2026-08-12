import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * 根据用量比例(0-1)返回从绿到红的渐变色(HSL 字符串)。
 * ratio=0 → 绿色(120°),ratio=0.5 → 黄色(60°),ratio≥1 → 红色(0°)。
 * 可选 lightness/saturation 参数微调明暗与饱和度。
 */
export function usageColor(ratio: number, lightness = 50, saturation = 70): string {
  const clamped = Math.max(0, Math.min(1, ratio));
  const hue = Math.round(120 * (1 - clamped));
  return `hsl(${hue} ${saturation}% ${lightness}%)`;
}
