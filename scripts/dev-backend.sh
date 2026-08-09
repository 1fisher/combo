#!/usr/bin/env bash
# 一步编译并运行后端:先构建 combo-cli(默认 agent),再以该二进制启动 combo-proxy。
#
# 用法:
#   bash scripts/dev-backend.sh            # 端口 18234(与 dev-proxy.sh 配套)
#   bash scripts/dev-backend.sh 19000      # 自定义端口
#   COMBO_CRUSH_BIN=/path/to/crush bash scripts/dev-backend.sh   # 顺带拉起存量 crush
set -euo pipefail

PORT="${1:-${COMBO_PROXY_PORT:-18234}}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# 1. 编译 combo-cli(增量构建,秒级;产物 target/debug/combo-cli)
echo "==> 编译 combo-cli"
cargo build -p combo-cli

# 2. 默认 agent 指向刚编译出的二进制(已显式设置 COMBO_CLI_BIN 则尊重之)
export COMBO_CLI_BIN="${COMBO_CLI_BIN:-$ROOT/target/debug/combo-cli}"
echo "==> COMBO_CLI_BIN=$COMBO_CLI_BIN"

# 3. 前台运行 combo-proxy(会自动托管 combo-cli serve)
echo "==> 启动 combo-proxy 127.0.0.1:${PORT}"
exec cargo run -p combo-proxy --bin combo-proxy -- --port "$PORT"
