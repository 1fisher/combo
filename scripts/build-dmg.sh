#!/usr/bin/env bash
#
# DMG 智能打包:仅前端变更时跳过 Rust 编译,复用已编译的二进制直接重新 bundle。
#
# 原理:
# - Rust 侧输入(crates/ + src-tauri/ + Cargo.lock + vendor/ 等)内容指纹没变、
#   且 target/release/combo-app 存在 → 走 `npx tauri bundle`(只打包,不碰
#   cargo);否则走完整 `npx tauri build`。
# - 前端不再内嵌进二进制(tauri.conf.json 的 frontendDist 指向稳定兜底页,
#   src-tauri 的 ResourceFirstAssets 运行时优先读随包分发的 Resources/dist),
#   因此「旧二进制 + 新 dist」即完整的新版本,重打包无需重编译 Rust。
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

STAMP="target/.dmg-rust-inputs.sha256"
# tauri build 构建后会把 cargo 产物 combo-app 重命名为 mainBinaryName(Combo)
BIN="target/release/Combo"

# 参与 Rust 编译的输入清单(前端 dist/ 故意不在其中)
rust_input_files() {
    {
        find crates src-tauri/src -type f \( -name '*.rs' -o -name 'Cargo.toml' \) 2>/dev/null
        find src-tauri/capabilities -type f -name '*.json' 2>/dev/null
        find src-tauri/icons src-tauri/fallback-frontend -type f 2>/dev/null
        # rig-core 本地补丁
        find vendor -type f \( -name '*.rs' -o -name 'Cargo.toml' \) 2>/dev/null
        for f in Cargo.toml Cargo.lock \
            src-tauri/Cargo.toml src-tauri/tauri.conf.json src-tauri/build.rs \
            src-tauri/Info.plist src-tauri/entitlements.plist; do
            [ -f "$f" ] && printf '%s\n' "$f"
        done
    } | LC_ALL=C sort -u
}

rust_fingerprint() {
    # 文件内容逐个哈希后再整体哈希一次,得到稳定指纹
    rust_input_files | xargs shasum -a 256 2>/dev/null | shasum -a 256 | awk '{print $1}'
}

CURRENT="$(rust_fingerprint)"
PREV="$(cat "$STAMP" 2>/dev/null || true)"

echo "[1/2] 构建前端 (npm run build)..."
npm run build

# 前端已在 [1/2] 构建过;置空 beforeBuildCommand 避免 tauri build 重复构建前端
# (tauri-cli 对空字符串 hook 直接跳过)
SKIP_WEB_BUILD='{"build":{"beforeBuildCommand":""}}'

if [ -n "$PREV" ] && [ "$CURRENT" = "$PREV" ] && [ -x "$BIN" ]; then
    echo "[2/2] Rust 无变化 → 跳过 cargo 编译,复用二进制重新打包 (tauri bundle)..."
    npx tauri bundle --bundles dmg
else
    echo "[2/2] Rust 有变化(或首次/清理后打包)→ 完整构建 (tauri build)..."
    npx tauri build --bundles dmg --config "$SKIP_WEB_BUILD"
fi

mkdir -p target
printf '%s\n' "$CURRENT" >"$STAMP"
