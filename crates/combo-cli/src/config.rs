//! 配置文件:首次运行自动在用户目录生成,CLI 参数 > 配置文件 > 默认值。
//!
//! 默认路径固定为 `~/.config/combo/combo-cli.toml`,可用 `COMBO_CONFIG_DIR` 覆盖目录。

use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// 单个已保存的 API Key。配置文件中兼容两种形式(serde untagged 自动识别):
/// - 纯字符串(旧格式):`api_keys = ["sk-1", "sk-2"]`
/// - 对象(可带名称,便于记忆):`api_keys = [{ key = "sk-1", name = "工作" }, "sk-2"]`
///
/// 未命名时序列化为字符串,保持旧配置文件格式不变。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ApiKeyEntry {
    Plain(String),
    Named {
        key: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        name: Option<String>,
    },
}

impl ApiKeyEntry {
    /// key 原文(可能为 `$ENV_VAR` 形式)。
    pub fn key(&self) -> &str {
        match self {
            Self::Plain(k) => k,
            Self::Named { key, .. } => key,
        }
    }

    /// 用户自定义名称(可选)。
    pub fn name(&self) -> Option<&str> {
        match self {
            Self::Named { name, .. } => name.as_deref(),
            Self::Plain(_) => None,
        }
    }

    pub fn plain(key: impl Into<String>) -> Self {
        Self::Plain(key.into())
    }

    pub fn named(key: impl Into<String>, name: impl Into<String>) -> Self {
        Self::Named {
            key: key.into(),
            name: Some(name.into()),
        }
    }
}

/// 内嵌 provider 定义。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct ProviderConfig {
    /// 显示名称(自定义 provider 用于 UI 展示;缺省显示 id)。
    pub name: Option<String>,
    /// provider 类型:openai / openai-compat / anthropic / google / azure ...
    #[serde(rename = "type")]
    pub provider_type: Option<String>,
    /// 明文 key 或 `$ENV_VAR`(当前激活的 key)。
    pub api_key: Option<String>,
    /// 该 provider 已保存的全部 key 列表(按保存顺序,UI 可自由切换激活项)。
    /// 元素可为纯字符串或带 name 的对象。
    #[serde(default)]
    pub api_keys: Vec<ApiKeyEntry>,
    /// API endpoint。
    pub base_url: Option<String>,
    /// 默认大模型 id。
    pub default_large_model_id: Option<String>,
    /// 默认小模型 id。
    pub default_small_model_id: Option<String>,
    /// 手动设置的模型上下文窗口(token 数,key = 模型 id)。前端设置界面
    /// 写入;运行时压缩预算与前端用量展示共用该覆盖,清除即恢复默认,
    /// 避免前后端各存一份导致「显示未满却频繁触发上下文压缩」。
    #[serde(default)]
    pub context_windows: BTreeMap<String, i64>,
}

/// 模型引用(large/small)。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct ModelsConfig {
    pub large: Option<ModelRef>,
    pub small: Option<ModelRef>,
}

/// 单个模型引用。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct ModelRef {
    pub model: String,
    pub provider: Option<String>,
    pub reasoning_effort: Option<String>,
    pub max_tokens: Option<i64>,
}

impl Default for ModelRef {
    fn default() -> Self {
        Self {
            model: String::new(),
            provider: None,
            reasoning_effort: None,
            max_tokens: None,
        }
    }
}

/// MCP server 配置。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct McpServerConfig {
    /// 传输类型:stdio / http。
    #[serde(rename = "type")]
    pub transport: String,
    /// stdio 命令。
    pub command: Option<String>,
    /// stdio 命令参数。
    pub args: Option<Vec<String>>,
    /// http URL。
    pub url: Option<String>,
}

/// LSP server 配置。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct LspServerConfig {
    pub command: String,
    pub args: Option<Vec<String>>,
    pub env: Option<BTreeMap<String, String>>,
}

/// 配置文件路径。优先级:`COMBO_CONFIG_DIR` > `~/.config`。
/// 默认固定为 `~/.config/combo/combo-cli.toml`(不走 XDG_CONFIG_HOME)。
pub fn default_config_path() -> PathBuf {
    crate::paths::default_config_dir().join("combo-cli.toml")
}

/// 加载配置文件同目录下的 `.env` 到进程环境,供 `$ENV_VAR` 形式的
/// api_key/base_url 引用取默认值。规则:
/// - `.env` 不存在时自动生成带注释的模板(见 `write_default_dotenv`);
/// - 已存在的环境变量优先,`.env` 不覆盖(仅补默认值);
/// - 支持 `#` 注释、`export ` 前缀、单/双引号值、`$VAR`/`${VAR}` 展开
///   (展开查进程环境,含本文件先前已加载的行);
/// - 文件不存在(生成失败)或行格式非法时静默忽略。
pub fn load_dotenv(config_path: &Path) {
    let Some(dir) = config_path.parent() else { return };
    let env_path = dir.join(".env");
    if !env_path.exists() {
        let _ = write_default_dotenv(&env_path); // 首次运行自动生成模板
    }
    let Ok(text) = std::fs::read_to_string(&env_path) else { return };
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let line = line.strip_prefix("export ").unwrap_or(line).trim();
        let Some(eq) = line.find('=') else { continue };
        let key = line[..eq].trim();
        if !is_valid_key(key) {
            continue;
        }
        if std::env::var(key).is_ok() {
            continue; // 已有环境变量优先
        }
        let raw = line[eq + 1..].trim();
        std::env::set_var(key, expand_vars(&unquote(raw)));
    }
}

/// 生成默认 `.env` 模板(仅当文件不存在时由 `load_dotenv` 调用)。
/// 模板默认启用 `RUST_LOG=info`(tracing 初始化前已加载,直接生效),
/// 并提供各 provider 的 API key 占位注释。
pub fn write_default_dotenv(env_path: &Path) -> Result<()> {
    if env_path.exists() {
        return Ok(());
    }
    let template = r#"# combo-cli .env —— 默认配置值(首次运行自动生成,与 combo-cli.toml 同目录)
# 已存在的环境变量优先,.env 不覆盖;支持 # 注释、export 前缀、
# 单/双引号值、$VAR / ${VAR} 展开。建议把敏感值放这里,配置中用 $KEY 引用。

# ========== 日志 ==========
# 日志级别:error / warn / info / debug / trace
RUST_LOG=info

# ========== API key(去掉 # 并填入实际值)==========
# DEEPSEEK_API_KEY=sk-xxx
# ZAI_API_KEY=sk-xxx
# OPENCODE_API_KEY=sk-xxx
"#;
    if let Some(parent) = env_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(env_path, template)?;
    Ok(())
}

