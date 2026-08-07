import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import { AppShell } from './components/shell/AppShell';
import { extractTokenFromUrl } from './lib/authToken';

// 移动端扫码打开后,从 URL 提取访问令牌并持久化(移除地址栏中的 token)。
extractTokenFromUrl();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AppShell />
  </React.StrictMode>
);
