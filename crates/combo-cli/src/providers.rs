//! provider 结构为 JSON 数组格式(每个元素含 id/name/api_key 等)。
//!
//! combo 的 `~/.local/share/combo/providers.json` 是 JSON 数组,每个元素:
//! `{ id, name, api_key, api_endpoint, type, default_large_model_id,
//!    default_small_model_id, models: [{ id, name, ... }] }`。
//! 本模块定义兼容的 `ProviderInfo`/`ModelInfo`,并保留内置 provider 快捷方式。

use anyhow::Result;
use serde::{Deserialize, Serialize};

/// 单个模型条目(除 id 外均可选)。
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

/// 一个 provider 条目(JSON 数组元素格式)。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderInfo {
    pub id: String,
    #[serde(default)]
    pub name: Option<String>,
    /// 当前激活的 key:可为字面 key,或 `$ENV_VAR` 形式(运行时展开环境变量)。
    #[serde(default)]
    pub api_key: Option<String>,
    /// 该 provider 已保存的全部 key 列表(按保存顺序);激活的 key 与
    /// `api_key` 一致。仅配置文件持久化,providers.json / 内置为空。
    /// 元素可为纯字符串或带 name 的对象(见 `crate::config::ApiKeyEntry`)。
    #[serde(default)]
    pub api_keys: Vec<crate::config::ApiKeyEntry>,
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
    pub fn find_model(&self, id: &str) -> Option<&ModelInfo> {
        self.models.iter().find(|m| m.id == id)
    }
}

/// `$VAR` 展开;无 `$` 前缀或变量未定义时返回 None。
pub(crate) fn expand_env(s: &str) -> Option<String> {
    if let Some(var) = s.strip_prefix('$') {
        std::env::var(var).ok()
    } else if s.is_empty() {
        None
    } else {
        Some(s.to_string())
    }
}

