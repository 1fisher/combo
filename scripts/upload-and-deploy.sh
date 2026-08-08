#!/usr/bin/env bash
#
# combo-relay 服务器端部署脚本
#
# 用法(登录服务器后):
#   scp 本地文件到服务器后执行,或直接在服务器上 git pull 后执行
#
#   REMOTE_HOST=your-server bash scripts/upload-and-deploy.sh
#
set -euo pipefail

# ---------- 交叉编译目标 ----------
TARGET="${TARGET:-x86_64-unknown-linux-gnu}"

# ---- 构建二进制(交叉编译) ----
if [ "$ON_SERVER" != "1" ]; then
    echo "========== 构建 combo-relay (target=$TARGET) =========="
    if command -v cargo-zigbuild &>/dev/null; then
        cargo-zigbuild build -p combo-relay --release --target "$TARGET"
        RELAY_BIN="target/$TARGET/release/combo-relay"
    else
        echo "  ⚠ cargo-zigbuild 未安装,回退到普通 cargo build"
        cargo build -p combo-relay --release
        RELAY_BIN="target/release/combo-relay"
    fi
    echo "  ✓ $(file "$RELAY_BIN" | cut -d: -f2)"
fi

# ---- 检测当前是否已在服务器上 ----
ON_SERVER="${ON_SERVER:-0}"

if [ "$ON_SERVER" = "1" ]; then
    # 直接在服务器上运行
    echo "========== 在服务器上执行部署 =========="
else
    REMOTE_HOST="${REMOTE_HOST:?请设置 REMOTE_HOST 或 ON_SERVER=1}"
    echo "========== 上传文件到 ${REMOTE_HOST} =========="
    REMOTE_DIR="/tmp/combo-deploy"
    ssh "$REMOTE_HOST" "mkdir -p $REMOTE_DIR"
    scp "$RELAY_BIN" "$REMOTE_HOST:$REMOTE_DIR/combo-relay"
    scp -r dist "$REMOTE_HOST:$REMOTE_DIR/"
    scp nginx/combo-relay.example.conf "$REMOTE_HOST:$REMOTE_DIR/"
    scp nginx/combo-relay.service "$REMOTE_HOST:$REMOTE_DIR/"
    scp scripts/server-bootstrap.sh "$REMOTE_HOST:$REMOTE_DIR/" 2>/dev/null || true

    echo "========== 远程执行部署 =========="
    ssh "$REMOTE_HOST" "ON_SERVER=1 bash $REMOTE_DIR/server-bootstrap.sh || bash $REMOTE_DIR/combo-relay-deploy.sh"
    exit $?
fi
