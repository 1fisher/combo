//! 配置文件:首次运行自动在用户目录生成,CLI 参数 > 配置文件 > 默认值。
//!
//! 默认路径固定为 `~/.config/combo/combo-cli.toml`,可用 `COMBO_CONFIG_DIR` 覆盖目录。

use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// 内嵌 provider 定义。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct ProviderConfig {
    /// provider 类型:openai / openai-compat / anthropic / google / azure ...
    #[serde(rename = "type")]
    pub provider_type: Option<String>,
    /// 明文 key 或 `$ENV_VAR`。
    pub api_key: Option<String>,
    /// API endpoint。
    pub base_url: Option<String>,
    /// 默认大模型 id。
    pub default_large_model_id: Option<String>,
    /// 默认小模型 id。
    pub default_small_model_id: Option<String>,
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
    if let Ok(dir) = std::env::var("COMBO_CONFIG_DIR") {
        return PathBuf::from(dir).join("combo-cli.toml");
    }
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
    PathBuf::from(home).join(".config").join("combo").join("combo-cli.toml")
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
    /// 默认提供商 id(如 openai / anthropic / deepseek / opencode-zen)
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
        // 默认 provider 也参考 models.large(若配置了 provider 引用)
        let provider = cli_provider
            .or(self.provider.as_deref())
            .or_else(|| self.models.large.as_ref().and_then(|m| m.provider.as_deref()))
            .unwrap_or("openai")
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

/// 把 provider 的 API key 保存到配置文件。
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
    let mut cfg = if path.exists() {
        let text = std::fs::read_to_string(path)?;
        toml::from_str::<AppConfig>(&text)
            .map_err(|e| anyhow::anyhow!("解析配置文件 {} 失败: {e}", path.display()))?
    } else {
        write_default(path, false)?;
        AppConfig::default()
    };

    let entry = cfg
        .providers
        .entry(provider_id.to_string())
        .or_insert_with(ProviderConfig::default);
    entry.api_key = Some(api_key.to_string());
    if let Some(pt) = provider_type {
        entry.provider_type = Some(pt.to_string());
    }
    if let Some(url) = base_url {
        if !url.is_empty() {
            entry.base_url = Some(url.to_string());
        }
    }

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let out = toml::to_string_pretty(&cfg)
        .map_err(|e| anyhow::anyhow!("序列化配置失败: {e}"))?;
    std::fs::write(path, out)?;
    Ok(())
}

/// 写入默认配置文件模板。`overwrite=false` 时若文件已存在则不写。
pub fn write_default(path: &PathBuf, overwrite: bool) -> Result<()> {
    if path.exists() && !overwrite {
        return Ok(());
    }
    let template = r#"# combo-cli 配置文件(自动生成)
# 优先级:命令行参数 > 本文件 > 内置默认值

# 默认提供商 id(openai / anthropic / deepseek / opencode-zen / ...)
# provider = "openai"

# 默认模型名(留空则按提供商取默认,或参考 [models])
# model = "gpt-4o"

# 系统提示词
# preamble = "你是 combo 内置的智能助手。"

# 是否启用内置工具(当前时间/日期),默认 true
# tools = true

# ========== 多 API key 配置 ==========
# 每个 provider 一个表,key = provider id;api_key 可为明文或 $ENV_VAR。
# 未在此定义的 provider 会依次回退到 combo providers.json
# (~/.local/share/combo/providers.json)与内置定义。
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
        assert_eq!(r.provider, "openai");
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
}