/// 内置 provider 快捷方式(静态定义)。
pub fn builtin_providers() -> Vec<ProviderInfo> {
    vec![
        ProviderInfo {
            id: "opencode".into(),
            name: Some("OpenCode Zen".into()),
            api_key: Some("$OPENCODE_API_KEY".into()),
            api_keys: vec![],
            api_endpoint: Some("https://opencode.ai/zen/v1".into()),
            provider_type: Some("openai-compat".into()),
            default_large_model_id: Some("deepseek-v4-flash-free".into()),
            default_small_model_id: Some("deepseek-v4-flash-free".into()),
            models: vec![
                ModelInfo {
                    id: "deepseek-v4-flash-free".into(),
                    name: Some("DeepSeek V4 Flash Free".into()),
                    context_window: Some(1000000),
                    cost_per_1m_in: Some(0.0),
                    cost_per_1m_out: Some(0.0),
                    ..Default::default()
                },
                ModelInfo {
                    id: "big-pickle".into(),
                    name: Some("Big Pickle".into()),
                    context_window: Some(200000),
                    cost_per_1m_in: Some(0.0),
                    cost_per_1m_out: Some(0.0),
                    ..Default::default()
                },
            ],
        },
        ProviderInfo {
            id: "openrouter".into(),
            name: Some("OpenRouter".into()),
            api_key: Some("$OPENROUTER_API_KEY".into()),
            api_keys: vec![],
            api_endpoint: Some("https://openrouter.ai/api/v1".into()),
            provider_type: Some("openai-compat".into()),
            default_large_model_id: Some("anthropic/claude-sonnet-4".into()),
            default_small_model_id: Some("anthropic/claude-3.5-haiku".into()),
            models: vec![],
        },
        ProviderInfo {
            id: "zhipu".into(),
            name: Some("智谱 Coding".into()),
            api_key: Some("$ZHIPU_API_KEY".into()),
            api_keys: vec![],
            api_endpoint: Some("https://open.bigmodel.cn/api/coding/paas/v4".into()),
            provider_type: Some("openai-compat".into()),
            default_large_model_id: Some("glm-4.6".into()),
            default_small_model_id: Some("glm-4.5-flash".into()),
            models: vec![
                ModelInfo {
                    id: "glm-4.6".into(),
                    name: Some("GLM-4.6".into()),
                    context_window: Some(128000),
                    cost_per_1m_in: Some(0.6),
                    cost_per_1m_out: Some(2.2),
                    ..Default::default()
                },
                ModelInfo {
                    id: "glm-4.5".into(),
                    name: Some("GLM-4.5".into()),
                    context_window: Some(128000),
                    cost_per_1m_in: Some(0.5),
                    cost_per_1m_out: Some(2.0),
                    ..Default::default()
                },
                ModelInfo {
                    id: "glm-4.5-flash".into(),
                    name: Some("GLM-4.5 Flash".into()),
                    context_window: Some(128000),
                    cost_per_1m_in: Some(0.1),
                    cost_per_1m_out: Some(0.4),
                    ..Default::default()
                },
            ],
        },
        ProviderInfo {
            id: "deepseek".into(),
            name: Some("DeepSeek".into()),
            api_key: Some("$DEEPSEEK_API_KEY".into()),
            api_keys: vec![],
            api_endpoint: Some("https://api.deepseek.com/v1".into()),
            provider_type: Some("openai-compat".into()),
            default_large_model_id: Some("deepseek-chat".into()),
            default_small_model_id: Some("deepseek-chat".into()),
            models: vec![
                ModelInfo {
                    id: "deepseek-v4-flash".into(),
                    name: Some("DeepSeek V4 Flash".into()),
                    context_window: Some(262144),
                    cost_per_1m_in: Some(0.27),
                    cost_per_1m_out: Some(1.10),
                    ..Default::default()
                },
                ModelInfo {
                    id: "deepseek-chat".into(),
                    name: Some("DeepSeek Chat".into()),
                    context_window: Some(131072),
                    cost_per_1m_in: Some(0.27),
                    cost_per_1m_out: Some(1.10),
                    ..Default::default()
                },
            ],
        },
        // ---- 以下 provider 暂未启用,后续需要时取消注释 ----
        // ProviderInfo {
        //     id: "openai".into(),
        //     name: Some("OpenAI".into()),
        //     api_key: Some("$OPENAI_API_KEY".into()),
        //     api_endpoint: Some("$OPENAI_API_ENDPOINT".into()),
        //     provider_type: Some("openai".into()),
        //     default_large_model_id: Some("gpt-4o".into()),
        //     default_small_model_id: Some("gpt-4o-mini".into()),
        //     models: vec![
        //         ModelInfo {
        //             id: "gpt-4o".into(),
        //             name: Some("GPT-4o".into()),
        //             context_window: Some(128000),
        //             ..Default::default()
        //         },
        //         ModelInfo {
        //             id: "gpt-4o-mini".into(),
        //             name: Some("GPT-4o mini".into()),
        //             context_window: Some(128000),
        //             ..Default::default()
        //         },
        //     ],
        // },
        // ProviderInfo {
        //     id: "anthropic".into(),
        //     name: Some("Anthropic".into()),
        //     api_key: Some("$ANTHROPIC_API_KEY".into()),
        //     api_endpoint: Some("$ANTHROPIC_API_ENDPOINT".into()),
        //     provider_type: Some("anthropic".into()),
        //     default_large_model_id: Some("claude-sonnet-4-5".into()),
        //     default_small_model_id: Some("claude-haiku-4-5-20251001".into()),
        //     models: vec![ModelInfo {
        //         id: "claude-sonnet-4-5".into(),
        //         name: Some("Claude Sonnet 4.5".into()),
        //         context_window: Some(200000),
        //         ..Default::default()
        //     }],
        // },
        // ProviderInfo {
        //     id: "gemini".into(),
        //     name: Some("Google Gemini".into()),
        //     api_key: Some("$GEMINI_API_KEY".into()),
        //     api_endpoint: Some("$GEMINI_API_ENDPOINT".into()),
        //     provider_type: Some("google".into()),
        //     default_large_model_id: Some("gemini-2.5-flash".into()),
        //     default_small_model_id: Some("gemini-2.5-flash".into()),
        //     models: vec![ModelInfo {
        //         id: "gemini-2.5-flash".into(),
        //         name: Some("Gemini 2.5 Flash".into()),
        //         context_window: Some(1048576),
        //         ..Default::default()
        //     }],
        // },
        // ProviderInfo {
        //     id: "ollama".into(),
        //     name: Some("Ollama".into()),
        //     api_key: None,
        //     api_endpoint: Some("http://localhost:11434/v1".into()),
        //     provider_type: Some("openai-compat".into()),
        //     default_large_model_id: Some("llama3.1".into()),
        //     default_small_model_id: Some("llama3.1".into()),
        //     models: vec![ModelInfo {
        //         id: "llama3.1".into(),
        //         name: Some("Llama 3.1".into()),
        //         context_window: Some(131072),
        //         ..Default::default()
        //     }],
        // },
    ]
}

