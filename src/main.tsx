import React, { useEffect } from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import { AppShell } from './components/shell/AppShell';
import { Liquid } from './components/canvasui/Liquid';
import { useUIPreferences } from './stores/uiPreferencesStore';
import { extractTokenFromUrl, getAccessToken } from './lib/authToken';
import { extractLanFromUrl, maybeRedirectToLan } from './lib/lanDirect';
import { ensureP2pConnected } from './lib/p2p/transport';
import { isTauri } from './lib/connection';

// 移动端扫码打开后,从 URL 提取访问令牌并持久化(移除地址栏中的 token)。
const token = extractTokenFromUrl();
// 局域网直连引导:提取 ?lan= 并在可用时自动整页跳转到桌面直连页面。
// 跳转失败(手机不在同一 WiFi)返回本页后,不再重复自动跳转。
extractLanFromUrl();
if (!isTauri()) {
  const redirected = maybeRedirectToLan(token ?? getAccessToken());
  // 未走局域网直连时,异步建立 WebRTC P2P(失败静默回退中转)
  if (!redirected) void ensureP2pConnected();
}

// 桌面模式下隐藏窗口标题栏的产品名,仅保留浏览器标签页标题。
if (isTauri()) {
  document.title = '';
}

const liquidOptions = {
  rainbow: false,
  color: [1, 1, 1] as [number, number, number],
  intensity: 0.08,
  densityDissipation: 0.97,
  velocityDissipation: 0.995,
  radius: 0.35,
  minVelocity: 1.5,
  force: 0.5,
  curl: 2.2,
  blend: 1.5,
  distortion: 0.25,
};

function AppRoot() {
  const liquidEnabled = useUIPreferences((s) => s.liquidEnabled);
  // 应用首帧实际绘制后,通知启动画面(public/splash.js)收尾:
  // 粒子合并成图标 → 流光 combo → 淡出移除。双 rAF 确保 commit 后的
  // 首帧已上屏,避免 splash 提前消失露出白屏。splash 不存在时无副作用。
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        window.dispatchEvent(new Event('combo:app-ready'));
      });
    });
    return () => cancelAnimationFrame(raf);
  }, []);
  if (liquidEnabled) {
    return (
      <Liquid className="h-dvh w-full" {...liquidOptions}>
        <AppShell />
      </Liquid>
    );
  }
  return (
    <div className="h-dvh w-full">
      <AppShell />
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AppRoot />
  </React.StrictMode>
);
