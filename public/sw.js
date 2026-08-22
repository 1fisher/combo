/**
 * Combo PWA Service Worker
 *
 * 目的:使移动端可安装(Add to Home Screen)并在弱网/离线时提供 App Shell。
 * 安全边界(非常重要,避免破坏远程/中转连接):
 *  - 仅拦截 GET 请求;
 *  - 绝不缓存 `/v1/*` API(SSE/agent/文件等一律走网络,保证实时性与鉴权);
 *  - 仅缓存同源资源(远端代理/LAN 直连多为跨源,交由网络层处理);
 *  - HTML 导航 network-first,离线时回退缓存的 App Shell。
 */

const VERSION = 'combo-sw-v1';
const SHELL_CACHE = `${VERSION}-shell`;
const ASSET_CACHE = `${VERSION}-assets`;

const SHELL_ASSETS = ['/', '/index.html', '/manifest.json', '/icons/icon-192.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => k.startsWith('combo-sw-') && k !== SHELL_CACHE && k !== ASSET_CACHE)
            .map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

/** 是否应放进缓存:非 API、跨源跳过;仅 GET。 */
function isCacheable(request) {
  if (!request || request.method !== 'GET') return false;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return false; // 跨源(远端代理/LAN)不缓存
  if (url.pathname.startsWith('/v1/')) return false; // API 一律走网络
  return true;
}

async function networkFirstFetch(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const response = await fetch(request);
    if (request.method === 'GET' && isCacheable(request) && response.ok) {
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    const cached = await cache.match(request).catch(() => null);
    if (cached) return cached;
    // 导航回退到缓存的 App Shell(离线壳)
    if (request.mode === 'navigate') {
      const shell = await cache.match('/index.html').catch(() => null);
      if (shell) return shell;
    }
    return Response.error();
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(ASSET_CACHE);
  const cached = await cache.match(request).catch(() => null);
  const network = fetch(request)
    .then((response) => {
      if (response && response.ok && isCacheable(request)) {
        cache.put(request, response.clone());
      }
      return response;
    })
    .catch(() => null);
  return cached || (await network) || Response.error();
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (!isCacheable(request)) return; // 放行任何不可缓存/API/跨源请求

  // 导航(navigate):network-first;静态资源:stale-while-revalidate
  if (request.mode === 'navigate') {
    event.respondWith(networkFirstFetch(request));
  } else {
    event.respondWith(staleWhileRevalidate(request));
  }
});
