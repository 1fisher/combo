# 代码签名 Secrets 配置

构建签名版本需要在 GitHub repo → Settings → Secrets and variables → Actions 中配置以下 Secrets。

> **未配置时会自动降级**:macOS 使用 ad-hoc 签名(`-`),Windows 不签名。
> ad-hoc 签名的 app 用户需「右键 → 打开」才能运行,Windows 会弹 SmartScreen 警告。

---

## macOS(Apple Developer 证书 + 公证)

需要 Apple Developer Program 会员($99/年)。从 [Apple Developer](https://developer.apple.com) 获取 "Developer ID Application" 证书。

| Secret 名 | 值 | 说明 |
|---|---|---|
| `APPLE_CERTIFICATE` | base64 编码的 `.p12` 证书 | `base64 -i certificate.p12 | pbcopy` |
| `APPLE_CERTIFICATE_PASSWORD` | 导出 .p12 时设置的密码 | |
| `APPLE_SIGNING_IDENTITY` | 如 `Developer ID Application: Your Name (XXXXXXXXXX)` | 钥匙串中的证书名称 |
| `APPLE_ID` | Apple ID 邮箱 | 用于公证 |
| `APPLE_PASSWORD` | App 专用密码 | 在 [appleid.apple.com](https://appleid.apple.com) → 登录与安全 → App 专用密码 生成 |
| `APPLE_TEAM_ID` | 团队 ID | Developer Account → Membership Details |

### 导出 .p12 并 base64 编码

```bash
# 1. 在「钥匙串访问」中导出 "Developer ID Application" 证书为 .p12
# 2. base64 编码
base64 -i certificate.p12 | pbcopy   # macOS
# 或:
openssl base64 -in certificate.p12    # Linux
```

---

## Windows / Updater 签名

### Updater 签名密钥(Tauri 自动更新校验)

用于签署更新包 `.sig` 文件,客户端用 pubkey 校验完整性。

| Secret 名 | 值 | 说明 |
|---|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | Tauri 生成的私钥字符串 | 见下方生成方法 |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | 私钥密码 | 可留空 |

#### 生成签名密钥对

```bash
# 生成密钥对(在项目根目录执行)
npx @tauri-apps/cli signer generate -w ./combo-updater.key --ci

# 私钥内容 → 设为 GitHub Secret TAURI_SIGNING_PRIVATE_KEY
cat combo-updater.key

# 公钥内容 → 用于客户端验证(如启用自动更新功能)
cat combo-updater.key.pub

# ⚠️ 安全提醒:私钥文件不要提交到 git,生成后请妥善保管并删除本地副本
rm combo-updater.key combo-updater.key.pub
```

### Windows 代码签名证书(可选,消除 SmartScreen 警告)

需要从 DigiCert / Sectigo / Comodo 等 CA 购买代码签名证书。

将 `.pfx` 文件 base64 编码后设为 `TAURI_SIGNING_PRIVATE_KEY`,
证书密码设为 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`。

> 与 updater 签名密钥共用同一个 Secret 组,二者作用不同但环境变量名相同。

---

## 快速开始(最小可用配置)

如果暂时没有 Apple Developer 证书,只需配置 updater 签名密钥即可:

```bash
# 生成密钥
npx @tauri-apps/cli signer generate -w ./combo-updater.key --ci

# 在 GitHub repo 设置 2 个 Secrets:
# TAURI_SIGNING_PRIVATE_KEY = <combo-updater.key 的内容>
# TAURI_SIGNING_PRIVATE_KEY_PASSWORD = <密码,留空则不设>
```

之后 macOS 构建会用 ad-hoc 签名(可运行,需右键打开),Windows 构建会签署 updater `.sig` 文件。
