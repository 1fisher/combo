#!/usr/bin/env bash
#
# combo-relay 中转服务器部署脚本 → relay.example.com
#
# 用法:
#   REMOTE_HOST=your-server bash scripts/deploy-relay.sh
#   REMOTE_HOST=your-server bash scripts/deploy-relay.sh
#
# 前置:
#   - 本机安装 cargo-zigbuild + zig(交叉编译)
#       cargo install cargo-zigbuild && brew install zig
#   - ~/.ssh/config 配好 Host your-server(端口/密钥)
#   - 服务器账号免密 sudo
#
# 首次部署会自动申请 SSL 证书(acme.sh + ZeroSSL,本服务器无法直连 Let's Encrypt)。
#
set -euo pipefail

REMOTE_HOST="${REMOTE_HOST:?请设置 REMOTE_HOST,如 your-server}"
DOMAIN="relay.example.com"
CERT_DIR="/etc/combo-certs/${DOMAIN}"
RELAY_DIR="/opt/combo"
WEB_DIR="/var/www/combo/dist"
TARGET="${TARGET:-x86_64-unknown-linux-gnu}"

# ---------- 1. 交叉编译 ----------
echo "[1/6] 构建 combo-relay (release, target=$TARGET)..."
if ! command -v zig &>/dev/null; then
    echo "  ✗ zig 未安装(cargo-zigbuild 需要)。请: brew install zig"
    exit 1
fi
cargo-zigbuild build -p combo-relay --release --target "$TARGET"
RELAY_BIN="target/${TARGET}/release/combo-relay"
[ -f "$RELAY_BIN" ] || { echo "  ✗ 构建产物未找到: $RELAY_BIN"; exit 1; }
echo "  ✓ $(file "$RELAY_BIN" | cut -d: -f2)"

# ---------- 2. 构建前端 ----------
echo "[2/6] 构建前端 (dist/)..."
npm run build
tar -czf /tmp/combo-dist.tar.gz -C dist .

# ---------- 3. 上传 ----------
echo "[3/6] 上传到 ${REMOTE_HOST}..."
ssh "$REMOTE_HOST" "mkdir -p ~/combo-deploy"
scp -q "$RELAY_BIN" "$REMOTE_HOST":~/combo-deploy/combo-relay
scp -q /tmp/combo-dist.tar.gz "$REMOTE_HOST":~/combo-deploy/
scp -q nginx/combo-relay.example.conf "$REMOTE_HOST":~/combo-deploy/
scp -q nginx/combo-relay.service "$REMOTE_HOST":~/combo-deploy/

# ---------- 4/5/6. 远程安装 + nginx + 证书 ----------
echo "[4/6] 远程安装二进制/前端/systemd..."
echo "[5/6] nginx 配置 + SSL 证书(首次自动申请)..."
echo "[6/6] 重启服务并验证..."
ssh "$REMOTE_HOST" "bash -s" << REMOTE
set -euo pipefail
DOMAIN="${DOMAIN}"
CERT_DIR="${CERT_DIR}"
RELAY_DIR="${RELAY_DIR}"
WEB_DIR="${WEB_DIR}"

echo "--- 停止旧服务 ---"
sudo systemctl stop combo-relay 2>/dev/null || true

echo "--- 安装二进制 + systemd ---"
sudo mkdir -p "$RELAY_DIR" "$WEB_DIR"
sudo cp ~/combo-deploy/combo-relay "$RELAY_DIR/combo-relay"
sudo chmod +x "$RELAY_DIR/combo-relay"
sudo cp ~/combo-deploy/combo-relay.service /etc/systemd/system/combo-relay.service

echo "--- 安装前端 ---"
sudo rm -rf "$WEB_DIR"/*
sudo tar -xzf ~/combo-deploy/combo-dist.tar.gz -C "$WEB_DIR"

echo "--- 首次:申请 SSL 证书(acme.sh + ZeroSSL)---"
if [ ! -f "\$CERT_DIR/fullchain.pem" ]; then
    echo "  证书不存在,开始申请..."
    # 安装 acme.sh
    if [ ! -d ~/.acme.sh ]; then
        git clone --depth 1 https://github.com/acmesh-official/acme.sh.git /tmp/acme-repo
        ( cd /tmp/acme-repo && ./acme.sh --install --home ~/.acme.sh --nocron --accountemail combo@example.com )
        ~/.acme.sh/acme.sh --set-default-ca --server zerossl
        ~/.acme.sh/acme.sh --install-cronjob
        rm -rf /tmp/acme-repo
    fi
    # webroot 目录权限(当前用户可写)
    sudo mkdir -p /var/www/html/.well-known/acme-challenge
    sudo chown -R "\$(id -u):\$(id -g)" /var/www/html/.well-known
    # 证书目录权限
    sudo mkdir -p "\$CERT_DIR"
    sudo chown -R "\$(id -u):\$(id -g)" /etc/combo-certs
    # 临时 80-only 配置(用于 ACME 验证,此时还没有证书)
    sudo tee /etc/nginx/conf.d/\$DOMAIN.conf > /dev/null << 'EOF80'
server {
    listen 80;
    listen [::]:80;
    server_name DOMAIN_PLACEHOLDER;
    location /.well-known/acme-challenge/ { root /var/www/html; }
    location / { return 301 https://\$host\$request_uri; }
}
EOF80
    sudo sed -i "s/DOMAIN_PLACEHOLDER/\$DOMAIN/" /etc/nginx/conf.d/\$DOMAIN.conf
    sudo nginx -t && sudo systemctl reload nginx
    # 申请 + 安装证书
    ~/.acme.sh/acme.sh --issue -d "\$DOMAIN" --webroot /var/www/html --server zerossl --force
    ~/.acme.sh/acme.sh --install-cert -d "\$DOMAIN" --ecc \\
        --key-file "\$CERT_DIR/key.pem" \\
        --fullchain-file "\$CERT_DIR/fullchain.pem" \\
        --reloadcmd "sudo systemctl reload nginx"
    echo "  ✓ 证书已签发并安装"
else
    echo "  证书已存在,跳过申请"
fi

echo "--- 部署完整 nginx 配置(80 + 443)---"
sudo cp ~/combo-deploy/combo-relay.example.conf /etc/nginx/conf.d/${DOMAIN}.conf
sudo nginx -t
sudo systemctl reload nginx

echo "--- 启动 combo-relay ---"
sudo systemctl daemon-reload
sudo systemctl enable --now combo-relay
sleep 1

echo "--- 验证 ---"
echo "combo-relay: \$(sudo systemctl is-active combo-relay)"
curl -fsS https://${DOMAIN}/v1/health && echo " <- health ok"
curl -fsS https://${DOMAIN}/ | head -1
REMOTE

echo ""
echo "✅ 部署完成!"
echo "   对外访问: https://${DOMAIN}"
echo "   健康检查: curl https://${DOMAIN}/v1/health  → ok"
echo "   隧道端点: wss://${DOMAIN}/v1/relay/tunnel?token=<access_token>"
echo ""
echo " 验证: 桌面端打开「移动端远程控制」→ 隧道自动连接 → 手机扫码"
