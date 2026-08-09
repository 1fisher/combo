#!/usr/bin/env bash
#
# combo-relay 服务器端引导脚本
#
# 在目标服务器上直接执行(需要 root):
#   bash server-bootstrap.sh
#
# 此脚本完成:
#   1. 安装 nginx + certbot
#   2. 部署 combo-relay 二进制 + 前端静态文件
#   3. 配置 systemd 服务并启动
#   4. 配置 nginx 反向代理
#   5. 申请 SSL 证书
#
set -euo pipefail

DOMAIN="proxy.apesoft.cn"
RELAY_PORT=8080
INSTALL_DIR="/opt/combo"
STATIC_DIR="/var/www/combo/dist"
SERVICE_NAME="combo-relay"

echo "╔══════════════════════════════════════════╗"
echo "║  combo-relay 服务器部署                  ║"
echo "║  域名: $DOMAIN                           ║"
echo "║  中转端口: $RELAY_PORT                    ║"
echo "╚══════════════════════════════════════════╝"
echo ""

# ---------- 0. 检查 root ----------
if [ "$(id -u)" -ne 0 ]; then
    echo "✗ 请使用 root 用户执行(sudo su -)"
    exit 1
fi

# ---------- 1. 安装依赖 ----------
echo "[1/7] 检查并安装依赖..."
if command -v apt-get &>/dev/null; then
    apt-get update -qq
    apt-get install -y -qq nginx certbot python3-certbot-nginx >/dev/null
elif command -v yum &>/dev/null; then
    yum install -y -q nginx certbot python3-certbot-nginx
else
    echo "✗ 不支持的包管理器,请手动安装 nginx + certbot"
    exit 1
fi
echo "  ✓ nginx + certbot 已就绪"

# ---------- 2. 查找二进制文件 ----------
echo ""
echo "[2/7] 查找 combo-relay 二进制..."

# 可能的路径:当前目录、/tmp/combo-deploy、已有安装
BINARY=""
for candidate in \
    "$(dirname "$0")/combo-relay" \
    "/tmp/combo-deploy/combo-relay" \
    "$INSTALL_DIR/combo-relay"; do
    if [ -f "$candidate" ] && [ -x "$candidate" ]; then
        BINARY="$candidate"
        break
    fi
done

if [ -z "$BINARY" ]; then
    echo "  ✗ 未找到 combo-relay 二进制"
    echo ""
    echo "  请先从本地构建并上传:"
    echo "    # 本地执行:"
    echo "    cargo build -p combo-relay --release"
    echo "    npm run build"
    echo "    scp target/release/combo-relay root@<IP>:/tmp/combo-deploy/"
    echo "    scp -r dist root@<IP>:/tmp/combo-deploy/"
    echo "    scp nginx/combo-relay.example.conf root@<IP>:/tmp/combo-deploy/"
    echo ""
    echo "  然后重新执行此脚本"
    exit 1
fi
echo "  ✓ 二进制: $BINARY"

# ---------- 3. 查找前端文件 ----------
echo ""
echo "[3/7] 查找前端静态文件..."

DIST_SRC=""
for candidate in \
    "$(dirname "$0")/dist" \
    "/tmp/combo-deploy/dist"; do
    if [ -f "$candidate/index.html" ]; then
        DIST_SRC="$candidate"
        break
    fi
done

if [ -z "$DIST_SRC" ]; then
    echo "  ⚠ 未找到前端 dist/,将仅部署中转服务(无前端页面)"
else
    echo "  ✓ 前端: $DIST_SRC"
fi

# ---------- 4. 部署文件 ----------
echo ""
echo "[4/7] 部署文件..."
mkdir -p "$INSTALL_DIR" "$STATIC_DIR"

# 停止旧服务(如在运行)
systemctl stop "$SERVICE_NAME" 2>/dev/null || true

cp "$BINARY" "$INSTALL_DIR/combo-relay"
chmod +x "$INSTALL_DIR/combo-relay"
echo "  ✓ 二进制 → $INSTALL_DIR/combo-relay"

