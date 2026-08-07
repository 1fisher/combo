import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearAccessToken,
  extractTokenFromUrl,
  getAccessToken,
  hasAccessToken,
  setAccessToken,
} from './authToken';

describe('authToken', () => {
  beforeEach(() => {
    localStorage.clear();
    // 重置 window.location 为干净的 URL
    vi.stubGlobal('window', {
      ...window,
      location: { ...window.location, search: '', pathname: '/', hash: '' },
      history: { replaceState: vi.fn() },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('persists token in localStorage', () => {
    setAccessToken('abc123');
    expect(getAccessToken()).toBe('abc123');
    expect(hasAccessToken()).toBe(true);
  });

  it('clears token', () => {
    setAccessToken('abc123');
    clearAccessToken();
    expect(getAccessToken()).toBeNull();
    expect(hasAccessToken()).toBe(false);
  });

  it('returns null when no token stored', () => {
    expect(getAccessToken()).toBeNull();
    expect(hasAccessToken()).toBe(false);
  });

  it('extracts token from URL and removes it from address bar', () => {
    vi.stubGlobal('window', {
      ...window,
      location: {
        ...window.location,
        pathname: '/app',
        search: '?token=secret&foo=bar',
        hash: '',
      },
      history: { replaceState: vi.fn() },
    });
    const token = extractTokenFromUrl();
    expect(token).toBe('secret');
    expect(getAccessToken()).toBe('secret');
    // 地址栏应移除 token 但保留其余参数
    expect(window.history.replaceState).toHaveBeenCalledWith(
      null,
      '',
      '/app?foo=bar'
    );
  });

  it('returns null when URL has no token', () => {
    vi.stubGlobal('window', {
      ...window,
      location: {
        ...window.location,
        pathname: '/app',
        search: '?foo=bar',
        hash: '',
      },
      history: { replaceState: vi.fn() },
    });
    expect(extractTokenFromUrl()).toBeNull();
    expect(getAccessToken()).toBeNull();
  });
});
