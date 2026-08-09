//! provider 结构与 crush providers.json 格式保持一致。
//!
//! crush 的 `~/.local/share/crush/providers.json` 是 JSON 数组,每个元素:
//! `{ id, name, api_key, api_endpoint, type, default_large_model_id,
//!    default_small_model_id, models: [{ id, name, ... }] }`。
//! 本模块定义兼容的 `ProviderInfo`/`ModelInfo`,并保留内置 provider 快捷方式。

use anyhow::Result;
use serde::{Deserialize, Serialize};

/// 单个模型(与 crush 的 model 条目兼容;除 id 外均可选)。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ModelInfo {
    pub id: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub cost_per_1m_in: Option<f64>,
    #[serde(default)]
    pub cost_per_1m_out: Option<f64>,
    #[serde(default)]
    pub context_window: Option<i64>,
    #[serde(default)]
    pub default_max_tokens: Option<i64>,
    #[serde(default)]
    pub can_reason: Option<bool>,
    #[serde(default)]
    pub supports_attachments: Option<bool>,
}

/// 一个 provider 条目,字段名与 crush providers.json 完全一致。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderInfo {
    pub id: String,
    #[serde(default)]
    pub name: Option<String>,
    /// 可为字面 key,或 `$ENV_VAR` 形式(运行时展开环境变量)。
    #[serde(default)]
    pub api_key: Option<String>,
    /// 可为字面 URL,或 `$ENV_VAR` 形式。
    #[serde(default)]
    pub api_endpoint: Option<String>,
    /// provider 类型:openai / openai-compat / anthropic / google / azure / ...
    #[serde(rename = "type", default)]
    pub provider_type: Option<String>,
    #[serde(default)]
    pub default_large_model_id: Option<String>,
    #[serde(default)]
    pub default_small_model_id: Option<String>,
    #[serde(default)]
    pub models: Vec<ModelInfo>,
}

impl ProviderInfo {
    /// 解析 api_key:`$VAR` 读环境变量,否则原样返回。
    pub fn resolved_api_key(&self) -> Option<String> {
        self.api_key.as_deref().and_then(expand_env)
    }

    /// 解析 api_endpoint:`$VAR` 读环境变量,否则原样返回。
    pub fn resolved_endpoint(&self) -> Option<String> {
        self.api_endpoint.as_deref().and_then(expand_env)
    }

    /// 默认大模型 id。
    pub fn default_model(&self) -> String {
        self.default_large_model_id
            .clone()
            .or_else(|| self.models.first().map(|m| m.id.clone()))
            .unwrap_or_else(|| "gpt-4o".into())
    }

    /// 按 id 查模型。
    #[allow(dead_code)]
    pub fn find_model(&self, id: &str) -> Option<&ModelInfo> {
        self.models.iter().find(|m| m.id == id)
    }
}

/// `$VAR` 展开;无 `$` 前缀或变量未定义时返回 None。
fn expand_env(s: &str) -> Option<String> {
    if let Some(var) = s.strip_prefix('$') {
        std::env::var(var).ok()
    } else if s.is_empty() {
        None
    } else {
        Some(s.to_string())
    }
}

/// 内置 provider 快捷方式(crush 格式的静态定义)。
pub fn builtin_providers() -> Vec<ProviderInfo> {
    vec![
        ProviderInfo {
            id: "openai".into(),
            name: Some("OpenAI".into()),
            api_key: Some("$OPENAI_API_KEY".into()),
            api_endpoint: Some("$OPENAI_API_ENDPOINT".into()),
            provider_type: Some("openai".into()),
            default_large_model_id: Some("gpt-4o".into()),
            default_small_model_id: Some("gpt-4o-mini".into()),
            models: vec![
                ModelInfo {
                    id: "gpt-4o".into(),
                    name: Some("GPT-4o".into()),
                    context_window: Some(128000),
                    ..Default::default()
                },
                ModelInfo {
                    id: "gpt-4o-mini".into(),
                    name: Some("GPT-4o mini".into()),
                    context_window: Some(128000),
                    ..Default::default()
                },
            ],
        },
        ProviderInfo {
            id: "anthropic".into(),
            name: Some("Anthropic".into()),
            api_key: Some("$ANTHROPIC_API_KEY".into()),
            api_endpoint: Some("$ANTHROPIC_API_ENDPOINT".into()),
            provider_type: Some("anthropic".into()),
            default_large_model_id: Some("claude-sonnet-4-5".into()),
            default_small_model_id: Some("claude-haiku-4-5-20251001".into()),
            models: vec![ModelInfo {
                id: "claude-sonnet-4-5".into(),
                name: Some("Claude Sonnet 4.5".into()),
                context_window: Some(200000),
                ..Default::default()
            }],
        },
        ProviderInfo {
            id: "gemini".into(),
            name: Some("Google Gemini".into()),
            api_key: Some("$GEMINI_API_KEY".into()),
            api_endpoint: Some("$GEMINI_API_ENDPOINT".into()),
            provider_type: Some("google".into()),
            default_large_model_id: Some("gemini-2.5-flash".into()),
            default_small_model_id: Some("gemini-2.5-flash".into()),
            models: vec![ModelInfo {
                id: "gemini-2.5-flash".into(),
                name: Some("Gemini 2.5 Flash".into()),
                context_window: Some(1048576),
                ..Default::default()
            }],
        },
        ProviderInfo {
            id: "ollama".into(),
            name: Some("Ollama".into()),
            api_key: None,
            api_endpoint: Some("http://localhost:11434/v1".into()),
            provider_type: Some("openai-compat".into()),
            default_large_model_id: Some("llama3.1".into()),
            default_small_model_id: Some("llama3.1".into()),
            models: vec![ModelInfo {
                id: "llama3.1".into(),
                name: Some("Llama 3.1".into()),
                context_window: Some(131072),
                ..Default::default()
            }],
        },
        ProviderInfo {
            id: "deepseek".into(),
            name: Some("DeepSeek".into()),
            api_key: Some("$DEEPSEEK_API_KEY".into()),
            api_endpoint: Some("https://api.deepseek.com/v1".into()),
            provider_type: Some("openai-compat".into()),
            default_large_model_id: Some("deepseek-chat".into()),
            default_small_model_id: Some("deepseek-chat".into()),
            models: vec![ModelInfo {
                id: "deepseek-chat".into(),
                name: Some("DeepSeek Chat".into()),
                context_window: Some(131072),
                ..Default::default()
            }],
        },
        ProviderInfo {
            id: "opencode".into(),
            name: Some("OpenCode Zen".into()),
            api_key: Some("$OPENCODE_API_KEY".into()),
            api_endpoint: Some("https://opencode.ai/zen/v1".into()),
            provider_type: Some("openai-compat".into()),
            default_large_model_id: Some("deepseek-v4-flash-free".into()),
            default_small_model_id: Some("deepseek-v4-flash-free".into()),
            models: vec![
                ModelInfo {
                    id: "deepseek-v4-flash-free".into(),
                    name: Some("DeepSeek V4 Flash Free".into()),
                    context_window: Some(1000000),
                    ..Default::default()
                },
                ModelInfo {
                    id: "big-pickle".into(),
                    name: Some("Big Pickle".into()),
                    context_window: Some(200000),
                    ..Default::default()
                },
            ],
        },
    ]
}

