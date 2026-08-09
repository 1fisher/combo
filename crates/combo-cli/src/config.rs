//! 配置文件:首次运行自动在用户目录生成,CLI 参数 > 配置文件 > 默认值。
//!
//! 路径遵循 XDG:`$XDG_CONFIG_HOME/combo/combo-cli.toml`(无 XDG 时
//! `~/.config/combo/combo-cli.toml`),可用 `COMBO_CONFIG_DIR` 覆盖目录。

use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// 配置文件路径。优先级:`COMBO_CONFIG_DIR` > `XDG_CONFIG_HOME` > `~/.config`。
pub fn default_config_path() -> PathBuf {
    if let Ok(dir) = std::env::var("COMBO_CONFIG_DIR") {
        return PathBuf::from(dir).join("combo-cli.toml");
    }
    let base = std::env::var("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
            PathBuf::from(home).join(".config")
        });
    base.join("combo").join("combo-cli.toml")
}

/// 配置文件内容。所有字段可选:未设置的项回退到 CLI 参数或默认值。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct AppConfig {
    /// 默认提供商(openai/anthropic/gemini/ollama/deepseek/opencode)
    pub provider: Option<String>,
    /// 默认模型名
    pub model: Option<String>,
    /// 系统提示词
    pub preamble: Option<String>,
    /// 是否启用内置工具
    pub tools: Option<bool>,
    /// MCP server 命令(stdio)
    pub mcp_command: Option<String>,
    /// MCP server URL(streamable HTTP)
    pub mcp_url: Option<String>,
    /// API key(用于 opencode 等无默认环境变量的提供商)
    pub api_key: Option<String>,
    /// 自定义 API base URL(默认按提供商取,如 opencode 用 api.opencode.ai/v1)
    pub base_url: Option<String>,
    /// 自定义 provider 定义(与 crush providers.json 同格式的数组)。
    #[serde(default)]
    pub providers: Option<Vec<crate::providers::ProviderInfo>>,
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
        ResolvedConfig {
            provider: cli_provider
                .or(self.provider.as_deref())
                .unwrap_or("openai")
                .to_string(),
            model: cli_model.or(self.model.as_deref()).map(String::from),
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
            providers: self.providers.clone().unwrap_or_default(),
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

/// 写入默认配置文件模板。`overwrite=false` 时若文件已存在则不写。
pub fn write_default(path: &PathBuf, overwrite: bool) -> Result<()> {
    if path.exists() && !overwrite {
        return Ok(());
    }
    let template = r#"# combo-cli 配置文件(自动生成)
# 优先级:命令行参数 > 本文件 > 内置默认值

# 默认提供商:openai / anthropic / gemini / ollama / deepseek
# provider = "openai"

# 默认模型名(留空则按提供商取默认)
# model = "gpt-4o"

# 系统提示词
# preamble = "你是 combo 内置的智能助手。"

# 是否启用内置工具(当前时间/日期),默认 true
# tools = true

# MCP server 命令(stdio),如:
# mcp_command = "npx -y @modelcontextprotocol/server-filesystem /tmp"

# MCP server URL(streamable HTTP),如:
# mcp_url = "http://127.0.0.1:3001/mcp"

# API key(可选):用于 opencode 等提供商;留空时 opencode 自动读取
# ~/.local/share/opencode/auth.json 中的 opencode zen key
# api_key = ""

# 自定义 API base URL(可选):默认按提供商取
# base_url = ""

# 自定义 provider 定义(与 crush providers.json 同格式,可选):
# 未在此定义时,combo-cli 会自动读取 crush 的
# ~/.local/share/crush/providers.json 与内置定义
# providers = [
#   { id = "opencode-zen", name = "OpenCode Zen", api_key = "$OPENCODE_API_KEY",
#     api_endpoint = "https://opencode.ai/zen/v1", type = "openai-compat",
#     default_large_model_id = "deepseek-v4-flash-free",
#     models = [ { id = "deepseek-v4-flash-free" } ] },
# ]
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
    /// 自定义 provider 定义(crush 同格式)。
    pub providers: Vec<crate::providers::ProviderInfo>,
}

#[cfg(test)]
mod tests {
    use super::*;

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
            providers: None,
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
}