/// 环境变量名:`[A-Za-z_][A-Za-z0-9_]*`。
fn is_valid_key(key: &str) -> bool {
    let mut chars = key.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() || c == '_' => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// 去掉配对的首尾引号(单引号/双引号)。
fn unquote(v: &str) -> String {
    let b = v.as_bytes();
    if b.len() >= 2 && ((b[0] == b'"' && b[b.len() - 1] == b'"') || (b[0] == b'\'' && b[b.len() - 1] == b'\'')) {
        v[1..v.len() - 1].to_string()
    } else {
        v.to_string()
    }
}

/// 展开 `$VAR` 与 `${VAR}`;未定义的变量展开为空串。
fn expand_vars(s: &str) -> String {
    let mut out = String::new();
    let mut rest = s;
    while let Some(dollar) = rest.find('$') {
        out.push_str(&rest[..dollar]);
        let after = &rest[dollar + 1..];
        if let Some(inner) = after.strip_prefix('{') {
            if let Some(end) = inner.find('}') {
                out.push_str(&std::env::var(&inner[..end]).unwrap_or_default());
                rest = &inner[end + 1..];
                continue;
            }
        }
        let end = after
            .find(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
            .unwrap_or(after.len());
        if end == 0 {
            out.push('$');
            rest = after;
            continue;
        }
        out.push_str(&std::env::var(&after[..end]).unwrap_or_default());
        rest = &after[end..];
    }
    out.push_str(rest);
    out
}

/// 配置文件内容。所有字段可选:未设置的项回退到 CLI 参数或默认值。
///
/// 结构:`providers`(内嵌多 API key)、`models`(large/small 引用)、
/// `mcp`、`lsp`、`skills_paths`。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct AppConfig {
    /// 默认提供商 id(如 opencode / deepseek / zhipu / openrouter);
    /// 未设置时回退内置 opencode(zen,免 key 可从 opencode auth.json 自动导入)
    pub provider: Option<String>,
    /// 默认模型名(未设置时用 provider 的 default_large_model_id)
    pub model: Option<String>,
    /// 系统提示词
    pub preamble: Option<String>,
    /// 是否启用内置工具
    pub tools: Option<bool>,
    /// MCP server 命令(stdio,兼容旧版单 server)
    pub mcp_command: Option<String>,
    /// MCP server URL(streamable HTTP,兼容旧版单 server)
    pub mcp_url: Option<String>,
    /// API key(兼容旧版,单一 provider 时使用)
    pub api_key: Option<String>,
    /// 自定义 API base URL(兼容旧版)
    pub base_url: Option<String>,
    /// 内嵌 provider 定义(key = provider id)。
    #[serde(default)]
    pub providers: BTreeMap<String, ProviderConfig>,
    /// 模型引用(large/small)。
    #[serde(default)]
    pub models: ModelsConfig,
    /// MCP server 配置(key = server 名)。
    #[serde(default)]
    pub mcp: BTreeMap<String, McpServerConfig>,
    /// LSP server 配置(key = 语言/服务器名)。
    #[serde(default)]
    pub lsp: BTreeMap<String, LspServerConfig>,
    /// skills 搜索路径(默认 ~/.config/combo/skills)。
    #[serde(default)]
    pub skills_paths: Vec<String>,
    /// 禁用的 skill 名列表。
    #[serde(default)]
    pub disabled_skills: Vec<String>,
    /// git 提交时是否自动追加 "Generated with Combo vX.Y.Z" 署名(默认 true)。
    pub commit_attribution: Option<bool>,
    /// Git 提交设置(`[git]` 段)。
    #[serde(default)]
    pub git: GitConfig,
    /// 语音识别(ASR)设置。
    #[serde(default)]
    pub asr: AsrConfig,
    /// 语音合成(TTS)设置。
    #[serde(default)]
    pub tts: TtsConfig,
    /// multi-agent 子 agent 角色定义(`[agents.<name>]` 段)。
    /// 与内置角色同名时覆盖字段,新名追加自定义角色,`disabled = true` 移除。
    #[serde(default)]
    pub agents: BTreeMap<String, AgentRoleConfig>,
}

/// multi-agent 子 agent 角色配置(`[agents.<name>]` 段)。
/// 与内置角色(researcher/coder/reviewer)同名时覆盖已设置的字段;
/// 全新名称追加为自定义角色;`disabled = true` 可移除内置角色。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct AgentRoleConfig {
    /// 角色说明(展示给主 agent,帮助其选择合适的角色)。
    pub description: Option<String>,
    /// 系统提示词(角色的完整 preamble)。
    pub preamble: Option<String>,
    /// 覆盖 provider id(缺省继承主对话的 provider)。
    pub provider: Option<String>,
    /// 覆盖模型名(缺省继承主对话模型;换了 provider 时回落其默认大模型)。
    pub model: Option<String>,
    /// 推理强度覆盖(nothink / high / max)。
    pub reasoning_effort: Option<String>,
    /// 只读角色(true 时该子 agent 无写文件/执行命令权限)。
    pub readonly: Option<bool>,
    /// 禁用该角色(用于移除内置角色)。
    pub disabled: Option<bool>,
}

/// Git 提交设置(`[git]` 段)。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct GitConfig {
    /// AI 生成提交信息时是否使用全局指定的模型(关闭或未配置时用会话模型)。
    pub commit_model_enabled: Option<bool>,
    /// 全局提交模型 provider id。
    pub commit_model_provider: Option<String>,
    /// 全局提交模型名(留空时用 provider 的默认大模型)。
    pub commit_model: Option<String>,
}

/// 语音识别(ASR)配置(`[asr]` 段)。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct AsrConfig {
    /// ASR 模型 id:`sense-voice`(中文,默认)/ `moonshine-zh`(中文)/ `moonshine-en`(英文)。
    pub model: Option<String>,
}

impl AsrConfig {
    /// 解析为模型枚举;未设置或非法值回落默认(sense-voice)。
    pub fn resolve_model(&self) -> crate::asr::AsrModel {
        self.model
            .as_deref()
            .and_then(crate::asr::AsrModel::parse)
            .unwrap_or(crate::asr::AsrModel::SenseVoice)
    }
}

/// 语音合成(TTS)配置(`[tts]` 段)。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct TtsConfig {
    /// 朗读开关,默认关闭。
    pub enabled: Option<bool>,
    /// TTS 模型 id:piper-zh-xiaoya(默认)/ piper-zh-chaowen / vits-zh-fanchen-c / vits-zh-en-melo(中英双语)。
    pub model: Option<String>,
    /// 朗读语速倍率(0.5~2.0,1.0 为正常语速)。
    pub speed: Option<f32>,
}

impl TtsConfig {
    /// 朗读开关;未设置默认关闭。
    pub fn resolve_enabled(&self) -> bool {
        self.enabled.unwrap_or(false)
    }

    /// 解析为模型枚举;未设置或非法值回落默认(piper-zh-xiaoya)。
    pub fn resolve_model(&self) -> crate::tts::TtsModel {
        self.model
            .as_deref()
            .and_then(crate::tts::TtsModel::parse)
            .unwrap_or(crate::tts::TtsModel::PiperZhXiaoya)
    }

    /// 朗读语速倍率;未设置或非法值回落 1.0(正常语速)。
    pub fn resolve_speed(&self) -> f32 {
        self.speed.filter(|s| (0.5..=2.0).contains(s)).unwrap_or(1.0)
    }
}

impl AppConfig {
    /// 读取配置文件;不存在时自动生成默认文件并返回空配置。
    pub fn load_or_create(path: &PathBuf) -> Result<Self> {
        if path.exists() {
            let text = std::fs::read_to_string(path)?;
            let cfg: AppConfig = toml::from_str(&text)
                .map_err(|e| anyhow::anyhow!("解析配置文件 {} 失败: {e}", path.display()))?;
            Ok(cfg)
        } else {
            write_default(path, false)?;
            Ok(AppConfig::default())
        }
    }

    /// 将配置合并到 CLI 参数上:CLI 显式传入的值优先。
    ///
    /// `cli_provider` 等参数为 `None` 表示用户未通过命令行指定。
    pub fn resolve(
        &self,
        cli_provider: Option<&str>,
        cli_model: Option<&str>,
        cli_preamble: Option<&str>,
        cli_tools: Option<bool>,
        cli_mcp_command: Option<&str>,
        cli_mcp_url: Option<&str>,
    ) -> ResolvedConfig {
        // 默认 provider 也参考 models.large(若配置了 provider 引用);
        // 兜底取内置 opencode(zen)——openai 不在内置列表,冷环境会解析失败
        let provider = cli_provider
            .or(self.provider.as_deref())
            .or_else(|| self.models.large.as_ref().and_then(|m| m.provider.as_deref()))
            .unwrap_or("opencode")
            .to_string();
        // 默认模型:CLI > 配置 model > models.large.model > provider 默认
        let model = cli_model
            .or(self.model.as_deref())
            .or_else(|| self.models.large.as_ref().map(|m| m.model.as_str()))
            .map(String::from);

        ResolvedConfig {
            provider,
            model,
            preamble: cli_preamble
                .or(self.preamble.as_deref())
                .unwrap_or("你是 combo 内置的智能助手。")
                .to_string(),
            tools: cli_tools.or(self.tools).unwrap_or(true),
            mcp_command: cli_mcp_command
                .map(String::from)
                .or_else(|| self.mcp_command.clone()),
            mcp_url: cli_mcp_url
                .map(String::from)
                .or_else(|| self.mcp_url.clone()),
            api_key: self.api_key.clone(),
            base_url: self.base_url.clone(),
            providers: self.providers.clone(),
            models: self.models.clone(),
            mcp: self.mcp.clone(),
            lsp: self.lsp.clone(),
            skills_paths: self.skills_paths.clone(),
            disabled_skills: self.disabled_skills.clone(),
            reasoning_effort: None,
        }
    }
}