if [ -n "$DIST_SRC" ]; then
    rm -rf "$STATIC_DIR"
    cp -r "$DIST_SRC" "$STATIC_DIR"
    echo "  ✓ 前端 → $STATIC_DIR"
fi

# ---------- 5. systemd 服务 ----------
echo ""
echo "[5/7] 配置 systemd 服务..."
cat > /etc/systemd/system/${SERVICE_NAME}.service << EOF
[Unit]
Description=combo-relay (中转服务器 — 反向隧道)
After=network.target

[Service]
Type=simple
ExecStart=${INSTALL_DIR}/combo-relay --host 127.0.0.1 --port ${RELAY_PORT} --static-dir ${STATIC_DIR}
WorkingDirectory=${INSTALL_DIR}
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=${STATIC_DIR}
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now "$SERVICE_NAME"
sleep 1

if systemctl is-active --quiet "$SERVICE_NAME"; then
    echo "  ✓ combo-relay 已启动 (PID $(systemctl show -p MainPID --value $SERVICE_NAME))"
else
    echo "  ✗ combo-relay 启动失败,查看日志:"
    journalctl -u "$SERVICE_NAME" --no-pager -n 20
    exit 1
fi

# 验证本地健康检查
if curl -sf "http://127.0.0.1:${RELAY_PORT}/v1/health" >/dev/null 2>&1; then
    echo "  ✓ 健康检查通过"
else
    echo "  ⚠ 本地健康检查未通过(可能需要等待启动)"
fi

# ---------- 6. nginx 配置 ----------
echo ""
echo "[6/7] 配置 nginx..."

# 先创建只含 HTTP 的临时配置(certbot 需要验证)
cat > /etc/nginx/sites-available/${DOMAIN} << 'NGINX_HTTP'
server {
    listen 80;
    listen [::]:80;
    server_name proxy.apesoft.cn;

    location /.well-known/acme-challenge/ {
        root /var/www/html;
    }

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
        proxy_cache off;
        chunked_transfer_encoding off;
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }
}
NGINX_HTTP

ln -sf /etc/nginx/sites-available/${DOMAIN} /etc/nginx/sites-enabled/
# 移除默认站点(避免冲突)
rm -f /etc/nginx/sites-enabled/default
mkdir -p /var/www/html

nginx -t
systemctl reload nginx
echo "  ✓ nginx 已配置(HTTP → combo-relay)"

# ---------- 7. SSL 证书 ----------
echo ""
echo "[7/7] 申请 SSL 证书..."
if certbot --nginx -d "$DOMAIN" \
    --non-interactive \
    --agree-tos \
    --register-unsafely-without-email \
    --redirect; then
    echo "  ✓ SSL 证书已申请并配置"
else
    echo "  ⚠ SSL 证书申请失败"
    echo "  可能原因:DNS 未解析到此服务器,或证书已存在"
    echo "  手动执行: certbot --nginx -d $DOMAIN"
fi

# ---------- 完成 ----------
echo ""
echo "╔══════════════════════════════════════════╗"
echo "║  ✅ 部署完成!                             ║"
echo "╠══════════════════════════════════════════╣"
echo "║                                          ║"
echo "║  中转服务: https://$DOMAIN              ║"
echo "║  健康检查: https://$DOMAIN/v1/health    ║"
echo "║                                          ║"
echo "║  隧道端点:                               ║"
echo "║    wss://$DOMAIN/v1/relay/tunnel         ║"
echo "║    ?token=<access_token>                 ║"
echo "║                                          ║"
echo "║  管理命令:                               ║"
echo "║    systemctl status combo-relay          ║"
echo "║    systemctl restart combo-relay         ║"
echo "║    journalctl -u combo-relay -f          ║"
echo "║                                          ║"
echo "╚══════════════════════════════════════════╝"
echo ""
echo "→ 桌面端打开「移动端远程控制」即可自动建立隧道"
echo "→ 手机扫码 https://$DOMAIN/?token=xxx 远程访问"