/// 查找指定 provider+model 的定价(USD / 1M tokens)。
/// 查找顺序:provider 的 models 列表 → 内置 providers → 返回 (0, 0)。
pub fn get_model_pricing(provider: &ProviderInfo, model_id: &str) -> (f64, f64) {
    if let Some(m) = provider.models.iter().find(|m| m.id == model_id) {
        return (
            m.cost_per_1m_in.unwrap_or(0.0),
            m.cost_per_1m_out.unwrap_or(0.0),
        );
    }
    for p in builtin_providers() {
        if p.id == provider.id {
            if let Some(m) = p.models.iter().find(|m| m.id == model_id) {
                return (
                    m.cost_per_1m_in.unwrap_or(0.0),
                    m.cost_per_1m_out.unwrap_or(0.0),
                );
            }
        }
    }
    (0.0, 0.0)
}

/// 从 combo 的 providers.json 读取 provider 列表(路径不存在返回空)。
pub fn load_combo_providers() -> Result<Vec<ProviderInfo>> {
    let path = combo_providers_path();
    if !path.exists() {
        return Ok(Vec::new());
    }
    let text = std::fs::read_to_string(&path)?;
    let provs: Vec<ProviderInfo> = serde_json::from_str(&text)
        .map_err(|e| anyhow::anyhow!("解析 {} 失败: {e}", path.display()))?;
    Ok(provs)
}

/// combo providers.json 路径(与 opencode 一致的 data 目录规则)。
pub fn combo_providers_path() -> std::path::PathBuf {
    if let Ok(dir) = std::env::var("COMBO_DATA_DIR") {
        return std::path::PathBuf::from(dir).join("providers.json");
    }
    let base = std::env::var("XDG_DATA_HOME")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| {
            let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
            std::path::PathBuf::from(home).join(".local/share")
        });
    base.join("combo").join("providers.json")
}

/// 本地模型缓存条目:仅 id + 模型列表,不回存 key 等敏感字段。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CachedModels {
    pub id: String,
    #[serde(default)]
    pub models: Vec<ModelInfo>,
}

/// 拉取模型缓存文件路径(数据目录,与 providers.json 同级)。
pub fn model_cache_path() -> std::path::PathBuf {
    combo_providers_path().with_file_name("provider-models.json")
}

/// 读取本地缓存的拉取模型(文件不存在返回空)。
pub fn load_cached_models() -> Result<Vec<CachedModels>> {
    let path = model_cache_path();
    if !path.exists() {
        return Ok(Vec::new());
    }
    let text = std::fs::read_to_string(&path)?;
    let list: Vec<CachedModels> = serde_json::from_str(&text)
        .map_err(|e| anyhow::anyhow!("解析 {} 失败: {e}", path.display()))?;
    Ok(list)
}

/// 持久化某 provider 拉取到的模型列表(按 id 整体覆盖)。
pub fn save_cached_models(provider_id: &str, models: &[ModelInfo]) -> Result<()> {
    let mut list = load_cached_models().unwrap_or_default();
    if let Some(existing) = list.iter_mut().find(|c| c.id == provider_id) {
        existing.models = models.to_vec();
    } else {
        list.push(CachedModels {
            id: provider_id.to_string(),
            models: models.to_vec(),
        });
    }
    let path = model_cache_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let out = serde_json::to_string_pretty(&list)
        .map_err(|e| anyhow::anyhow!("序列化模型缓存失败: {e}"))?;
    std::fs::write(&path, out)?;
    Ok(())
}