/// 从 opencode 的 auth.json 读取 API key。
///
/// opencode 把 provider key 存在 `~/.local/share/opencode/auth.json`,
/// 格式 `{ "<provider>": { "type": "api", "key": "..." } }`。
/// opencode zen 的 key 挂在 `opencode` 条目下(与 combo-cli 的 opencode
/// provider 对应);`zai` 条目是 Z.ai 智谱的 key。
pub fn opencode_auth_path() -> PathBuf {
    if let Ok(dir) = std::env::var("OPENCODE_DATA_DIR") {
        return PathBuf::from(dir).join("auth.json");
    }
    let base = std::env::var("XDG_DATA_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
            PathBuf::from(home).join(".local/share")
        });
    base.join("opencode").join("auth.json")
}

/// 读取 opencode auth.json 中指定 provider 的 API key。
pub fn read_opencode_key(provider: &str) -> Result<Option<String>> {
    let path = opencode_auth_path();
    if !path.exists() {
        return Ok(None);
    }
    let text = std::fs::read_to_string(&path)?;
    let data: serde_json::Value = serde_json::from_str(&text)
        .map_err(|e| anyhow::anyhow!("解析 {} 失败: {e}", path.display()))?;
    let key = data
        .get(provider)
        .and_then(|p| p.get("key"))
        .and_then(serde_json::Value::as_str)
        .map(String::from);
    Ok(key)
}

/// 把 opencode 的 opencode zen key 写入 combo-cli 配置文件。
///
/// 若 key 已存在则保留现有值;写入后同时把 provider 设为 opencode。
pub fn import_opencode_key(path: &PathBuf) -> Result<()> {
    let Some(key) = read_opencode_key("opencode")? else {
        anyhow::bail!(
            "未找到 opencode zen key:{} 不存在或缺少 opencode 条目",
            opencode_auth_path().display()
        );
    };

    // 读现有配置(不存在则新建)
    let mut cfg = if path.exists() {
        let text = std::fs::read_to_string(path)?;
        toml::from_str::<AppConfig>(&text)
            .map_err(|e| anyhow::anyhow!("解析配置文件 {} 失败: {e}", path.display()))?
    } else {
        write_default(path, false)?;
        AppConfig::default()
    };

    cfg.api_key = Some(key.clone());
    cfg.provider = Some("opencode".into());
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let out = toml::to_string_pretty(&cfg)
        .map_err(|e| anyhow::anyhow!("序列化配置失败: {e}"))?;
    std::fs::write(path, out)?;
    println!(
        "已导入 opencode zen key 到 {} (provider=opencode)",
        path.display()
    );
    println!("key: {}...{}", &key[..8], &key[key.len().saturating_sub(6)..]);
    Ok(())
}

/// 读取配置文件(不存在则生成默认模板)。
fn load_config(path: &PathBuf) -> Result<AppConfig> {
    if path.exists() {
        let text = std::fs::read_to_string(path)?;
        toml::from_str::<AppConfig>(&text)
            .map_err(|e| anyhow::anyhow!("解析配置文件 {} 失败: {e}", path.display()))
    } else {
        write_default(path, false)?;
        Ok(AppConfig::default())
    }
}

/// 写回配置文件。
fn write_config(path: &PathBuf, cfg: &AppConfig) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let out = toml::to_string_pretty(cfg).map_err(|e| anyhow::anyhow!("序列化配置失败: {e}"))?;
    std::fs::write(path, out)?;
    Ok(())
}

/// 把 provider 的 API key 保存到配置文件(设为激活 key,并加入 key 列表)。
///
/// 写入 `[providers.{provider_id}]` 段;若 provider 段不存在则创建。
/// api_key 为明文(不使用 $ENV_VAR 形式,因为是 UI 直接输入的值)。
/// provider_type / base_url 可选,用于补全 provider 定义。
pub fn save_provider_key(
    path: &PathBuf,
    provider_id: &str,
    api_key: &str,
    provider_type: Option<&str>,
    base_url: Option<&str>,
) -> Result<()> {
    let mut cfg = load_config(path)?;

    let entry = cfg
        .providers
        .entry(provider_id.to_string())
        .or_insert_with(ProviderConfig::default);
    entry.api_key = Some(api_key.to_string());
    if !api_key.is_empty() && !entry.api_keys.iter().any(|k| k.key() == api_key) {
        entry.api_keys.push(ApiKeyEntry::plain(api_key));
    }
    if let Some(pt) = provider_type {
        entry.provider_type = Some(pt.to_string());
    }
    if let Some(url) = base_url {
        if !url.is_empty() {
            entry.base_url = Some(url.to_string());
        }
    }

    write_config(path, &cfg)
}

/// 追加一个 key 到 provider 的 key 列表;已存在则视为切换激活(并可选更新名称)。
/// 当前没有激活 key 时,新加的 key 自动成为激活 key。
pub fn add_provider_key(
    path: &PathBuf,
    provider_id: &str,
    api_key: &str,
    name: Option<&str>,
) -> Result<()> {
    let key = api_key.trim();
    if key.is_empty() {
        return Err(anyhow::anyhow!("API Key 不能为空"));
    }
    let name = name.map(str::trim).filter(|s| !s.is_empty());
    let mut cfg = load_config(path)?;
    let entry = cfg
        .providers
        .entry(provider_id.to_string())
        .or_insert_with(ProviderConfig::default);
    if let Some(existing) = entry.api_keys.iter_mut().find(|k| k.key() == key) {
        // key 已存在:若有新名称则更新(便于给旧 key 补命名)
        if let Some(n) = name {
            let key_owned = existing.key().to_string();
            *existing = ApiKeyEntry::named(key_owned, n);
        }
    } else {
        entry.api_keys.push(match name {
            Some(n) => ApiKeyEntry::named(key.to_string(), n),
            None => ApiKeyEntry::plain(key.to_string()),
        });
    }
    // 无激活 key(或激活的是空串)时自动激活新 key
    if entry.api_key.as_deref().unwrap_or("").is_empty() {
        entry.api_key = Some(key.to_string());
    }
    write_config(path, &cfg)
}

/// 按列表下标切换激活 key。
pub fn activate_provider_key(path: &PathBuf, provider_id: &str, index: usize) -> Result<()> {
    let mut cfg = load_config(path)?;
    let entry = cfg
        .providers
        .get_mut(provider_id)
        .ok_or_else(|| anyhow::anyhow!("provider `{provider_id}` 未配置任何 Key"))?;
    let key = entry
        .api_keys
        .get(index)
        .ok_or_else(|| anyhow::anyhow!("Key 下标 {index} 越界"))?
        .key()
        .to_string();
    entry.api_key = Some(key);
    write_config(path, &cfg)
}

/// 按列表下标删除 key;若删除的是激活 key,激活剩余第一个 key。
pub fn remove_provider_key(path: &PathBuf, provider_id: &str, index: usize) -> Result<()> {
    let mut cfg = load_config(path)?;
    let entry = cfg
        .providers
        .get_mut(provider_id)
        .ok_or_else(|| anyhow::anyhow!("provider `{provider_id}` 未配置任何 Key"))?;
    let removed = entry
        .api_keys
        .get(index)
        .ok_or_else(|| anyhow::anyhow!("Key 下标 {index} 越界"))?
        .key()
        .to_string();
    entry.api_keys.remove(index);
    // 删除的是激活 key:激活剩余第一个;删空则清除激活
    if entry.api_key.as_deref() == Some(removed.as_str()) {
        entry.api_key = entry.api_keys.first().map(|k| k.key().to_string());
    }
    if entry.api_keys.is_empty() {
        entry.api_key = None;
    }
    write_config(path, &cfg)
}

/// 按列表下标设置 key 的名称(name 为空则清除名称,还原为纯字符串)。
pub fn rename_provider_key(
    path: &PathBuf,
    provider_id: &str,
    index: usize,
    name: Option<&str>,
) -> Result<()> {
    let mut cfg = load_config(path)?;
    let entry = cfg
        .providers
        .get_mut(provider_id)
        .ok_or_else(|| anyhow::anyhow!("provider `{provider_id}` 未配置任何 Key"))?;
    let k = entry
        .api_keys
        .get_mut(index)
        .ok_or_else(|| anyhow::anyhow!("Key 下标 {index} 越界"))?;
    let trimmed = name.map(str::trim).filter(|s| !s.is_empty());
    let key_owned = k.key().to_string();
    *k = match trimmed {
        Some(n) => ApiKeyEntry::named(key_owned, n),
        None => ApiKeyEntry::plain(key_owned),
    };
    write_config(path, &cfg)
}

