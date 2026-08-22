import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  parseConnectUrl,
  applyConnection,
  shouldShowMobileConnect,
  buildTargetUrl,
  rememberLastServer,
  getLastServer,
} from './mobileConnect';
import { getAccessToken } from './authToken';
import { getProxyUrlOverride } from './connection';

describe('parseConnectUrl', () => {
  it('解析带 token 与 lan 的连接地址', () => {
    const raw =
      'https://proxy.apesoft.cn/?token=abc123&lan=http%3A%2F%2F192.168.1.5%3A18236';
    const p = parseConnectUrl(raw);
    expect(p).not.toBeNull();
    expect(p!.server).toBe('https://proxy.apesoft.cn');
    expect(p!.token).toBe('abc123');
    expect(p!.lan).toBe('http://192.168.1.5:18236');
  });

  it('解析不带 lan 的连接地址', () => {
    const p = parseConnectUrl('https://proxy.apesoft.cn/?token=x');
    expect(p).not.toBeNull();
    expect(p!.server).toBe('https://proxy.apesoft.cn');
    expect(p!.token).toBe('x');
    expect(p!.lan).toBeNull();
  });

  it('缺 token 时返回 null', () => {
    expect(parseConnectUrl('https://proxy.apesoft.cn/')).toBeNull();
    expect(parseConnectUrl('https://proxy.apesoft.cn/?lan=http://192.168.1.5')).toBeNull();
  });

  it('拒绝非法协议与乱串', () => {
    expect(parseConnectUrl('javascript:alert(1)')).toBeNull();
    expect(parseConnectUrl('data:text/html,x')).toBeNull();
    expect(parseConnectUrl('not a url')).toBeNull();
    expect(parseConnectUrl('')).toBeNull();
  });
});

describe('shouldShowMobileConnect', () => {
  const base = {
    isTauri: false,
    hasToken: false,
    isLocalOrigin: false,
    isStandalone: false,
    isMobile: false,
  };

  it('Tauri 桌面套壳不展示', () => {
    expect(shouldShowMobileConnect({ ...base, isTauri: true })).toBe(false);
  });

  it('已持令牌视为已连接,不展示', () => {
    expect(shouldShowMobileConnect({ ...base, hasToken: true })).toBe(false);
  });

  it('本地回环(桌面开发)不展示', () => {
    expect(shouldShowMobileConnect({ ...base, isLocalOrigin: true })).toBe(false);
  });

  it('远端桌面宽屏且未安装:不展示', () => {
    expect(shouldShowMobileConnect(base)).toBe(false);
  });

  it('远端已安装 standalone:展示', () => {
    expect(shouldShowMobileConnect({ ...base, isStandalone: true })).toBe(true);
  });

  it('远端移动视口:展示', () => {
    expect(shouldShowMobileConnect({ ...base, isMobile: true })).toBe(true);
  });

  it('原生壳(Android/iOS):永远展示(本地 origin 是壳自身)', () => {
    expect(shouldShowMobileConnect({ ...base, isNative: true })).toBe(true);
    // 即便已持有令牌/本地回环,壳内也先展示连接屏
    expect(shouldShowMobileConnect({ ...base, isNative: true, hasToken: true })).toBe(true);
    expect(shouldShowMobileConnect({ ...base, isNative: true, isLocalOrigin: true })).toBe(true);
  });
});

describe('buildTargetUrl(原生壳目标页)', () => {
  it('拼接 token,不含 lan', () => {
    expect(buildTargetUrl({ server: 'https://proxy.apesoft.cn', token: 't1', lan: null })).toBe(
      'https://proxy.apesoft.cn/?token=t1',
    );
  });

  it('携带 lan 时一并拼入查询串', () => {
    const url = buildTargetUrl({
      server: 'https://proxy.apesoft.cn/',
      token: 't 2',
      lan: 'http://192.168.1.5:18236',
    });
    expect(url).toBe(
      'https://proxy.apesoft.cn/?token=t+2&lan=http%3A%2F%2F192.168.1.5%3A18236',
    );
  });
});

describe('最近连接地址记忆(原生壳预填)', () => {
  it('记住后可读回,未设置时为 null', () => {
    expect(getLastServer()).toBeNull();
    rememberLastServer('https://proxy.apesoft.cn');
    expect(getLastServer()).toBe('https://proxy.apesoft.cn');
  });
});

describe('applyConnection', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('同源地址:清除覆盖,健康检查通过即成功并保存令牌', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }));
    const r = await applyConnection({
      server: 'http://localhost:3000',
      token: 'tok-same-origin',
      lan: null,
    });
    expect(r.ok).toBe(true);
    expect(getAccessToken()).toBe('tok-same-origin');
    expect(getProxyUrlOverride()).toBeNull();
    // 同源时不写覆盖,基址为当前源
    expect(fetch).toHaveBeenCalledWith('http://localhost:3000/v1/health', { method: 'GET' });
  });

  it('不同源地址:写入代理覆盖', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }));
    const r = await applyConnection({
      server: 'https://proxy.example.com',
      token: 'tok-remote',
      lan: null,
    });
    expect(r.ok).toBe(true);
    expect(getProxyUrlOverride()).toBe('https://proxy.example.com');
    expect(fetch).toHaveBeenCalledWith('https://proxy.example.com/v1/health', { method: 'GET' });
  });

  it('健康检查失败:返回错误且不报错抛出', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401 }));
    const r = await applyConnection({
      server: 'https://proxy.example.com',
      token: 'tok-bad',
      lan: null,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/健康检查失败|无法连接/);
  });

  it('网络异常:返回友好错误', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('net down')));
    const r = await applyConnection({
      server: 'https://proxy.example.com',
      token: 'tok-net',
      lan: null,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/无法连接到该地址/);
  });

  it('verifyHealth:false(原生壳):跳过预检直接成功,不发请求', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const r = await applyConnection(
      { server: 'https://proxy.example.com', token: 'tok-native', lan: null },
      { verifyHealth: false },
    );
    expect(r.ok).toBe(true);
    expect(r.error).toBeUndefined();
    expect(getAccessToken()).toBe('tok-native');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