/// 删除某 provider 的本地模型缓存(删除自定义 provider 时清理遗留,
/// 避免残留模型出现在 Composer 列表里)。
pub fn remove_cached_models(provider_id: &str) -> Result<()> {
    let mut list = load_cached_models()?;
    let before = list.len();
    list.retain(|c| c.id != provider_id);
    if list.len() == before {
        // 无此条目(或缓存文件本就不存在):无需写回
        return Ok(());
    }
    let path = model_cache_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let out = serde_json::to_string_pretty(&list)
        .map_err(|e| anyhow::anyhow!("序列化模型缓存失败: {e}"))?;
    std::fs::write(&path, out)?;
    Ok(())
}

/// 按 id 查找 provider:先查自定义 providers map,再查 combo providers.json,
/// 最后回退内置定义。
pub fn find_provider(
    id: &str,
    custom: &std::collections::BTreeMap<String, crate::config::ProviderConfig>,
) -> Result<ProviderInfo> {
    // 1. 配置文件内嵌 providers
    if let Some(c) = custom.get(id) {
        let from_cfg = ProviderInfo::from_config(id, c);
        let mut p =
            if let Some(mut b) = builtin_providers().into_iter().find(|b| b.id == id) {
                // 内置 provider 被配置部分覆盖:仅覆盖显式给出的字段,
                // 缺失的 base_url/key/模型回落内置定义(与 list_providers 口径一致)
                if from_cfg.api_key.is_some() { b.api_key = from_cfg.api_key; }
                if from_cfg.name.is_some() { b.name = from_cfg.name; }
                if !from_cfg.api_keys.is_empty() { b.api_keys = from_cfg.api_keys; }
                if from_cfg.api_endpoint.is_some() { b.api_endpoint = from_cfg.api_endpoint; }
                if from_cfg.provider_type.is_some() { b.provider_type = from_cfg.provider_type; }
                if from_cfg.default_large_model_id.is_some() {
                    b.default_large_model_id = from_cfg.default_large_model_id;
                }
                if from_cfg.default_small_model_id.is_some() {
                    b.default_small_model_id = from_cfg.default_small_model_id;
                }
                if !from_cfg.models.is_empty() { b.models = from_cfg.models; }
                b
            } else {
                from_cfg
            };
        // 配置未指定默认模型时,从 combo providers.json 合并默认模型
        if p.default_large_model_id.is_none() {
            if let Ok(combo) = load_combo_providers() {
                if let Some(cp) = combo.iter().find(|cp| cp.id == id) {
                    p.default_large_model_id = cp.default_large_model_id.clone();
                    p.default_small_model_id = cp.default_small_model_id.clone();
                }
            }
        }
        return Ok(p);
    }
    // 2. combo providers.json(静态目录)
    let combo = load_combo_providers()?;
    if let Some(p) = combo.iter().find(|p| p.id == id) {
        return Ok(p.clone());
    }
    // 3. 内置定义
    builtin_providers()
        .into_iter()
        .find(|p| p.id == id)
        .ok_or_else(|| anyhow::anyhow!("未知提供商 `{id}`(可配置 providers 或运行 `combo-cli config import`)"))
}

impl ProviderInfo {
    /// 从 ProviderConfig 构造。
    pub fn from_config(id: &str, c: &crate::config::ProviderConfig) -> Self {
        let mut models = Vec::new();
        for mid in [&c.default_large_model_id, &c.default_small_model_id]
            .into_iter()
            .flatten()
        {
            if !models.iter().any(|m: &ModelInfo| &m.id == mid) {
                models.push(ModelInfo {
                    id: mid.clone(),
                    name: None,
                    ..Default::default()
                });
            }
        }
        Self {
            id: id.to_string(),
            // 显示名称透传配置(未设置时由调用方回落到 id,内置 provider 覆盖场景
            // 保持内置显示名不受影响)
            name: c.name.clone(),
            api_key: c.api_key.clone(),
            api_keys: c.api_keys.clone(),
            api_endpoint: c.base_url.clone(),
            provider_type: c.provider_type.clone(),
            default_large_model_id: c.default_large_model_id.clone(),
            default_small_model_id: c.default_small_model_id.clone(),
            models,
        }
    }
}

/// 内置 provider 的 id 列表(供提示)。
#[allow(dead_code)]
pub fn builtin_ids() -> Vec<String> {
    builtin_providers()
        .into_iter()
        .map(|p| p.id)
        .collect()
}

// ---------- 远程模型列表拉取 ----------