/// 新增自定义 provider(写入 `[providers.<id>]` 段)。
///
/// id 仅允许字母/数字/`-`/`_`(TOML key 与 URL 安全),且不能与已有配置条目重复。
/// provider_type 缺省为 `openai-compat`;api_key 可选,提供时同时加入 key 列表并激活。
pub fn add_provider(
    path: &PathBuf,
    id: &str,
    name: Option<&str>,
    provider_type: Option<&str>,
    base_url: Option<&str>,
    api_key: Option<&str>,
    default_large_model_id: Option<&str>,
) -> Result<()> {
    let id = id.trim();
    if id.is_empty() {
        return Err(anyhow::anyhow!("Provider ID 不能为空"));
    }
    if !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err(anyhow::anyhow!("Provider ID 仅支持字母、数字、`-`、`_`"));
    }
    let name = name.map(str::trim).filter(|s| !s.is_empty());
    let provider_type = provider_type
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("openai-compat");
    let base_url = base_url.map(str::trim).filter(|s| !s.is_empty());
    let api_key = api_key.map(str::trim).filter(|s| !s.is_empty());
    let default_large_model_id = default_large_model_id
        .map(str::trim)
        .filter(|s| !s.is_empty());

    let mut cfg = load_config(path)?;
    if cfg.providers.contains_key(id) {
        return Err(anyhow::anyhow!("provider `{id}` 已存在"));
    }
    let mut entry = ProviderConfig {
        name: name.map(String::from),
        provider_type: Some(provider_type.to_string()),
        api_key: api_key.map(String::from),
        api_keys: Vec::new(),
        base_url: base_url.map(String::from),
        default_large_model_id: default_large_model_id.map(String::from),
        default_small_model_id: None,
        context_windows: BTreeMap::new(),
    };
    // 提供 key 时同时入列表并激活(与 save_provider_key 行为一致)
    if let Some(k) = api_key {
        entry.api_keys.push(ApiKeyEntry::plain(k.to_string()));
    }
    cfg.providers.insert(id.to_string(), entry);
    write_config(path, &cfg)
}

/// 删除配置文件中的自定义 provider(连同其全部 key)。
///
/// 仅删除配置条目:内置 provider 被删后回落内置定义(UI 侧已过滤内置项,
/// 这里不做限制,删除内置 id 的配置覆盖等价于「恢复默认」)。
pub fn remove_provider(path: &PathBuf, provider_id: &str) -> Result<()> {
    let mut cfg = load_config(path)?;
    if cfg.providers.remove(provider_id).is_none() {
        return Err(anyhow::anyhow!("provider `{provider_id}` 未在配置文件中定义"));
    }
    write_config(path, &cfg)
}

/// 设置/清除某 provider 下某模型的上下文窗口覆盖(token 数)。
///
/// 写入 `[providers.{provider_id}.context_windows]`;`window` 为 `None` 时删除
/// 该模型的覆盖条目(恢复默认)。压缩预算与前端用量展示共用该配置。
pub fn set_model_context_window(
    path: &PathBuf,
    provider_id: &str,
    model_id: &str,
    window: Option<i64>,
) -> Result<()> {
    let model_id = model_id.trim();
    if model_id.is_empty() {
        return Err(anyhow::anyhow!("model_id 不能为空"));
    }
    let mut cfg = load_config(path)?;
    match window {
        Some(w) => {
            if w <= 0 {
                return Err(anyhow::anyhow!("上下文窗口必须为正整数"));
            }
            let entry = cfg
                .providers
                .entry(provider_id.to_string())
                .or_insert_with(ProviderConfig::default);
            entry.context_windows.insert(model_id.to_string(), w);
        }
        None => {
            if let Some(entry) = cfg.providers.get_mut(provider_id) {
                entry.context_windows.remove(model_id);
            }
        }
    }
    write_config(path, &cfg)
}

/// 设置语音识别(ASR)模型,写入 `[asr] model = "<id>"`,跨重启保留。
pub fn set_asr_model(path: &PathBuf, model: &str) -> Result<()> {
    if crate::asr::AsrModel::parse(model).is_none() {
        return Err(anyhow::anyhow!("未知 ASR 模型 id: {model}"));
    }
    let mut cfg = load_config(path)?;
    cfg.asr.model = Some(model.to_string());
    write_config(path, &cfg)
}

/// 设置语音合成(TTS)开关,写入 `[tts] enabled`,跨重启保留。
pub fn set_tts_enabled(path: &PathBuf, enabled: bool) -> Result<()> {
    let mut cfg = load_config(path)?;
    cfg.tts.enabled = Some(enabled);
    write_config(path, &cfg)
}

/// 设置语音合成(TTS)模型,写入 `[tts] model = "<id>"`,跨重启保留。
pub fn set_tts_model(path: &PathBuf, model: &str) -> Result<()> {
    if crate::tts::TtsModel::parse(model).is_none() {
        return Err(anyhow::anyhow!("未知 TTS 模型 id: {model}"));
    }
    let mut cfg = load_config(path)?;
    cfg.tts.model = Some(model.to_string());
    write_config(path, &cfg)
}

/// 设置语音合成(TTS)语速倍率(0.5~2.0),写入 `[tts] speed`,跨重启保留。
pub fn set_tts_speed(path: &PathBuf, speed: f32) -> Result<()> {
    if !(0.5..=2.0).contains(&speed) {
        return Err(anyhow::anyhow!("语速倍率需在 0.5~2.0 之间"));
    }
    let mut cfg = load_config(path)?;
    cfg.tts.speed = Some(speed);
    write_config(path, &cfg)
}

/// 新增或更新一个 MCP server 配置(写入 `[mcp.<name>]` 段)。
///
/// name 仅允许字母/数字/`-`/`_`(TOML key 安全);`transport` 为 `stdio` / `http`。
/// stdio 需要 `command`(完整启动命令,可含参数),http 需要 `url`。
/// `command` 直接按原样落盘;运行时由 `AskConfig::from_resolved` 解析为 argv
/// (合并 args 后经 `shell_words` 拆分),因此 UI 侧建议把参数一并写进 command。
pub fn upsert_mcp_server(
    path: &PathBuf,
    name: &str,
    transport: &str,
    command: Option<&str>,
    url: Option<&str>,
) -> Result<()> {
    let name = name.trim();
    if name.is_empty() {
        return Err(anyhow::anyhow!("MCP server 名称不能为空"));
    }
    if !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err(anyhow::anyhow!("MCP server 名称仅支持字母、数字、`-`、`_`"));
    }
    let transport = transport.trim().to_ascii_lowercase();
    if transport != "stdio" && transport != "http" {
        return Err(anyhow::anyhow!("MCP 传输类型仅支持 stdio 或 http"));
    }
    let command = command.map(str::trim).filter(|s| !s.is_empty()).map(String::from);
    let url = url.map(str::trim).filter(|s| !s.is_empty()).map(String::from);

    if transport == "stdio" && command.is_none() {
        return Err(anyhow::anyhow!("stdio 类型需要填写 command(启动命令)"));
    }
    if transport == "http" && url.is_none() {
        return Err(anyhow::anyhow!("http 类型需要填写 URL"));
    }

    let mut cfg = load_config(path)?;
    cfg.mcp.insert(
        name.to_string(),
        McpServerConfig {
            transport,
            command,
            args: None,
            url,
        },
    );
    write_config(path, &cfg)
}

/// 删除配置文件中的 MCP server。
pub fn remove_mcp_server(path: &PathBuf, name: &str) -> Result<()> {
    let mut cfg = load_config(path)?;
    if cfg.mcp.remove(name.trim()).is_none() {
        return Err(anyhow::anyhow!("MCP server `{}` 未在配置文件中定义", name));
    }
    write_config(path, &cfg)
}

