# ──────────────────────────────────────────────────────────────────────────────
# combo-relay Dockerfile — 中转服务器独立部署
#
# 构建用法:
#   docker build -t combo-relay .
#   docker run -d -p 8080:8080 --name combo-relay combo-relay
#
# 自定义端口/CORS:
#   docker run -d -p 443:8080 \
#     -e COMBO_CORS_ORIGINS=https://combo.example.com \
#     combo-relay
# ──────────────────────────────────────────────────────────────────────────────

# ---------- Stage 1: 构建前端 ----------
FROM node:20-slim AS frontend-builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.app.json tsconfig.node.json vite.config.ts index.html ./
COPY src/ src/
COPY swagger/ swagger/
RUN npm run build

# ---------- Stage 2: 构建 combo-relay ----------
FROM rust:1.82-bookworm AS relay-builder
WORKDIR /app
# 复制完整工作区(cargo build -p combo-relay 只编译 relay 及其依赖)
COPY . .
RUN cargo build --release -p combo-relay

# ---------- Stage 3: 运行时镜像 ----------
FROM debian:bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=relay-builder /app/target/release/combo-relay /usr/local/bin/combo-relay
COPY --from=frontend-builder /app/dist /var/www/combo/dist

ENV COMBO_STATIC_DIR=/var/www/combo/dist
EXPOSE 8080

CMD ["combo-relay", "--host", "0.0.0.0", "--port", "8080", "--static-dir", "/var/www/combo/dist"]
