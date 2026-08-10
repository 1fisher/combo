#!/usr/bin/env bash
# 版本管理脚本:在所有配置文件中统一升级版本号。
#
# 用法:
#   bash scripts/version.sh patch     # 0.1.0 → 0.1.1
#   bash scripts/version.sh minor     # 0.1.0 → 0.2.0
#   bash scripts/version.sh major     # 0.1.0 → 1.0.0
#   bash scripts/version.sh 1.2.3     # 直接指定版本
#
# 更新文件:
#   - package.json
#   - src-tauri/tauri.conf.json
#   - src-tauri/Cargo.toml
#   - crates/combo-cli/Cargo.toml
set -euo pipefail

cd "$(dirname "$0")/.."

ROOT="$(pwd)"
FILES=(
  "package.json"
  "src-tauri/tauri.conf.json"
  "src-tauri/Cargo.toml"
  "crates/combo-cli/Cargo.toml"
)

# ---------- helpers ----------

current_version() {
  # 从 package.json 读取当前版本
  node -e "console.log(require('./package.json').version)"
}

validate_semver() {
  local v="$1"
  if ! echo "$v" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.]+)?$'; then
    echo "错误: 版本号不符合 semver 规范: $v" >&2
    exit 1
  fi
}

bump() {
  local current="$1"
  local part="$2"
  local major minor patch rest

  # 拆分 pre-release 后缀(如 -beta.1)
  local base="${current%%-*}"
  rest="${current#"$base"}" # 含前导 -,或为空

  IFS='.' read -r major minor patch <<<"$base"

  case "$part" in
    major)
      major=$((major + 1))
      minor=0
      patch=0
      rest=""
      ;;
    minor)
      minor=$((minor + 1))
      patch=0
      rest=""
      ;;
    patch)
      patch=$((patch + 1))
      rest=""
      ;;
    *)
      echo "错误: 未知的版本类型: $part" >&2
      exit 1
      ;;
  esac

  echo "${major}.${minor}.${patch}${rest}"
}

update_file() {
  local file="$1"
  local old_ver="$2"
  local new_ver="$3"

  local fpath="$ROOT/$file"
  if [ ! -f "$fpath" ]; then
    echo "警告: 文件不存在,跳过: $file" >&2
    return
  fi

  # JSON 文件(package.json, tauri.conf.json)
  if [[ "$file" == *.json ]]; then
    # 用 node 精确替换,避免 sed 转义问题
    node -e "
      const fs = require('fs');
      const p = '$fpath';
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (j.version !== '$old_ver') {
        console.error('警告: $file 中版本为 ' + j.version + ', 与预期 $old_ver 不一致');
      }
      j.version = '$new_ver';
      fs.writeFileSync(p, JSON.stringify(j, null, 2) + '\n');
    "
  elif [[ "$file" == *.toml ]]; then
    # Cargo.toml: 替换 [package] 段的 version = "..."
    # macOS 和 GNU sed 兼容写法
    sed -i.bak "s|^version = \"$old_ver\"|version = \"$new_ver\"|" "$fpath" 2>/dev/null || \
      sed -i '' "s|^version = \"$old_ver\"|version = \"$new_ver\"|" "$fpath"
    rm -f "$fpath.bak"
  fi
  echo "  ✓ $file: $old_ver → $new_ver"
}

# ---------- main ----------

main() {
  local input="${1:-}"
  if [ -z "$input" ] || [[ "$input" == --* ]]; then
    echo "用法: bash scripts/version.sh <patch|minor|major|VERSION>"
    echo "示例:"
    echo "  bash scripts/version.sh patch      # 0.1.0 → 0.1.1"
    echo "  bash scripts/version.sh minor      # 0.1.0 → 0.2.0"
    echo "  bash scripts/version.sh major      # 0.1.0 → 1.0.0"
    echo "  bash scripts/version.sh 1.2.3      # 直接指定版本"
    exit 1
  fi

  local cur new
  cur="$(current_version)"
  echo "当前版本: $cur"

  case "$input" in
    patch|minor|major)
      new="$(bump "$cur" "$input")"
      ;;
    *)
      validate_semver "$input"
      new="$input"
      ;;
  esac

  if [ "$cur" = "$new" ]; then
    echo "版本无变化,已退出。"
    exit 0
  fi

  echo "新版本: $new"
  echo "更新文件:"

  for f in "${FILES[@]}"; do
    update_file "$f" "$cur" "$new"
  done

  # 更新 Cargo.lock(如果存在且 cargo 可用)
  if [ -f "$ROOT/Cargo.lock" ] && command -v cargo >/dev/null 2>&1; then
    echo "  更新 Cargo.lock…"
    (cd "$ROOT" && cargo update -p combo --precise "$new") 2>/dev/null || true
    (cd "$ROOT" && cargo update -p combo-cli --precise "$new") 2>/dev/null || true
  fi

  echo ""
  echo "完成! 版本已从 ${cur} 升级到 ${new}。"
  echo "下一步:"
  echo "  git add -A && git commit -m \"chore: bump version to ${new}\""
  echo "  git tag v${new}"
  echo "  git push origin main --tags"
}

main "$@"
