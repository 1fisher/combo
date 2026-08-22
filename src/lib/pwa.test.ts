import { describe, it, expect, vi, afterEach } from 'vitest';
import { isMobileViewport, isStandalonePwa } from './pwa';
import { isTauri } from './connection';

describe('pwa', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('移动视口判定:默认 stub matchMedia 为 false', () => {
    expect(isMobileViewport()).toBe(false);
  });

  it('移动视口判定:matchMedia 命中时返回 true', () => {
    vi.spyOn(window, 'matchMedia').mockReturnValue({
      matches: true,
      media: '(max-width: 767px)',
    } as unknown as MediaQueryList);
    expect(isMobileViewport()).toBe(true);
  });

  it('standalone 判定:默认非独立模式', () => {
    expect(isStandalonePwa()).toBe(false);
  });

  it('standalone 判定:display-mode 命中时为 true', () => {
    vi.spyOn(window, 'matchMedia').mockReturnValue({
      matches: true,
      media: '(display-mode: standalone)',
    } as unknown as MediaQueryList);
    expect(isStandalonePwa()).toBe(true);
  });

  it('Tauri 检测:未注入 __TAURI_INTERNALS__ 时 false', () => {
    expect(isTauri()).toBe(false);
  });
});
