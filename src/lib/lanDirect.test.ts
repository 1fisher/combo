import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearLanUrl,
  extractLanFromUrl,
  getLanUrl,
  lanDirectFailed,
  maybeRedirectToLan,
  resetLanTried,
  setLanUrl,
} from './lanDirect';

function stubLocation(opts: { origin?: string; search?: string; pathname?: string; replace?: () => void }) {
  const replace = opts.replace ?? vi.fn();
  const location = {
    origin: opts.origin ?? 'https://proxy.apesoft.cn',
    pathname: opts.pathname ?? '/',
    search: opts.search ?? '',
    hash: '',
    replace,
  };
  vi.stubGlobal('window', { ...window, location, history: { replaceState: vi.fn() } });
  return { replace };
}

describe('lanDirect', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('persists and clears lan url', () => {
    setLanUrl('http://192.168.1.5:18236/');
    expect(getLanUrl()).toBe('http://192.168.1.5:18236');
    clearLanUrl();
    expect(getLanUrl()).toBeNull();
  });

  it('rejects non-http(s) lan urls (javascript: XSS guard)', () => {
    setLanUrl('javascript:alert(1)');
    expect(getLanUrl()).toBeNull();
    setLanUrl('data:text/html,<script>alert(1)</script>');
    expect(getLanUrl()).toBeNull();
    setLanUrl('ftp://192.168.1.5');
    expect(getLanUrl()).toBeNull();
  });

  it('does not redirect to a javascript: lan url', () => {
    stubLocation({});
    setLanUrl('javascript:alert(document.cookie)');
    const redirected = maybeRedirectToLan('tok123');
    expect(redirected).toBe(false);
    expect(window.location.replace).not.toHaveBeenCalled();
  });

  it('extracts lan from URL and removes the param', () => {
    stubLocation({ search: '?token=abc&lan=http%3A%2F%2F192.168.1.5%3A18236' });
    const lan = extractLanFromUrl();
    expect(lan).toBe('http://192.168.1.5:18236');
    expect(getLanUrl()).toBe('http://192.168.1.5:18236');
    expect(window.history.replaceState).toHaveBeenCalledWith(null, '', '/?token=abc');
  });

  it('returns null when URL has no lan param', () => {
    stubLocation({ search: '?token=abc' });
    expect(extractLanFromUrl()).toBeNull();
    expect(getLanUrl()).toBeNull();
  });

  it('redirects to lan page once per session', () => {
    stubLocation({});
    setLanUrl('http://192.168.1.5:18236');
    const redirected = maybeRedirectToLan('tok123');
    expect(redirected).toBe(true);
    expect(window.location.replace).toHaveBeenCalledWith(
      'http://192.168.1.5:18236/?token=tok123'
    );
    // 第二次不再自动跳转(session 标记)
    const again = maybeRedirectToLan('tok123');
    expect(again).toBe(false);
    expect(window.location.replace).toHaveBeenCalledTimes(1);
    expect(lanDirectFailed()).toBe(true);
  });

  it('does not redirect when already on the lan page', () => {
    stubLocation({ origin: 'http://192.168.1.5:18236' });
    setLanUrl('http://192.168.1.5:18236');
    expect(maybeRedirectToLan('tok')).toBe(false);
  });

  it('does not redirect on localhost (desktop dev mode)', () => {
    stubLocation({ origin: 'http://localhost:5173' });
    setLanUrl('http://192.168.1.5:18236');
    expect(maybeRedirectToLan('tok')).toBe(false);
  });

  it('does not redirect without token or lan url', () => {
    stubLocation({});
    expect(maybeRedirectToLan(null)).toBe(false);
    setLanUrl('http://192.168.1.5:18236');
    expect(maybeRedirectToLan(null)).toBe(false);
  });

  it('resetLanTried allows another redirect attempt', () => {
    stubLocation({});
    setLanUrl('http://192.168.1.5:18236');
    expect(maybeRedirectToLan('tok')).toBe(true);
    resetLanTried();
    expect(lanDirectFailed()).toBe(false);
    expect(maybeRedirectToLan('tok')).toBe(true);
  });

  it('lanDirectFailed is false before any attempt', () => {
    stubLocation({});
    setLanUrl('http://192.168.1.5:18236');
    expect(lanDirectFailed()).toBe(false);
  });
});