/// 各 provider 类型的默认 API base URL(用户未配置 endpoint 时使用)。
fn default_endpoint(provider_type: &str, provider_id: &str) -> String {
    match provider_type {
        "anthropic" => "https://api.anthropic.com/v1".to_string(),
        "google" => "https://generativelanguage.googleapis.com/v1beta".to_string(),
        // 内置 provider id 的默认 endpoint
        _ if provider_id == "ollama" => "http://localhost:11434/v1".to_string(),
        _ if provider_id == "deepseek" => "https://api.deepseek.com/v1".to_string(),
        _ if provider_id == "opencode" => "https://opencode.ai/zen/v1".to_string(),
        _ if provider_id == "openrouter" => "https://openrouter.ai/api/v1".to_string(),
        _ if provider_id == "zhipu" => "https://open.bigmodel.cn/api/coding/paas/v4".to_string(),
        _ if provider_id == "openai" => "https://api.openai.com/v1".to_string(),
        _ => "https://api.openai.com/v1".to_string(),
    }
}

/// 规范化 endpoint:去掉尾部斜杠,确保包含合理路径。
fn normalize_endpoint(endpoint: &str, provider_type: &str) -> String {
    let base = endpoint.trim_end_matches('/');
    // Google API 的 models 路径在 v1beta 下
    if provider_type == "google" && !base.contains("/v1beta") && !base.contains("/v1") {
        return format!("{}/v1beta", base);
    }
    base.to_string()
}

/// 拉取 provider 支持的模型列表。
///
/// 根据 provider_type 选择不同的 API 路径与鉴权方式:
/// - openai / openai-compat: `GET {endpoint}/models`,`Authorization: Bearer {key}`
/// - anthropic: `GET {endpoint}/models`,`x-api-key: {key}`
/// - google: `GET {endpoint}/models`,`x-goog-api-key: {key}`
pub async fn fetch_remote_models(
    provider_type: &str,
    api_key: &str,
    api_endpoint: Option<&str>,
    provider_id: &str,
) -> Result<Vec<ModelInfo>> {
    let endpoint = api_endpoint
        .filter(|e| !e.is_empty())
        .map(|e| normalize_endpoint(e, provider_type))
        .unwrap_or_else(|| default_endpoint(provider_type, provider_id));

    let url = format!("{}/models", endpoint);
    tracing::info!("拉取远程模型列表: {} (type={})", url, provider_type);

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()?;

    let resp = match provider_type {
        "anthropic" => {
            client
                .get(&url)
                .header("x-api-key", api_key)
                .header("anthropic-version", "2023-06-01")
        }
        "google" => client.get(&url).header("x-goog-api-key", api_key),
        _ => client
            .get(&url)
            .header("Authorization", format!("Bearer {}", api_key)),
    }
    .send()
    .await
    .map_err(|e| anyhow::anyhow!("请求 {} 失败: {e}", url))?;

    let status = resp.status();
    let body = resp
        .text()
        .await
        .map_err(|e| anyhow::anyhow!("读取响应体失败: {e}"))?;
    if !status.is_success() {
        let preview = body.chars().take(300).collect::<String>();
        anyhow::bail!("API 返回 {}: {}", status, preview);
    }

    let data: serde_json::Value = serde_json::from_str(&body)
        .map_err(|e| anyhow::anyhow!("解析 JSON 失败: {e}"))?;

    let models = match provider_type {
        "anthropic" => parse_anthropic_models(&data),
        "google" => parse_google_models(&data),
        _ => parse_openai_models(&data),
    };

    tracing::info!("从 {} 拉取到 {} 个模型", url, models.len());
    Ok(models)
}

/// 解析 OpenAI 兼容格式:`{ data: [{ id, ... }] }`。
fn parse_openai_models(data: &serde_json::Value) -> Vec<ModelInfo> {
    let Some(arr) = data.get("data").and_then(|v| v.as_array()) else {
        return Vec::new();
    };
    arr.iter()
        .filter_map(|m| {
            let id = m.get("id").and_then(|v| v.as_str())?.to_string();
            // 过滤掉嵌入/语音/图像等非对话模型
            if id.contains("embedding")
                || id.contains("tts")
                || id.contains("whisper")
                || id.contains("davinci")
                || id.contains("moderation")
                || id.contains("image")
            {
                return None;
            }
            Some(ModelInfo {
                id: id.clone(),
                name: Some(id),
                ..Default::default()
            })
        })
        .collect()
}

