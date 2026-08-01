#!/usr/bin/env bash
# 启动 Vite dev server,并通过 VITE_PROXY_URL 让浏览器模式直连 combo-proxy。
set -euo pipefail

export VITE_PROXY_URL="${VITE_PROXY_URL:-http://127.0.0.1:18234}"

npm run dev
