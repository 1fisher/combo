#!/usr/bin/env bash
# 一步编译并运行后端:直接以 serve 模式运行 combo-cli(combo 的完整 API 服务)。
#
# 用法:
#   bash scripts/dev-backend.sh            # 端口 18234(与 dev-proxy.sh 配套)
#   bash scripts/dev-backend.sh 19000      # 自定义端口
#   STATIC=1 bash scripts/dev-backend.sh   # 同时提供前端静态文件(tunnel-all 测试)
set -euo pipefail

PORT="${1:-${COMBO_PORT:-18234}}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# 1. 编译 combo-cli(增量构建,秒级)
echo "==> 编译 combo-cli"
cargo build -p combo-cli

# 2. 前台运行 combo-cli serve(自带全部 REST/SSE 端点,端口 18234 硬编码为 fallback)
echo "==> 启动 combo-cli serve 127.0.0.1:${PORT}"
if [[ "${STATIC:-}" == "1" && -d "$ROOT/dist" ]]; then
  echo "==> 静态资源: $ROOT/dist (tunnel-all 模式)"
  exec "$ROOT/target/debug/combo-cli" serve --port "$PORT" --static-dir "$ROOT/dist"
else
  exec "$ROOT/target/debug/combo-cli" serve --port "$PORT"
fi