/// 解析 Anthropic 格式:`{ data: [{ id, display_name, ... }] }`。
fn parse_anthropic_models(data: &serde_json::Value) -> Vec<ModelInfo> {
    let Some(arr) = data.get("data").and_then(|v| v.as_array()) else {
        return Vec::new();
    };
    arr.iter()
        .filter_map(|m| {
            let id = m.get("id").and_then(|v| v.as_str())?.to_string();
            let name = m
                .get("display_name")
                .and_then(|v| v.as_str())
                .unwrap_or(&id)
                .to_string();
            Some(ModelInfo {
                id,
                name: Some(name),
                ..Default::default()
            })
        })
        .collect()
}

/// 解析 Google Gemini 格式:`{ models: [{ name: "models/gemini-...", displayName, supportedGenerationMethods: [...] }] }`。
fn parse_google_models(data: &serde_json::Value) -> Vec<ModelInfo> {
    let Some(arr) = data.get("models").and_then(|v| v.as_array()) else {
        return Vec::new();
    };
    arr.iter()
        .filter_map(|m| {
            let raw_name = m.get("name").and_then(|v| v.as_str())?;
            // name 形如 "models/gemini-2.0-flash",取后半段作为 id
            let id = raw_name.strip_prefix("models/").unwrap_or(raw_name).to_string();
            // 只保留支持内容生成的模型
            let methods = m
                .get("supportedGenerationMethods")
                .and_then(|v| v.as_array());
            if let Some(methods) = methods {
                let supports = methods.iter().any(|meth| {
                    meth.as_str()
                        .map(|s| s == "generateContent" || s == "generateContent")
                        .unwrap_or(false)
                });
                if !supports {
                    return None;
                }
            }
            let name = m
                .get("displayName")
                .and_then(|v| v.as_str())
                .unwrap_or(&id)
                .to_string();
            Some(ModelInfo {
                id,
                name: Some(name),
                ..Default::default()
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cached_models_roundtrip_upserts_by_id() {
        // 用临时数据目录隔离,避免写真实 providers.json 同级文件
        let dir = tempfile::tempdir().unwrap();
        let prev = std::env::var_os("COMBO_DATA_DIR");
        std::env::set_var("COMBO_DATA_DIR", dir.path());
        let models = vec![
            ModelInfo { id: "m1".into(), name: Some("M1".into()), ..Default::default() },
            ModelInfo { id: "m2".into(), name: None, ..Default::default() },
        ];
        save_cached_models("deepseek", &models).unwrap();
        // 再存一次,覆盖 m1/m2 为单个 m3
        let m3 = vec![ModelInfo { id: "m3".into(), name: None, ..Default::default() }];
        save_cached_models("deepseek", &m3).unwrap();
        save_cached_models("opencode", &models).unwrap();

        let cached = load_cached_models().unwrap();
        let ds = cached.iter().find(|c| c.id == "deepseek").unwrap();
        assert_eq!(ds.models.len(), 1, "同 provider 应整体覆盖");
        assert_eq!(ds.models[0].id, "m3");
        assert!(cached.iter().any(|c| c.id == "opencode" && c.models.len() == 2));
        // 缓存文件里不应出现 key 字段
        let text = std::fs::read_to_string(model_cache_path()).unwrap();
        assert!(!text.contains("api_key"));
        match prev {
            Some(v) => std::env::set_var("COMBO_DATA_DIR", v),
            None => std::env::remove_var("COMBO_DATA_DIR"),
        }
    }

    #[test]
    fn expand_env_handles_dollar_and_literal() {
        assert_eq!(expand_env("$NOPE_VAR_XYZ"), None);
        assert_eq!(expand_env("https://example.com/v1"), Some("https://example.com/v1".into()));
        assert_eq!(expand_env(""), None);
    }

    #[test]
    fn parse_provider_json() {
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
        let p = find_provider("opencode", &std::collections::BTreeMap::new()).unwrap();
        assert_eq!(p.default_model(), "deepseek-v4-flash-free");
        assert_eq!(p.resolved_endpoint().unwrap(), "https://opencode.ai/zen/v1");
    }

    #[test]
    fn find_provider_keeps_builtin_endpoint_when_config_misses_base_url() {
        // 配置只覆盖 key、缺 base_url:endpoint 应回落内置定义,
        // 否则运行时请求会落到默认 OpenAI 端点(与 list_providers 口径一致)
        let mut custom = std::collections::BTreeMap::new();
        custom.insert(
            "opencode".to_string(),
            crate::config::ProviderConfig {
                provider_type: Some("openai-compat".into()),
                api_key: Some("sk-test".into()),
                base_url: None,
                ..Default::default()
            },
        );
        let p = find_provider("opencode", &custom).unwrap();
        assert_eq!(p.resolved_endpoint().unwrap(), "https://opencode.ai/zen/v1");
        assert_eq!(p.api_key.as_deref(), Some("sk-test"));
        assert_eq!(p.name.as_deref(), Some("OpenCode Zen"));
        assert_eq!(p.default_model(), "deepseek-v4-flash-free");
    }

    #[test]
    fn find_provider_config_overrides_builtin_endpoint_when_provided() {
        let mut custom = std::collections::BTreeMap::new();
        custom.insert(
            "opencode".to_string(),
            crate::config::ProviderConfig {
                provider_type: Some("openai-compat".into()),
                api_key: Some("sk-test".into()),
                base_url: Some("https://custom.example/v1".into()),
                ..Default::default()
            },
        );
        let p = find_provider("opencode", &custom).unwrap();
        assert_eq!(p.resolved_endpoint().unwrap(), "https://custom.example/v1");
        // 未配置默认模型时保留内置模型的默认模型
        assert_eq!(p.default_model(), "deepseek-v4-flash-free");
    }

    #[test]
    fn parse_openai_models_filters_non_chat() {
        let data = serde_json::json!({
            "data": [
                {"id": "gpt-4o"},
                {"id": "gpt-4o-mini"},
                {"id": "text-embedding-3-small"},
                {"id": "whisper-1"},
                {"id": "dall-e-image-1"},
            ]
        });
        let models = parse_openai_models(&data);
        let ids: Vec<&str> = models.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, vec!["gpt-4o", "gpt-4o-mini"]);
    }

    #[test]
    fn parse_anthropic_models_extracts_display_name() {
        let data = serde_json::json!({
            "data": [
                {"id": "claude-sonnet-4-5", "display_name": "Claude Sonnet 4.5"},
                {"id": "claude-haiku-4-5-20251001", "display_name": "Claude Haiku 4.5"},
            ]
        });
        let models = parse_anthropic_models(&data);
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].id, "claude-sonnet-4-5");
        assert_eq!(models[0].name.as_deref(), Some("Claude Sonnet 4.5"));
    }

    #[test]
    fn parse_google_models_strips_prefix() {
        let data = serde_json::json!({
            "models": [
                {"name": "models/gemini-2.0-flash", "displayName": "Gemini 2.0 Flash",
                 "supportedGenerationMethods": ["generateContent", "countTokens"]},
                {"name": "models/text-embedding-004", "displayName": "Embedding",
                 "supportedGenerationMethods": ["embedContent"]},
            ]
        });
        let models = parse_google_models(&data);
        assert_eq!(models.len(), 1, "应过滤掉不支持 generateContent 的模型");
        assert_eq!(models[0].id, "gemini-2.0-flash");
        assert_eq!(models[0].name.as_deref(), Some("Gemini 2.0 Flash"));
    }

    #[test]
    fn normalize_endpoint_strips_trailing_slash() {
        assert_eq!(normalize_endpoint("https://api.openai.com/v1/", "openai"), "https://api.openai.com/v1");
        assert_eq!(normalize_endpoint("https://api.openai.com/v1", "openai"), "https://api.openai.com/v1");
    }

    #[test]
    fn default_endpoint_returns_builtin_urls() {
        assert_eq!(default_endpoint("openai-compat", "deepseek"), "https://api.deepseek.com/v1");
        assert_eq!(default_endpoint("openai-compat", "openrouter"), "https://openrouter.ai/api/v1");
        assert_eq!(default_endpoint("openai-compat", "zhipu"), "https://open.bigmodel.cn/api/coding/paas/v4");
        assert_eq!(default_endpoint("openai-compat", "opencode"), "https://opencode.ai/zen/v1");
    }
}
