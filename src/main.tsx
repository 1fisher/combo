import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import { AppShell } from './components/shell/AppShell';
import { Liquid } from './components/canvasui/Liquid';
import { extractTokenFromUrl } from './lib/authToken';
import { isTauri } from './lib/connection';

// 移动端扫码打开后,从 URL 提取访问令牌并持久化(移除地址栏中的 token)。
extractTokenFromUrl();

// 桌面模式下隐藏窗口标题栏的产品名,仅保留浏览器标签页标题。
if (isTauri()) {
  document.title = '';
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Liquid
      className="h-dvh w-full"
      rainbow={false}
      color={[0.55, 0.7, 0.95]}
      intensity={0.08}
      densityDissipation={0.97}
      velocityDissipation={0.995}
      radius={0.35}
      force={0.5}
      curl={2.2}
      blend={1.5}
      distortion={0.25}
    >
      <AppShell />
    </Liquid>
  </React.StrictMode>
);