/// 从 crush 的 providers.json 读取 provider 列表(路径不存在返回空)。
pub fn load_crush_providers() -> Result<Vec<ProviderInfo>> {
    let path = crush_providers_path();
    if !path.exists() {
        return Ok(Vec::new());
    }
    let text = std::fs::read_to_string(&path)?;
    let provs: Vec<ProviderInfo> = serde_json::from_str(&text)
        .map_err(|e| anyhow::anyhow!("解析 {} 失败: {e}", path.display()))?;
    Ok(provs)
}

/// crush providers.json 路径(与 opencode 一致的 data 目录规则)。
pub fn crush_providers_path() -> std::path::PathBuf {
    if let Ok(dir) = std::env::var("CRUSH_DATA_DIR") {
        return std::path::PathBuf::from(dir).join("providers.json");
    }
    let base = std::env::var("XDG_DATA_HOME")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| {
            let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
            std::path::PathBuf::from(home).join(".local/share")
        });
    base.join("crush").join("providers.json")
}

/// 按 id 查找 provider:先查自定义列表,再查 crush providers.json,
/// 最后回退内置定义。
pub fn find_provider(id: &str, custom: &[ProviderInfo]) -> Result<ProviderInfo> {
    if let Some(p) = custom.iter().find(|p| p.id == id) {
        return Ok(p.clone());
    }
    let crush = load_crush_providers()?;
    if let Some(p) = crush.iter().find(|p| p.id == id) {
        return Ok(p.clone());
    }
    builtin_providers()
        .into_iter()
        .find(|p| p.id == id)
        .ok_or_else(|| anyhow::anyhow!("未知提供商 `{id}`(可配置 providers 或运行 `combo-cli config import`)"))
}

/// 内置 provider 的 id 列表(供提示)。
#[allow(dead_code)]
pub fn builtin_ids() -> Vec<String> {
    builtin_providers()
        .into_iter()
        .map(|p| p.id)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expand_env_handles_dollar_and_literal() {
        assert_eq!(expand_env("$NOPE_VAR_XYZ"), None);
        assert_eq!(expand_env("https://example.com/v1"), Some("https://example.com/v1".into()));
        assert_eq!(expand_env(""), None);
    }

    #[test]
    fn parse_crush_provider_json() {
        let json = r#"[
          {
            "name": "OpenCode Zen",
            "id": "opencode-zen",
            "api_key": "$OPENCODE_API_KEY",
            "api_endpoint": "https://opencode.ai/zen/v1",
            "type": "openai-compat",
            "default_large_model_id": "deepseek-v4-flash-free",
            "default_small_model_id": "deepseek-v4-flash-free",
            "models": [
              {"id": "big-pickle", "name": "Big Pickle", "context_window": 200000}
            ]
          }
        ]"#;
        let provs: Vec<ProviderInfo> = serde_json::from_str(json).unwrap();
        assert_eq!(provs.len(), 1);
        assert_eq!(provs[0].id, "opencode-zen");
        assert_eq!(provs[0].provider_type.as_deref(), Some("openai-compat"));
        assert_eq!(provs[0].resolved_endpoint().unwrap(), "https://opencode.ai/zen/v1");
        assert_eq!(provs[0].default_model(), "deepseek-v4-flash-free");
        assert!(provs[0].find_model("big-pickle").is_some());
    }

    #[test]
    fn find_provider_falls_back_to_builtin() {
        let p = find_provider("opencode", &[]).unwrap();
        assert_eq!(p.default_model(), "deepseek-v4-flash-free");
        assert_eq!(p.resolved_endpoint().unwrap(), "https://opencode.ai/zen/v1");
    }
}
