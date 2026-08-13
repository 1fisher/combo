import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isSafeExternalUrl, openExternal } from './openExternal';

describe('isSafeExternalUrl', () => {
  it('允许 http/https/mailto', () => {
    expect(isSafeExternalUrl('https://example.com')).toBe(true);
    expect(isSafeExternalUrl('http://example.com/a?b=1')).toBe(true);
    expect(isSafeExternalUrl('mailto:hello@example.com')).toBe(true);
    expect(isSafeExternalUrl('  https://example.com  ')).toBe(true);
  });

  it('拒绝 javascript: 等危险或未知 scheme', () => {
    expect(isSafeExternalUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeExternalUrl('file:///etc/passwd')).toBe(false);
    expect(isSafeExternalUrl('data:text/html,<script>1</script>')).toBe(false);
    expect(isSafeExternalUrl('')).toBe(false);
  });
});

describe('openExternal', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('浏览器模式下用 window.open 新标签页打开', async () => {
    const open = vi.fn();
    vi.stubGlobal('open', open);
    await openExternal('https://example.com');
    expect(open).toHaveBeenCalledWith(
      'https://example.com',
      '_blank',
      'noopener,noreferrer'
    );
  });

  it('危险 scheme 不打开', async () => {
    const open = vi.fn();
    vi.stubGlobal('open', open);
    await openExternal('javascript:alert(1)');
    expect(open).not.toHaveBeenCalled();
  });
});
