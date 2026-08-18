#!/usr/bin/env bash
# 用本地自签名证书重新签名 Combo.app。
#
# 背景:macOS 按「代码签名身份」记录麦克风等 TCC 隐私权限。ad-hoc 签名
# (signingIdentity "-")每次构建 CDHash 都变,TCC 视为新应用 —— 系统设置 →
# 隐私与安全性 → 麦克风 列表里不显示 Combo,权限无法开启。
# 自签名证书的签名身份稳定(certificate-leaf 哈希),TCC 能正常记录与列出;
# 每次重新构建后重新运行本脚本即可保持同一身份。
#
# 用法:
#   bash scripts/macos-sign-dev.sh [/Applications/Combo.app]
# 发布版请走 CI 的 Developer ID 签名(见 .github/workflows/release.yml)。
set -euo pipefail

APP="${1:-/Applications/Combo.app}"
IDENTITY="Combo Dev Signing"
KEYCHAIN="$HOME/Library/Keychains/combo-dev-signing.keychain-db"
CERT_PEM="/tmp/combo-dev-cert.pem"
KEY_PEM="/tmp/combo-dev-key.pem"

# ── 1. 身份缺失时自动创建(专用 keychain + 自签名证书 + 信任设置) ──────────
if ! security find-identity -v -p codesigning "$KEYCHAIN" 2>/dev/null | rg -q "$IDENTITY"; then
  echo "→ 创建自签名代码签名身份: $IDENTITY"
  rm -f "$KEYCHAIN"
  security create-keychain -p "" "$KEYCHAIN"
  security set-keychain-settings -lut 21600 "$KEYCHAIN"   # 6h 免解锁窗口
  openssl req -x509 -newkey rsa:2048 -keyout "$KEY_PEM" -out "$CERT_PEM" \
    -days 1825 -nodes -subj "/CN=$IDENTITY" \
    -addext "basicConstraints=critical,CA:FALSE" \
    -addext "keyUsage=critical,digitalSignature" \
    -addext "extendedKeyUsage=critical,codeSigning" 2>/dev/null
  security import "$CERT_PEM" -k "$KEYCHAIN" -T /usr/bin/codesign -T /usr/bin/security
  security import "$KEY_PEM" -k "$KEYCHAIN" -T /usr/bin/codesign -T /usr/bin/security
  security unlock-keychain -p "" "$KEYCHAIN"
  security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "" "$KEYCHAIN" >/dev/null 2>&1
  security add-trusted-cert -r trustRoot -k "$HOME/Library/Keychains/login.keychain-db" "$CERT_PEM"
fi

# ── 2. 确保 keychain 在搜索列表(codesign 按名称找身份) ──────────────────
if ! security list-keychains -d user | rg -q "$KEYCHAIN"; then
  security list-keychains -d user -s "$KEYCHAIN" "$HOME/Library/Keychains/login.keychain-db"
fi

# ── 3. 重新签名(保持 hardened runtime + 麦克风 entitlement)并验证 ────────
# hardened runtime 应用若缺 com.apple.security.device.audio-input,
# macOS 会静默拒绝麦克风:不弹授权框、系统设置列表不显示应用。
ENTITLEMENTS="/Users/fisherfeng/work/combo/src-tauri/entitlements.plist"
codesign --force --sign "$IDENTITY" --options runtime --entitlements "$ENTITLEMENTS" "$APP"
codesign --verify --deep --strict "$APP"
echo "✓ 已用 $IDENTITY 重新签名(含麦克风 entitlement): $APP"
echo "  系统设置 → 隐私与安全性 → 麦克风 应能正常列出并授权 Combo。"