/// 读取「git 提交署名」开关(配置文件缺省时默认开启)。
pub fn commit_attribution_enabled(path: &PathBuf) -> bool {
    AppConfig::load_or_create(path)
        .map(|c| c.commit_attribution.unwrap_or(true))
        .unwrap_or(true)
}

/// 写入「git 提交署名」开关到配置文件。
pub fn set_commit_attribution(path: &PathBuf, enabled: bool) -> Result<()> {
    let mut cfg = load_config(path)?;
    cfg.commit_attribution = Some(enabled);
    write_config(path, &cfg)
}

/// 读取「git 提交全局模型」配置:(开关, provider, model);未配置时均为空。
pub fn get_commit_model(path: &PathBuf) -> (bool, Option<String>, Option<String>) {
    match AppConfig::load_or_create(path) {
        Ok(c) => (
            c.git.commit_model_enabled.unwrap_or(false),
            c.git.commit_model_provider.clone(),
            c.git.commit_model.clone(),
        ),
        Err(_) => (false, None, None),
    }
}

/// 写入「git 提交全局模型」配置;provider/model 传 None 或空串表示清除。
pub fn set_commit_model(
    path: &PathBuf,
    enabled: bool,
    provider: Option<&str>,
    model: Option<&str>,
) -> Result<()> {
    let mut cfg = load_config(path)?;
    cfg.git.commit_model_enabled = Some(enabled);
    cfg.git.commit_model_provider = provider
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from);
    cfg.git.commit_model = model
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from);
    write_config(path, &cfg)
}

/// 解析生效的全局提交模型:开关开启且 provider 非空时返回 `(provider, model)`,
/// model 留空表示用 provider 默认大模型(由调用方解析);未启用返回 None
/// (生成提交信息时回退会话模型)。
pub fn commit_model_override(path: &PathBuf) -> Option<(String, Option<String>)> {
    let cfg = AppConfig::load_or_create(path).ok()?;
    if !cfg.git.commit_model_enabled.unwrap_or(false) {
        return None;
    }
    let provider = cfg
        .git
        .commit_model_provider
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())?
        .to_string();
    let model = cfg
        .git
        .commit_model
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from);
    Some((provider, model))
}

/// 写入默认配置文件模板。`overwrite=false` 时若文件已存在则不写。
pub fn write_default(path: &PathBuf, overwrite: bool) -> Result<()> {
    if path.exists() && !overwrite {
        return Ok(());
    }
    let template = r#"# combo-cli 配置文件(自动生成)
# 优先级:命令行参数 > 本文件 > 内置默认值

# 默认提供商 id(opencode / deepseek / zhipu / openrouter / ...);
# 未设置时默认用内置 opencode(zen)
# provider = "opencode"

# 默认模型名(留空则按提供商取默认,或参考 [models])
# model = "gpt-4o"

# 系统提示词
# preamble = "你是 combo 内置的智能助手。"

# 是否启用内置工具(当前时间/日期),默认 true
# tools = true

# git 提交时是否自动追加 "Generated with Combo vX.Y.Z" 署名,默认 true
# commit_attribution = true

# ========== Git 提交 ==========
# AI 生成提交信息时使用的模型:关闭时用当前会话的模型,
# 开启后所有项目的提交信息统一用下方指定的模型生成。
# [git]
# commit_model_enabled = false
# commit_model_provider = "deepseek"
# commit_model = "deepseek-chat"

# ========== 语音识别(ASR)==========
# 输入框语音输入的本地模型:
#   sense-voice(中文,默认)/ moonshine-zh(Moonshine v2 中英)/ moonshine-en(英文)。
# 首次使用自动下载模型文件;也可在应用「设置」中切换。
# [asr]
# model = "sense-voice"

# ========== 语音合成(TTS)==========
# 朗读 agent 回复的本地模型:
#   piper-zh-xiaoya(中文女声,默认)/ piper-zh-chaowen(中文男声)/ vits-zh-fanchen-c(高质量女声)。
# 首次使用自动下载模型文件;也可在应用「设置」中打开朗读开关并切换模型。
# [tts]
# enabled = false
# model = "piper-zh-xiaoya"
# 朗读语速倍率(0.5~2.0,1.0 为正常语速,2.0 最快)
# speed = 1.0

# ========== 多 API key 配置 ==========
# 每个 provider 一个表,key = provider id;api_key 可为明文或 $ENV_VAR。
# 未在此定义的 provider 会依次回退到 combo providers.json
# (~/.config/combo/providers.json)与内置定义。
# 提示:同目录的 .env 文件会在启动时加载到环境变量,建议把
# DEEPSEEK_API_KEY 等敏感值放 .env(KEY=value,一行一个),
# 这里用 $DEEPSEEK_API_KEY 引用即可。
# [providers.opencode-zen]
# type = "openai-compat"
# api_key = "sk-xxx"
# base_url = "https://opencode.ai/zen/v1"
# default_large_model_id = "deepseek-v4-flash-free"
#
# [providers.deepseek]
# type = "openai-compat"
# api_key = "$DEEPSEEK_API_KEY"
# base_url = "https://api.deepseek.com/v1"

# ========== 模型引用(可选)==========
# [models.large]
# model = "deepseek-v4-flash-free"
# provider = "opencode-zen"
# reasoning_effort = "high"
# max_tokens = 384000

# ========== MCP server(可多个)==========
# [mcp.filesystem]
# type = "stdio"
# command = "npx -y @modelcontextprotocol/server-filesystem"
# args = ["/tmp"]
#
# [mcp.some-http]
# type = "http"
# url = "http://127.0.0.1:3001/mcp"

# ========== LSP server(可多个)==========
# 配置后,agent 自动获得 diagnostics/definition/references/hover 工具。
# 语言标识按扩展名自动匹配(rust→.rs,typescript→.ts/.tsx,python→.py,go→.go...)。
# [lsp.rust]
# command = "rust-analyzer"
#
# [lsp.typescript]
# command = "typescript-language-server"
# args = ["--stdio"]
#
# [lsp.python]
# command = "pyright-langserver"
# args = ["--stdio"]

# ========== skills(每个 skill 一个目录含 SKILL.md)==========
# 默认扫描(项目级优先):项目 .combo/skills、项目 .agents/skills、combo 专属 ~/.config/combo/skills、通用 ~/.agents/skills
# skills_paths = ["~/.config/combo/skills"]
# disabled_skills = []

# ========== 兼容旧版单 provider 配置 ==========
# api_key = ""
# base_url = ""
# mcp_command = ""
# mcp_url = ""
"#;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, template)?;
    Ok(())
}

/// 打印配置文件路径与当前生效配置(供 `config path` 使用)。
pub fn print_path(path: &PathBuf) -> Result<()> {
    println!("配置文件:{}", path.display());
    let cfg = AppConfig::load_or_create(path)?;
    println!("---");
    println!("provider    = {:?}", cfg.provider);
    println!("model       = {:?}", cfg.model);
    println!("preamble    = {:?}", cfg.preamble);
    println!("tools       = {:?}", cfg.tools);
    println!("mcp_command = {:?}", cfg.mcp_command);
    println!("mcp_url     = {:?}", cfg.mcp_url);
    println!("api_key     = {:?}", cfg.api_key.map(|_| "***".to_string()));
    println!("base_url    = {:?}", cfg.base_url);
    println!(
        "providers   = {} 个",
        cfg.providers.keys().map(|k| k.as_str()).collect::<Vec<_>>().join(", ")
    );
    println!("mcp servers = {}", cfg.mcp.len());
    println!("lsp servers = {}", cfg.lsp.len());
    println!(
        "skills_paths = {:?}",
        if cfg.skills_paths.is_empty() {
            "(默认)".to_string()
        } else {
            cfg.skills_paths.join(", ")
        }
    );
    println!("disabled_skills = {:?}", cfg.disabled_skills);
    Ok(())
}

