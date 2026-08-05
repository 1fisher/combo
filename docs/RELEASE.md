# 发布流程

## 自动发布(GitHub Actions)

在 GitHub 仓库页面 → **Actions** → **Release** → **Run workflow** 即可触发。

选择参数:
- **版本类型**: `patch`(修复) / `minor`(功能) / `major`(破坏性变更)
- **预发布**: 标记为 pre-release
- **草稿**: 创建为 draft release

触发后自动完成:
1. 升级版本号(4 个文件 + Cargo.lock)
2. 从 git log 生成 changelog
3. 提交版本变更并打 tag
4. 构建各平台安装包(macOS arm/x86、Windows、Linux)
5. 创建 GitHub Release 并上传产物

## 手动发布(命令行)

```bash
# 1. 升级版本(patch / minor / major / 具体版本号)
bash scripts/version.sh patch

# 2. 提交并打 tag
git add -A
git commit -m "chore: bump version to $(node -p "require('./package.json').version")"
git tag "v$(node -p "require('./package.json').version")"

# 3. 推送(触发自动构建)
git push origin main --tags
```

## 版本号管理

版本号同步更新在以下文件:

| 文件 | 字段 |
|------|------|
| `package.json` | `version` |
| `src-tauri/tauri.conf.json` | `version` |
| `src-tauri/Cargo.toml` | `version` |
| `crates/combo-proxy/Cargo.toml` | `version` |

遵循 [SemVer](https://semver.org/lang/zh-CN/) 规范: `MAJOR.MINOR.PATCH`