/// 合并后的最终配置(已套用全部默认值)。
#[derive(Debug, Clone)]
pub struct ResolvedConfig {
    pub provider: String,
    pub model: Option<String>,
    pub preamble: String,
    pub tools: bool,
    pub mcp_command: Option<String>,
    pub mcp_url: Option<String>,
    pub api_key: Option<String>,
    pub base_url: Option<String>,
    /// 内嵌 provider 定义。
    pub providers: BTreeMap<String, ProviderConfig>,
    /// 模型引用(large/small),已在 resolve 时用于默认 provider/model 回退。
    #[allow(dead_code)]
    pub models: ModelsConfig,
    pub mcp: BTreeMap<String, McpServerConfig>,
    pub lsp: BTreeMap<String, LspServerConfig>,
    pub skills_paths: Vec<String>,
    pub disabled_skills: Vec<String>,
    /// 推理强度(nothink / high / max);serve 运行时由前端切换写入。
    pub reasoning_effort: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn load_dotenv_sets_defaults_and_keeps_existing() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join(".env"),
            "# 注释行\nCOMBO_TEST_DOTENV_A = \"sk-test-123\"\nexport ZAI_KEY='zai-val'\nFOO=$COMBO_TEST_DOTENV_A-suffix\nBASE=\"$ZAI_KEY${ZAI_KEY}\"\n",
        )
        .unwrap();
        std::env::set_var("KEEP_ME", "original");

        load_dotenv(&dir.path().join("combo-cli.toml"));

        assert_eq!(std::env::var("COMBO_TEST_DOTENV_A").unwrap(), "sk-test-123");
        assert_eq!(std::env::var("ZAI_KEY").unwrap(), "zai-val");
        assert_eq!(std::env::var("FOO").unwrap(), "sk-test-123-suffix");
        assert_eq!(std::env::var("BASE").unwrap(), "zai-valzai-val");
        assert_eq!(std::env::var("KEEP_ME").unwrap(), "original");
        assert!(std::env::var_os("KEEP_ME").is_some(), "已有环境变量不被覆盖");

        // 清理,避免污染其它测试
        std::env::remove_var("COMBO_TEST_DOTENV_A");
        std::env::remove_var("ZAI_KEY");
        std::env::remove_var("FOO");
        std::env::remove_var("BASE");
    }

    #[test]
    fn load_dotenv_missing_file_generates_template() {
        let dir = tempfile::tempdir().unwrap();
        std::env::remove_var("RUST_LOG");
        let before = std::env::var_os("DEEPSEEK_API_KEY").is_some();
        load_dotenv(&dir.path().join("combo-cli.toml"));
        let env_path = dir.path().join(".env");
        assert!(env_path.exists(), "缺 .env 时应自动生成模板");
        let text = std::fs::read_to_string(&env_path).unwrap();
        assert!(text.contains("RUST_LOG=info"), "模板应启用 RUST_LOG=info");
        assert_eq!(std::env::var("RUST_LOG").unwrap(), "info");
        assert_eq!(
            std::env::var_os("DEEPSEEK_API_KEY").is_some(),
            before,
            "只应加载模板里的 RUST_LOG,不应改动其它变量"
        );
        std::env::remove_var("RUST_LOG");
    }

    #[test]
    fn load_dotenv_ignores_invalid_lines() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join(".env"),
            "NO_EQUALS\n1BAD=key\nGOOD_KEY=ok\n# 注释\n",
        )
        .unwrap();
        load_dotenv(&dir.path().join("combo-cli.toml"));
        assert!(std::env::var_os("NO_EQUALS").is_none());
        assert!(std::env::var_os("1BAD").is_none());
        assert_eq!(std::env::var("GOOD_KEY").unwrap(), "ok");
        std::env::remove_var("GOOD_KEY");
    }

    #[test]
    fn load_or_create_generates_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("sub").join("combo-cli.toml");
        let cfg = AppConfig::load_or_create(&path).unwrap();
        assert!(path.exists(), "配置文件应被自动生成");
        assert!(cfg.provider.is_none(), "默认配置为空,等待用户填写");
        // 再读一遍不报错
        let again = AppConfig::load_or_create(&path).unwrap();
        assert!(again.provider.is_none());
    }

    #[test]
    fn asr_model_config_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("combo-cli.toml");
        // 未设置时回落默认(中文)
        assert_eq!(AppConfig::default().asr.resolve_model(), crate::asr::AsrModel::SenseVoice);
        // 非法值同样回落默认
        let cfg: AppConfig = toml::from_str(r#"[asr]
model = "nope""#).unwrap();
        assert_eq!(cfg.asr.resolve_model(), crate::asr::AsrModel::SenseVoice);

        // 写入 → 重读生效
        set_asr_model(&path, "moonshine-en").unwrap();
        let cfg = AppConfig::load_or_create(&path).unwrap();
        assert_eq!(cfg.asr.resolve_model(), crate::asr::AsrModel::MoonshineEn);

        // 非法 id 拒绝写入
        assert!(set_asr_model(&path, "unknown").is_err());
    }

    #[test]
    fn tts_config_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("combo-cli.toml");
        // 未设置时默认关闭 + 默认模型(中文女声)
        assert_eq!(AppConfig::default().tts.resolve_enabled(), false);
        assert_eq!(AppConfig::default().tts.resolve_model(), crate::tts::TtsModel::PiperZhXiaoya);
        // 非法模型值同样回落默认
        let cfg: AppConfig = toml::from_str(r#"[tts]
model = "nope""#).unwrap();
        assert_eq!(cfg.tts.resolve_model(), crate::tts::TtsModel::PiperZhXiaoya);
        // 未设置/非法语速回落 1.0
        assert_eq!(AppConfig::default().tts.resolve_speed(), 1.0);
        let cfg: AppConfig = toml::from_str(r#"[tts]
speed = 9"#).unwrap();
        assert_eq!(cfg.tts.resolve_speed(), 1.0);
        let cfg: AppConfig = toml::from_str(r#"[tts]
speed = 1.4"#).unwrap();
        assert_eq!(cfg.tts.resolve_speed(), 1.4);

        // 写入 → 重读生效
        set_tts_enabled(&path, true).unwrap();
        set_tts_model(&path, "vits-zh-fanchen-c").unwrap();
        set_tts_speed(&path, 1.5).unwrap();
        let cfg = AppConfig::load_or_create(&path).unwrap();
        assert!(cfg.tts.resolve_enabled());
        assert_eq!(cfg.tts.resolve_model(), crate::tts::TtsModel::VitsZhFanchenC);
        assert_eq!(cfg.tts.resolve_speed(), 1.5);

        // 非法 id / 语速拒绝写入
        assert!(set_tts_model(&path, "unknown").is_err());
        assert!(set_tts_speed(&path, 0.1).is_err());
        assert!(set_tts_speed(&path, 3.0).is_err());
    }

    #[test]
    fn commit_model_config_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("combo-cli.toml");
        // 未设置时:开关关闭、无覆盖
        assert_eq!(get_commit_model(&path), (false, None, None));
        assert!(commit_model_override(&path).is_none());

        // 开启 + 指定模型 → 覆盖生效
        set_commit_model(&path, true, Some("deepseek"), Some("deepseek-chat")).unwrap();
        assert_eq!(
            get_commit_model(&path),
            (
                true,
                Some("deepseek".to_string()),
                Some("deepseek-chat".to_string())
            )
        );
        assert_eq!(
            commit_model_override(&path),
            Some(("deepseek".to_string(), Some("deepseek-chat".to_string())))
        );

        // model 留空 → 只覆盖 provider,模型由调用方回退默认大模型
        set_commit_model(&path, true, Some("deepseek"), None).unwrap();
        assert_eq!(
            commit_model_override(&path),
            Some(("deepseek".to_string(), None))
        );

        // 空串等价于清除
        set_commit_model(&path, true, Some("  "), Some("")).unwrap();
        assert_eq!(
            get_commit_model(&path),
            (true, None, None),
            "空串应被清除,provider 为空时覆盖整体失效"
        );
        assert!(commit_model_override(&path).is_none());

        // 关闭开关 → 即使配置了模型也不用
        set_commit_model(&path, true, Some("deepseek"), Some("deepseek-chat")).unwrap();
        set_commit_model(&path, false, Some("deepseek"), Some("deepseek-chat")).unwrap();
        assert!(commit_model_override(&path).is_none());
    }

    #[test]
    fn resolve_prefers_cli_over_file() {
        let cfg = AppConfig {
            provider: Some("ollama".into()),
            model: Some("llama3.1".into()),
            preamble: Some("配置文件里的提示词".into()),
            tools: Some(false),
            mcp_command: Some("npx mcp-server".into()),
            mcp_url: None,
            api_key: None,
            base_url: None,
            providers: BTreeMap::new(),
            models: ModelsConfig::default(),
            mcp: BTreeMap::new(),
            lsp: BTreeMap::new(),
            skills_paths: vec![],
            disabled_skills: vec![],
            commit_attribution: None,
            git: GitConfig::default(),
            asr: AsrConfig::default(),
            tts: TtsConfig::default(),
            agents: BTreeMap::new(),
        };
        let r = cfg.resolve(Some("openai"), None, None, None, None, Some("http://mcp:1"));
        assert_eq!(r.provider, "openai", "CLI 参数优先");
        assert_eq!(r.model.as_deref(), Some("llama3.1"), "未传时用配置文件");
        assert_eq!(r.preamble, "配置文件里的提示词");
        assert!(!r.tools);
        assert_eq!(r.mcp_command.as_deref(), Some("npx mcp-server"));
        assert_eq!(r.mcp_url.as_deref(), Some("http://mcp:1"));
    }

    #[test]
    fn resolve_falls_back_to_defaults() {
        let cfg = AppConfig::default();
        let r = cfg.resolve(None, None, None, None, None, None);
        assert_eq!(r.provider, "opencode");
        // 默认 provider 必须能被 find_provider 解析(内置列表包含 opencode),
        // 否则冷环境任何子命令都会报「未知提供商」
        let default_provider = r.provider.clone();
        assert!(
            crate::providers::find_provider(&default_provider, &r.providers).is_ok(),
            "默认 provider {default_provider} 应存在于内置列表"
        );
        assert!(r.model.is_none());
        assert_eq!(r.preamble, "你是 combo 内置的智能助手。");
        assert!(r.tools);
        assert!(r.mcp_command.is_none());
        assert!(r.mcp_url.is_none());
    }

    #[test]
    fn read_opencode_key_parses_auth_json() {
        // 用临时 OPENCODE_DATA_DIR 模拟 opencode 的 auth.json
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("auth.json"),
            r#"{"opencode":{"type":"api","key":"sk-test-zen-key"},"zai":{"type":"api","key":"zai-key"}}"#,
        )
        .unwrap();
        std::env::set_var("OPENCODE_DATA_DIR", dir.path());
        let key = read_opencode_key("opencode").unwrap().unwrap();
        assert_eq!(key, "sk-test-zen-key");
        assert_eq!(read_opencode_key("zai").unwrap().unwrap(), "zai-key");
        assert!(read_opencode_key("nonexistent").unwrap().is_none());
        std::env::remove_var("OPENCODE_DATA_DIR");
    }

    #[test]
    fn resolve_carries_api_key_and_base_url() {
        let cfg = AppConfig {
            api_key: Some("sk-abc".into()),
            base_url: Some("https://custom.example/v1".into()),
            ..Default::default()
        };
        let r = cfg.resolve(None, None, None, None, None, None);
        assert_eq!(r.api_key.as_deref(), Some("sk-abc"));
        assert_eq!(r.base_url.as_deref(), Some("https://custom.example/v1"));
    }

    #[test]
    fn save_provider_key_creates_and_updates() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("combo-cli.toml");

        // 首次保存
        save_provider_key(&path, "deepseek", "sk-test-123", Some("openai-compat"), Some("https://api.deepseek.com/v1")).unwrap();
        let cfg = AppConfig::load_or_create(&path).unwrap();
        assert_eq!(cfg.providers.get("deepseek").unwrap().api_key.as_deref(), Some("sk-test-123"));
        assert_eq!(cfg.providers.get("deepseek").unwrap().provider_type.as_deref(), Some("openai-compat"));

        // 更新同一个 provider 的 key
        save_provider_key(&path, "deepseek", "sk-new-key", None, None).unwrap();
        let cfg2 = AppConfig::load_or_create(&path).unwrap();
        assert_eq!(cfg2.providers.get("deepseek").unwrap().api_key.as_deref(), Some("sk-new-key"));
        // type 应保留
        assert_eq!(cfg2.providers.get("deepseek").unwrap().provider_type.as_deref(), Some("openai-compat"));
    }

    #[test]
    fn save_provider_key_empty_clears_key() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("combo-cli.toml");

        save_provider_key(&path, "deepseek", "sk-test-123", None, None).unwrap();
        // 清空 key:写入空串,解析后等价于未配置
        save_provider_key(&path, "deepseek", "", None, None).unwrap();
        let cfg = AppConfig::load_or_create(&path).unwrap();
        let pc = cfg.providers.get("deepseek").unwrap();
        assert_eq!(pc.api_key.as_deref(), Some(""));
        let info = crate::providers::ProviderInfo::from_config("deepseek", pc);
        assert_eq!(info.resolved_api_key(), None);
    }

    #[test]
    fn multi_key_add_activate_remove() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("combo-cli.toml");

        // 追加两个 key,首个自动激活
        add_provider_key(&path, "deepseek", "sk-key-1", None).unwrap();
        add_provider_key(&path, "deepseek", "sk-key-2", None).unwrap();
        let cfg = AppConfig::load_or_create(&path).unwrap();
        let pc = cfg.providers.get("deepseek").unwrap();
        let keys: Vec<&str> = pc.api_keys.iter().map(|k| k.key()).collect();
        assert_eq!(keys, vec!["sk-key-1", "sk-key-2"]);
        assert_eq!(pc.api_key.as_deref(), Some("sk-key-1"), "无激活 key 时首个 key 自动激活");

        // 重复添加不产生重复项
        add_provider_key(&path, "deepseek", "sk-key-2", None).unwrap();
        let cfg = AppConfig::load_or_create(&path).unwrap();
        assert_eq!(cfg.providers.get("deepseek").unwrap().api_keys.len(), 2);

        // 切换激活
        activate_provider_key(&path, "deepseek", 1).unwrap();
        let cfg = AppConfig::load_or_create(&path).unwrap();
        assert_eq!(cfg.providers.get("deepseek").unwrap().api_key.as_deref(), Some("sk-key-2"));

        // 删除激活的 key:自动激活剩余第一个
        remove_provider_key(&path, "deepseek", 1).unwrap();
        let cfg = AppConfig::load_or_create(&path).unwrap();
        let pc = cfg.providers.get("deepseek").unwrap();
        let keys: Vec<&str> = pc.api_keys.iter().map(|k| k.key()).collect();
        assert_eq!(keys, vec!["sk-key-1"]);
        assert_eq!(pc.api_key.as_deref(), Some("sk-key-1"));

        // 删除最后一个 key:激活被清空
        remove_provider_key(&path, "deepseek", 0).unwrap();
        let cfg = AppConfig::load_or_create(&path).unwrap();
        let pc = cfg.providers.get("deepseek").unwrap();
        assert!(pc.api_keys.is_empty());
        assert!(pc.api_key.is_none());

        // 越界下标报错
        assert!(activate_provider_key(&path, "deepseek", 0).is_err());
        assert!(remove_provider_key(&path, "deepseek", 5).is_err());
        // 空 key 报错
        assert!(add_provider_key(&path, "deepseek", "  ", None).is_err());
    }

    #[test]
    fn key_naming_and_rename() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("combo-cli.toml");

        // 添加时带名称
        add_provider_key(&path, "deepseek", "sk-work", Some("工作")).unwrap();
        add_provider_key(&path, "deepseek", "sk-test", Some("测试")).unwrap();
        add_provider_key(&path, "deepseek", "sk-extra", None).unwrap();
        let cfg = AppConfig::load_or_create(&path).unwrap();
        let pc = cfg.providers.get("deepseek").unwrap();
        assert_eq!(pc.api_keys[0].key(), "sk-work");
        assert_eq!(pc.api_keys[0].name(), Some("工作"));
        assert_eq!(pc.api_keys[1].name(), Some("测试"));
        assert_eq!(pc.api_keys[2].name(), None, "未命名 key 为 Plain,无名称");

        // 给已有 key 补名称(重复添加同一 key + 名称)
        add_provider_key(&path, "deepseek", "sk-extra", Some("备用")).unwrap();
        let cfg = AppConfig::load_or_create(&path).unwrap();
        let pc = cfg.providers.get("deepseek").unwrap();
        assert_eq!(pc.api_keys.len(), 3, "重复 key 不新增项");
        assert_eq!(pc.api_keys[2].name(), Some("备用"));

        // 重命名已有 key;清除名称还原为 Plain
        rename_provider_key(&path, "deepseek", 0, Some("主力")).unwrap();
        rename_provider_key(&path, "deepseek", 1, None).unwrap();
        let cfg = AppConfig::load_or_create(&path).unwrap();
        let pc = cfg.providers.get("deepseek").unwrap();
        assert_eq!(pc.api_keys[0].key(), "sk-work");
        assert_eq!(pc.api_keys[0].name(), Some("主力"));
        assert_eq!(pc.api_keys[1].name(), None, "清除名称后还原为纯字符串");

        // 越界改名报错
        assert!(rename_provider_key(&path, "deepseek", 9, Some("x")).is_err());

        // 序列化兼容:全部为 Plain 时写回纯字符串数组
        let out = toml::to_string(&cfg).unwrap();
        let re: AppConfig = toml::from_str(&out).unwrap();
        let keys: Vec<&str> = re.providers["deepseek"].api_keys.iter().map(|k| k.key()).collect();
        assert_eq!(keys, vec!["sk-work", "sk-test", "sk-extra"]);
        assert!(out.contains("sk-extra"));
    }

    #[test]
    fn save_provider_key_appends_to_list() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("combo-cli.toml");

        save_provider_key(&path, "deepseek", "sk-old", None, None).unwrap();
        // SettingsDialog「拉取模型」覆盖 key:新 key 追加进列表并激活
        save_provider_key(&path, "deepseek", "sk-new", None, None).unwrap();
        let cfg = AppConfig::load_or_create(&path).unwrap();
        let pc = cfg.providers.get("deepseek").unwrap();
        let keys: Vec<&str> = pc.api_keys.iter().map(|k| k.key()).collect();
        assert_eq!(keys, vec!["sk-old", "sk-new"]);
        assert_eq!(pc.api_key.as_deref(), Some("sk-new"));
    }

    #[test]
    fn custom_provider_add_and_remove() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("combo-cli.toml");

        // 新增:缺省类型 openai-compat;提供 key 时入列表并激活
        add_provider(
            &path,
            "my-relay",
            Some("中转"),
            None,
            Some(" https://relay.example.com/v1 "),
            Some("sk-1"),
            None,
        )
        .unwrap();
        let cfg = AppConfig::load_or_create(&path).unwrap();
        let pc = cfg.providers.get("my-relay").unwrap();
        assert_eq!(pc.name.as_deref(), Some("中转"));
        assert_eq!(pc.provider_type.as_deref(), Some("openai-compat"));
        assert_eq!(pc.base_url.as_deref(), Some("https://relay.example.com/v1"), "前后空白应被 trim");
        assert_eq!(pc.api_key.as_deref(), Some("sk-1"));
        assert_eq!(pc.api_keys.len(), 1);

        // 重复 id 报错
        assert!(add_provider(&path, "my-relay", None, None, None, None, None).is_err());
        // 非法 id / 空 id 报错
        assert!(add_provider(&path, "bad id!", None, None, None, None, None).is_err());
        assert!(add_provider(&path, "  ", None, None, None, None, None).is_err());

        // 无 key / 无名称也能创建
        add_provider(&path, "bare", None, Some("anthropic"), None, None, Some("claude-x")).unwrap();
        let cfg = AppConfig::load_or_create(&path).unwrap();
        let bare = cfg.providers.get("bare").unwrap();
        assert_eq!(bare.provider_type.as_deref(), Some("anthropic"));
        assert!(bare.api_key.is_none());
        assert_eq!(bare.default_large_model_id.as_deref(), Some("claude-x"));

        // 删除后配置条目消失,再删报错
        remove_provider(&path, "my-relay").unwrap();
        let cfg = AppConfig::load_or_create(&path).unwrap();
        assert!(!cfg.providers.contains_key("my-relay"));
        assert!(remove_provider(&path, "my-relay").is_err());
        // 未定义过的 id 报错
        assert!(remove_provider(&path, "never-exists").is_err());
    }

    #[test]
    fn custom_provider_from_config_carries_name() {
        // from_config 透传配置里的显示名;未设置时为 None(由序列化层回落 id)
        let pc = ProviderConfig {
            name: Some("中转".into()),
            ..Default::default()
        };
        let info = crate::providers::ProviderInfo::from_config("my-relay", &pc);
        assert_eq!(info.name.as_deref(), Some("中转"));

        let info2 =
            crate::providers::ProviderInfo::from_config("my-relay", &ProviderConfig::default());
        assert_eq!(info2.name, None);
    }

    #[test]
    fn model_context_window_set_clear_and_applies_to_find_provider() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("combo-cli.toml");

        // 设置覆盖:写入 [providers.deepseek.context_windows]
        set_model_context_window(&path, "deepseek", "deepseek-chat", Some(262_144)).unwrap();
        let cfg = AppConfig::load_or_create(&path).unwrap();
        assert_eq!(
            cfg.providers
                .get("deepseek")
                .unwrap()
                .context_windows
                .get("deepseek-chat"),
            Some(&262_144)
        );

        // find_provider 解析后模型的 context_window 被覆盖(压缩预算/展示共用)
        let info = crate::providers::find_provider("deepseek", &cfg.providers).unwrap();
        assert_eq!(
            info.find_model("deepseek-chat").unwrap().context_window,
            Some(262_144)
        );

        // 清除覆盖:恢复默认(覆盖表清空)
        set_model_context_window(&path, "deepseek", "deepseek-chat", None).unwrap();
        let cfg2 = AppConfig::load_or_create(&path).unwrap();
        assert!(
            cfg2
                .providers
                .get("deepseek")
                .unwrap()
                .context_windows
                .is_empty()
        );

        // 非法值被拒绝
        assert!(set_model_context_window(&path, "deepseek", "m", Some(0)).is_err());
        assert!(set_model_context_window(&path, "deepseek", "  ", None).is_err());
    }

    #[test]
    fn mcp_server_upsert_and_remove() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("combo-cli.toml");

        // stdio:写 command,args 置空
        upsert_mcp_server(
            &path,
            "filesystem",
            "stdio",
            Some(" npx -y @modelcontextprotocol/server-filesystem /tmp "),
            None,
        )
        .unwrap();
        let cfg = AppConfig::load_or_create(&path).unwrap();
        let srv = cfg.mcp.get("filesystem").unwrap();
        assert_eq!(srv.transport, "stdio");
        assert_eq!(
            srv.command.as_deref(),
            Some("npx -y @modelcontextprotocol/server-filesystem /tmp"),
            "command 前后空白应被 trim"
        );
        assert!(srv.args.is_none());

        // http:写 url
        upsert_mcp_server(&path, "github", "http", None, Some(" http://127.0.0.1:3001/mcp "))
            .unwrap();
        let cfg = AppConfig::load_or_create(&path).unwrap();
        assert_eq!(cfg.mcp.get("github").unwrap().url.as_deref(), Some("http://127.0.0.1:3001/mcp"));

        // 覆盖更新
        upsert_mcp_server(&path, "filesystem", "stdio", Some("npx other-server"), None).unwrap();
        let cfg = AppConfig::load_or_create(&path).unwrap();
        assert_eq!(cfg.mcp.get("filesystem").unwrap().command.as_deref(), Some("npx other-server"));

        // 校验失败:空名称 / 非法字符 / 缺 command / 缺 url / 非法 transport
        assert!(upsert_mcp_server(&path, "  ", "stdio", Some("x"), None).is_err());
        assert!(upsert_mcp_server(&path, "bad name!", "stdio", Some("x"), None).is_err());
        assert!(upsert_mcp_server(&path, "no-cmd", "stdio", None, None).is_err());
        assert!(upsert_mcp_server(&path, "no-url", "http", None, None).is_err());
        assert!(upsert_mcp_server(&path, "bad-type", "sse", Some("x"), None).is_err());

        // 删除
        remove_mcp_server(&path, "filesystem").unwrap();
        let cfg = AppConfig::load_or_create(&path).unwrap();
        assert!(!cfg.mcp.contains_key("filesystem"));
        assert!(remove_mcp_server(&path, "filesystem").is_err());
        assert!(remove_mcp_server(&path, "never-exists").is_err());
    }
}
