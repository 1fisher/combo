//! agent 核心:构建 agent(内置工具 + MCP 工具)、单轮 ask、交互式 chat。
//!
//! 由于 rig 各 provider 的 Client/CompletionModel 类型不同,统一走一个
//! `build_agent` 泛型函数 + 顶层 provider 分发(macro 展开),避免类型爆炸。

use crate::config::ResolvedConfig;
use crate::mcp::{McpConnection, tool_server_with_builtin};
use crate::providers::ProviderInfo;
use crate::db;
use anyhow::Result;
use futures::StreamExt;
use rig::agent::{Agent, MultiTurnStreamItem};
use rig::client::ProviderClient;
use rig::completion::message::ToolResultContent;
use rig::completion::{CompletionModel, GetTokenUsage, Message};
use rig::prelude::AgentClientExt;
use rig::streaming::{StreamedAssistantContent, StreamedUserContent, StreamingChat, StreamingPrompt};
use rig::tool::DynamicTool;
use serde_json::Value;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

/// 组装一个 agent:内置工具 + 可选 MCP 工具。
///
/// `client` 来自具体 provider;MCP 连接需要 ToolServerHandle 才能注册工具,
/// 所以先建 ToolServer(带内置工具),MCP 连接后 agent 用该 handle。
/// 将推理强度映射为 additional_params JSON(合并进请求体,各 provider 取所需字段)。
/// - `nothink`:关闭思考(enable_thinking=false / thinking disabled)
/// - `high`/`max`:开启思考并设 reasoning_effort
fn reasoning_additional_params(effort: &str) -> serde_json::Value {
    match effort {
        "nothink" => serde_json::json!({
            "enable_thinking": false,
            "thinking": {"type": "disabled"}
        }),
        "high" => serde_json::json!({
            "enable_thinking": true,
            "reasoning_effort": "high"
        }),
        "max" => serde_json::json!({
            "enable_thinking": true,
            "reasoning_effort": "max"
        }),
        _ => serde_json::json!({}),
    }
}

async fn build_agent<C>(
    client: C,
    model: &str,
    preamble: &str,
    builtin: Vec<DynamicTool>,
    mcp_specs: Vec<(String, Option<String>, Option<String>)>,
    reasoning_effort: Option<&str>,
) -> Result<(
    Agent<C::CompletionModel>,
    Option<McpConnection>,
)>
where
    C: AgentClientExt + Send + Sync + 'static,
    C::CompletionModel: CompletionModel + Send + Sync + 'static,
{
    // 1. ToolServer:内置工具先进去
    let handle = tool_server_with_builtin(&builtin);

    // 2. MCP 连接(如有)注册工具到同一 handle
    let specs: Vec<_> = mcp_specs
        .into_iter()
        .filter(|(_, cmd, url)| cmd.is_some() || url.is_some())
        .collect();
    let mcp_conn = if specs.is_empty() {
        None
    } else {
        let conns =
            crate::mcp::connect_many(specs, handle.clone(), true).await?;
        Some(McpConnection::from_many(handle.clone(), conns))
    };

    // 3. agent 通过 tool_server_handle 共享工具
    // rig 默认 max_turns=1(仅一轮),开启工具后需要多轮才能完成工具调用循环。
    // max_turns 是"模型调用总预算"(含首轮、工具续轮、重试),复杂任务(多文件
    // 探索/多工具链式调用)极易超过 30,设为 200 兼顾长任务与失控保护。
    // name 填入遥测 span 的 gen_ai.agent.name(否则 rig 兜底显示 "Unnamed Agent")。
    let builder = client
        .agent(model)
        .name("Combo")
        .preamble(preamble)
        .tool_server_handle(handle)
        .default_max_turns(200);
    let agent = match reasoning_effort {
        Some(effort) if !effort.is_empty() => {
            builder.additional_params(reasoning_additional_params(effort)).build()
        }
        _ => builder.build(),
    };

    Ok((agent, mcp_conn))
}

/// 单轮问答配置。
/// 单轮问答配置:已解析出 provider 信息、模型、key、endpoint。
#[derive(Clone)]
pub struct AskConfig {
    pub provider: ProviderInfo,
    pub model: String,
    /// 最终 preamble(用户 preamble + 按全局禁用过滤后的 skills 摘要)。
    pub preamble: String,
    /// 用户原始 preamble(不含 skills 摘要),供按 workspace 过滤后重建。
    pub base_preamble: String,
    /// 技能搜索路径(重建 preamble 用)。
    pub skills_paths: Vec<String>,
    /// 全局禁用的 skill 名(配置文件 disabled_skills)。
    pub disabled_skills: Vec<String>,
    pub tools: bool,
    pub mcp_command: Option<String>,
    pub mcp_url: Option<String>,
    /// 显式 API key(配置文件 api_key 字段);优先于 provider 定义。
    pub explicit_api_key: Option<String>,
    /// 显式 base_url(配置文件 base_url 字段);优先于 provider 定义。
    pub explicit_base_url: Option<String>,
    /// 配置文件中的 MCP server 列表((name, command, url))。
    pub mcp_servers: Vec<(String, Option<String>, Option<String>)>,
    /// 推理强度(nothink / high / max),通过 additional_params 注入请求体。
    pub reasoning_effort: Option<String>,
    /// LSP server 配置(语言标识 → server 配置),供工具按语言路由。
    pub lsp: BTreeMap<String, crate::config::LspServerConfig>,
    /// 只读工具集(multi-agent 只读角色用):tools=true 时改用
    /// `builtin_tools_readonly`,不含 write/replace/bash,杜绝写副作用。
    pub readonly_tools: bool,
}

impl AskConfig {
    /// 从合并后的配置 + 解析出的 ProviderInfo 构造。
    pub fn from_resolved(r: &ResolvedConfig, provider: ProviderInfo) -> Self {
        let model = r
            .model
            .clone()
            .unwrap_or_else(|| provider.default_model());
        // 收集 MCP:旧版 mcp_command/mcp_url + 配置的 mcp map
        let mut mcp_servers: Vec<(String, Option<String>, Option<String>)> = Vec::new();
        for (name, srv) in &r.mcp {
            let cmd = srv
                .command
                .clone()
                .map(|c| {
                    if let Some(args) = &srv.args {
                        format!("{} {}", c, args.join(" "))
                    } else {
                        c
                    }
                });
            mcp_servers.push((name.clone(), cmd, srv.url.clone()));
        }
        let skills = crate::skills::skills_preamble(r);
        Self {
            provider,
            model,
            preamble: format!("{}{}", r.preamble, skills),
            base_preamble: r.preamble.clone(),
            skills_paths: r.skills_paths.clone(),
            disabled_skills: r.disabled_skills.clone(),
            tools: r.tools,
            mcp_command: r.mcp_command.clone(),
            mcp_url: r.mcp_url.clone(),
            explicit_api_key: r.api_key.clone(),
            explicit_base_url: r.base_url.clone(),
            mcp_servers,
            reasoning_effort: r.reasoning_effort.clone(),
            lsp: r.lsp.clone(),
            readonly_tools: false,
        }
    }

    /// 在全局禁用的基础上追加额外禁用的 skill,重建 preamble。
    /// 供 serve 按 workspace 应用技能开关(全局 + 该 workspace 的禁用合并)。
    pub fn with_disabled_skills(&self, extra: &[String]) -> Self {
        let mut disabled = self.disabled_skills.clone();
        for d in extra {
            if !disabled.iter().any(|x| x == d) {
                disabled.push(d.clone());
            }
        }
        let skills = crate::skills::skills_preamble_with(&self.skills_paths, &disabled);
        Self {
            preamble: format!("{}{}", self.base_preamble, skills),
            disabled_skills: disabled,
            ..self.clone()
        }
    }

    /// 按工作区目录加载 `AGENTS.md`(项目基础规则),并合并额外禁用的 skill,
    /// 一次性重建 preamble = `base_preamble` + `AGENTS.md` + skills 摘要。
    ///
    /// `AGENTS.md` 缺失时仅提示初始化项目,不影响运行(详见 `agents_md::load_preamble`)。
    pub fn with_workspace(
        &self,
        workspace_dir: Option<PathBuf>,
        extra_disabled: &[String],
    ) -> Self {
        let mut disabled = self.disabled_skills.clone();
        for d in extra_disabled {
            if !disabled.iter().any(|x| x == d) {
                disabled.push(d.clone());
            }
        }
        let agents = crate::agents_md::load_preamble(workspace_dir.as_deref());
        let skills = crate::skills::skills_preamble_with(&self.skills_paths, &disabled);
        Self {
            preamble: format!("{}{}{}", self.base_preamble, agents, skills),
            disabled_skills: disabled,
            ..self.clone()
        }
    }

    /// 解析最终 API key:CLI/配置显式值 > provider 定义(支持 $ENV)> opencode auth.json。
    pub fn api_key(&self) -> Result<String> {
        if let Some(k) = self.explicit_api_key.as_deref().filter(|k| !k.is_empty()) {
            return Ok(k.to_string());
        }
        if let Some(k) = self.provider.resolved_api_key().filter(|k| !k.is_empty()) {
            return Ok(k);
        }
        // opencode zen(内置 id)回退到 opencode auth.json
        if self.provider.id == "opencode" || self.provider.id == "opencode-zen" {
            if let Some(k) = crate::config::read_opencode_key("opencode")?.filter(|k| !k.is_empty()) {
                return Ok(k);
            }
        }
        anyhow::bail!(
            "提供商 `{}` 缺少 API key:请设置 {} 环境变量,或 `combo-cli config import`,或配置 api_key",
            self.provider.id,
            self.provider.api_key.as_deref().unwrap_or("对应环境变量")
        )
    }

    /// 解析最终 endpoint:显式 base_url > provider 定义(支持 $ENV)> 默认。
    pub fn endpoint(&self) -> String {
        if let Some(u) = self.explicit_base_url.as_deref().filter(|u| !u.is_empty()) {
            return u.to_string();
        }
        self.provider
            .resolved_endpoint()
            .unwrap_or_else(|| "https://api.openai.com/v1".to_string())
    }

    /// 收集全部 MCP 规格:配置文件 mcp map + 旧版 mcp_command/mcp_url。
    pub fn mcp_specs(&self) -> Vec<(String, Option<String>, Option<String>)> {
        let mut specs = self.mcp_servers.clone();
        if self.mcp_command.is_some() || self.mcp_url.is_some() {
            specs.push((
                "legacy".into(),
                self.mcp_command.clone(),
                self.mcp_url.clone(),
            ));
        }
        specs
    }
}

/// 每次发往 LLM 的请求在 tracing 日志标记 provider/模型 ID,便于调试核对
/// (例如确认是否走了 opencode-zen 的 deepseek-v4-flash-free)。
/// anthropic/google 走官方 SDK 默认 endpoint,显示占位;不打印 API key。
fn llm_endpoint_for_log(cfg: &AskConfig, ptype: &str) -> String {
    match ptype {
        "anthropic" => "https://api.anthropic.com(官方 SDK 默认)".to_string(),
        "google" => "https://generativelanguage.googleapis.com(官方 SDK 默认)".to_string(),
        _ => cfg.endpoint(),
    }
}

/// 在 tracing 日志输出本次 LLM 请求的模型标识(provider id + model + endpoint)。
/// 所有 LLM 调用入口(ask_answer / stream_run / chat_loop)统一调用,
/// 保证控制台日志每次请求都能看到实际使用的模型 ID。
fn log_llm_request(cfg: &AskConfig) {
    let ptype = cfg.provider.provider_type.as_deref().unwrap_or("openai");
    tracing::info!(
        "LLM 请求: provider={} type={} model={} effort={} endpoint={}",
        cfg.provider.id,
        ptype,
        cfg.model,
        cfg.reasoning_effort.as_deref().unwrap_or("default"),
        llm_endpoint_for_log(cfg, ptype)
    );
}

/// 单轮问答:返回最终答案。
pub async fn ask_answer(
    cfg: &AskConfig,
    question: &str,
    workspace_dir: Option<PathBuf>,
) -> Result<String> {
    log_llm_request(cfg);
    let builtin = if cfg.tools {
        crate::tools::builtin_tools(workspace_dir, cfg.lsp.clone())
    } else {
        Vec::new()
    };
    let mcp = cfg.mcp_specs();
    let ptype = cfg.provider.provider_type.as_deref().unwrap_or("openai");
    let effort = cfg.reasoning_effort.as_deref();

    match ptype {
        "anthropic" => {
            let client = rig::providers::anthropic::Client::from_env()?;
            let (agent, _mcp) =
                build_agent(client, &cfg.model, &cfg.preamble, builtin, mcp, effort).await?;
            ask_one(&agent, question).await
        }
        "google" => {
            let client = rig::providers::gemini::Client::from_env()?;
            let (agent, _mcp) =
                build_agent(client, &cfg.model, &cfg.preamble, builtin, mcp, effort).await?;
            ask_one(&agent, question).await
        }
        // openai / openai-compat / 其它一律走 OpenAI 兼容协议
        _ => {
            let key = cfg.api_key()?;
            let base = cfg.endpoint();
            let builder = rig::providers::openai::CompletionsClient::builder()
                .api_key(key)
                .base_url(base);
            let client = builder
                .build()
                .map_err(|e| anyhow::anyhow!("创建 client 失败: {e}"))?;
            let (agent, _mcp) =
                build_agent(client, &cfg.model, &cfg.preamble, builtin, mcp, effort).await?;
            ask_one(&agent, question).await
        }
    }
}

/// 单轮问答:直接打印最终结果。
pub async fn ask_with(cfg: &AskConfig, question: &str) -> Result<()> {
    // 加载当前目录的 AGENTS.md(项目基础规则)进 preamble。
    let cfg = cfg.with_workspace(std::env::current_dir().ok(), &[]);
    let answer = ask_answer(&cfg, question, std::env::current_dir().ok()).await?;
    println!("{answer}");
    Ok(())
}

/// 泛型单轮问答(流式打印)。
async fn ask_one<M>(agent: &Agent<M>, question: &str) -> Result<String>
where
    M: CompletionModel + 'static,
    M::StreamingResponse: GetTokenUsage,
{
    let mut stream = agent.stream_prompt(question).await;
    let mut out = String::new();
    while let Some(item) = stream.next().await {
        match item? {
            MultiTurnStreamItem::StreamAssistantItem(StreamedAssistantContent::Text(t)) => {
                out.push_str(&t.text);
            }
            _ => {}
        }
    }
    Ok(out)
}

/// run 结束后的真实 token 用量(来自 rig 原生 `completion::Usage`,provider 上报)。
///
/// rig 的多轮流式循环中,每次 completion 调用都会重发全部历史并各自上报一份
/// `Usage`(经 `GetTokenUsage` 读取);用 rig 的 `Add`/`AddAssign` 累计得到
/// 整个 run 的真实消耗,同时保留最后一次调用的用量(其 input 即当前上下文
//  窗口的实际占用,由 serve 记录到会话表的 context_tokens 列)。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct RunUsage {
    /// 最后一次 completion 调用的输入 token(含全部历史 + preamble + 工具定义,
    /// ≈ 当前上下文窗口占用)。
    pub input: u64,
    /// 最后一次 completion 调用的输出 token。
    pub output: u64,
    /// 本次 run 全部 completion 调用的累计输入 token(agent 实际消耗)。
    pub total_input: u64,
    /// 本次 run 全部 completion 调用的累计输出 token(agent 实际消耗)。
    pub total_output: u64,
    /// 缓存命中的输入 token(cached + cache_creation,计价通常为 10%)。
    pub cached_input: u64,
    /// 本次 run 的 completion 调用次数(API 调用次数)。与 rig 日志
    /// "Current conversation Turns: N/max" 的 N 同源:多轮工具循环中每
    /// 完成一次模型调用记 1,供前端「调用次数」展示。
    pub turns: u64,
}

impl RunUsage {
    /// 从 rig 原生 `Usage`(最后一次调用)、run 累计值与调用次数构造。
    fn new(last: rig::completion::Usage, total: rig::completion::Usage, turns: u64) -> Self {
        Self {
            input: last.input_tokens,
            output: last.output_tokens,
            total_input: total.input_tokens,
            total_output: total.output_tokens,
            cached_input: total.cached_input_tokens + total.cache_creation_input_tokens,
            turns,
        }
    }

    /// 是否携带有效数值(rig 约定零值 = provider 未上报)。
    pub fn has_values(&self) -> bool {
        *self != Self::default()
    }

    /// 当前上下文窗口占用估算:最后一次调用的 input + output
    /// (下一轮请求大致在此基础上追加新用户消息)。
    pub fn context_tokens(&self) -> u64 {
        self.input.saturating_add(self.output)
    }
}

/// 流式运行事件(serve 模式转发为 SSE 事件)。
#[derive(Clone, Debug)]
pub enum RunEvent {
    /// 文本增量。
    TextDelta(String),
    /// 推理过程增量(thinking/reasoning_content,DeepSeek 思考模式等)。
    ReasoningDelta(String),
    /// 完整工具调用(rig 已执行并自动回填结果)。
    ToolCall { id: String, name: String, input: String },
    /// 工具执行结果。
    ToolResult {
        id: String,
        name: String,
        content: String,
        /// 命令/工具失败(退出码非 0 或超时):serve 标记消息项为错误态。
        is_error: bool,
        /// 命令退出码(bash 等)。
        exit_code: Option<i32>,
        /// 是否超时被终止。
        timed_out: bool,
        /// 执行耗时(毫秒)。
        duration_ms: Option<u64>,
    },
    /// run 结束后的真实 token 用量(rig 原生 Usage,含最后调用与 run 累计)。
    Usage(RunUsage),
    /// run 内第 N 次 completion 调用完成(即第 N 次 LLM API 请求)。
    /// 与 rig 日志 "Current conversation Turns: N/max" 的 N 同源,
    /// 供前端实时累计「API 调用次数」。
    Turns(u64),
}

/// 根据 bash 结构化字段判断工具结果是否为失败态:非 0 退出码或超时。
/// 无退出码字段的工具(question 等)不算失败。
fn tool_result_is_error(exit_code: Option<i32>, timed_out: bool) -> bool {
    exit_code.is_some_and(|c| c != 0) || timed_out
}

/// 流式运行一次 agent 对话(多轮,含工具调用与历史)。
///
/// `history` 为之前的消息;`question` 作为本轮用户消息由 rig 追加。
/// `cancel` 收到 `true` 时尽快中断;返回 `Ok(Some(回答))`,被取消返回 `Ok(None)`。
pub async fn stream_run<F>(
    cfg: &AskConfig,
    question: &str,
    history: &[Message],
    workspace_dir: Option<PathBuf>,
    mut cancel: tokio::sync::watch::Receiver<bool>,
    extra_tools: Vec<DynamicTool>,
    mut on_event: F,
) -> Result<Option<String>>
where
    F: FnMut(RunEvent),
{
    log_llm_request(cfg);
    let mut builtin = if cfg.tools {
        if cfg.readonly_tools {
            crate::tools::builtin_tools_readonly(workspace_dir, cfg.lsp.clone())
        } else {
            crate::tools::builtin_tools(workspace_dir, cfg.lsp.clone())
        }
    } else {
        Vec::new()
    };
    builtin.extend(extra_tools);
    let mcp = cfg.mcp_specs();
    let ptype = cfg.provider.provider_type.clone().unwrap_or_else(|| "openai".into());
    let effort = cfg.reasoning_effort.as_deref();
    match ptype.as_str() {
        "anthropic" => {
            let client = rig::providers::anthropic::Client::from_env()?;
            let (agent, _mcp) = build_agent(client, &cfg.model, &cfg.preamble, builtin, mcp, effort).await?;
            stream_one(&agent, question, history, &mut cancel, &mut on_event).await
        }
        "google" => {
            let client = rig::providers::gemini::Client::from_env()?;
            let (agent, _mcp) = build_agent(client, &cfg.model, &cfg.preamble, builtin, mcp, effort).await?;
            stream_one(&agent, question, history, &mut cancel, &mut on_event).await
        }
        // openai / openai-compat / 其它一律走 OpenAI 兼容协议
        _ => {
            let key = cfg.api_key()?;
            let base = cfg.endpoint();
            let builder = rig::providers::openai::CompletionsClient::builder()
                .api_key(key)
                .base_url(base);
            let client = builder
                .build()
                .map_err(|e| anyhow::anyhow!("创建 client 失败: {e}"))?;
            let (agent, _mcp) = build_agent(client, &cfg.model, &cfg.preamble, builtin, mcp, effort).await?;
            stream_one(&agent, question, history, &mut cancel, &mut on_event).await
        }
    }
}

/// 等待模型响应阶段的空闲超时:`COMBO_STREAM_IDLE_TIMEOUT` 环境变量
/// (秒)可覆盖,`0` 表示关闭;默认 300s——大上下文 prefill 实测可达
/// 200s+,阈值需大于最坏合法延迟,只兜「永不返回」的挂死。
fn idle_timeout(no_tools_running: bool) -> Option<Duration> {
    if !no_tools_running {
        return None;
    }
    let raw = std::env::var("COMBO_STREAM_IDLE_TIMEOUT").ok();
    idle_timeout_from(raw.as_deref(), 300)
}

/// 纯函数版本(便于测试):None → 默认值;解析失败/空串 → 默认值;0 → 关闭。
fn idle_timeout_from(raw: Option<&str>, default_secs: u64) -> Option<Duration> {
    match raw.map(str::trim).filter(|s| !s.is_empty()) {
        Some(s) => match s.parse::<u64>() {
            Ok(0) => None,
            Ok(secs) => Some(Duration::from_secs(secs)),
            Err(_) => Some(Duration::from_secs(default_secs)),
        },
        None => Some(Duration::from_secs(default_secs)),
    }
}

/// 超时等待 future:Some → 到点完成触发空闲中止;None → 永不完成。
async fn idle_future(d: Option<Duration>) {
    match d {
        Some(d) => tokio::time::sleep(d).await,
        None => std::future::pending::<()>().await,
    }
}

/// 泛型流式执行:逐条消费 stream,文本增量与工具调用经 `on_event` 上报。
async fn stream_one<M, F>(
    agent: &Agent<M>,
    question: &str,
    history: &[Message],
    cancel: &mut tokio::sync::watch::Receiver<bool>,
    on_event: &mut F,
) -> Result<Option<String>>
where
    M: CompletionModel + 'static,
    M::StreamingResponse: GetTokenUsage,
    F: FnMut(RunEvent),
{
    let mut stream = agent.stream_chat(question, history.to_vec()).await;
    let mut out = String::new();
    // token 用量(rig 原生 Usage):多轮工具循环中每次 completion 调用都会
    // 重发全部历史并各自上报 usage,用 rig 的 AddAssign 累计整轮消耗;
    // 最后一次调用的 input + output 即当前上下文窗口的实际占用。
    let mut last_usage = rig::completion::Usage::new();
    let mut total_usage = rig::completion::Usage::new();
    // 本 run 的 completion 调用次数(每次 LLM API 请求完成记 1,
    // 即 rig 日志 "Current conversation Turns" 的计数值)
    let mut turns: u64 = 0;
    // tool_call id → 工具名,供 ToolResult 上报时配对
    let mut tool_names: HashMap<String, String> = HashMap::new();
    // 已发出 ToolCall、尚未收到 ToolResult 的 call id:非空说明工具在执行
    // (question 等用户回答、长命令),此阶段不施加空闲超时。
    let mut running_tools: HashSet<String> = HashSet::new();
    loop {
        // 空闲超时兜底:仅在等待模型响应时启用。rig 的 openai 兼容流对
        // `data: [DONE]` 只跳过不终结,turn 要等 HTTP 连接真正关闭才结束;
        // 若 provider/网关保持连接不关,run 会永久挂起。超时触发即中止并报错,
        // 而不是让前端无限等待。
        let idle = idle_timeout(running_tools.is_empty());
        let item = tokio::select! {
            _ = cancel.changed() => {
                if *cancel.borrow() {
                    return Ok(None);
                }
                continue;
            }
            item = stream.next() => Some(item),
            // 无超时(工具执行中 / 显式关闭)时 pending 永不完成
            _ = idle_future(idle) => None,
        };
        let item = match item {
            Some(item) => item,
            None => {
                let secs = idle.map(|d| d.as_secs()).unwrap_or(0);
                return Err(anyhow::anyhow!(
                    "模型响应空闲超过 {secs} 秒仍未返回(可能是 provider 流未正常关闭),\
                     已中止本次运行。可设置环境变量 COMBO_STREAM_IDLE_TIMEOUT 调整秒数,设 0 关闭"
                ));
            }
        };
        let Some(item) = item else { break };
        match item? {
            MultiTurnStreamItem::StreamAssistantItem(StreamedAssistantContent::Text(t)) => {
                out.push_str(&t.text);
                on_event(RunEvent::TextDelta(t.text));
            }
            MultiTurnStreamItem::StreamAssistantItem(StreamedAssistantContent::ReasoningDelta {
                reasoning,
                ..
            }) => {
                on_event(RunEvent::ReasoningDelta(reasoning));
            }
            MultiTurnStreamItem::StreamAssistantItem(StreamedAssistantContent::Reasoning(
                reasoning,
            )) => {
                // 部分 provider 一次性下发完整 reasoning 块而非增量
                let display = reasoning.display_text();
                if !display.is_empty() {
                    on_event(RunEvent::ReasoningDelta(display));
                }
            }
            MultiTurnStreamItem::StreamAssistantItem(StreamedAssistantContent::ToolCall {
                tool_call,
                ..
            }) => {
                let input = tool_call.function.arguments.to_string();
                tool_names.insert(tool_call.id.clone(), tool_call.function.name.clone());
                running_tools.insert(tool_call.id.clone());
                on_event(RunEvent::ToolCall {
                    id: tool_call.id,
                    name: tool_call.function.name,
                    input,
                });
            }
            MultiTurnStreamItem::StreamUserItem(StreamedUserContent::ToolResult {
                tool_result,
                ..
            }) => {
                let name = tool_names
                    .get(&tool_result.id)
                    .cloned()
                    .unwrap_or_default();
                // text / json 内容块都转成字符串;image 块跳过。bash 工具返回
                // 结构化 JSON({content, exit_code, timed_out, duration_ms}),
                // 解析出干净内容与状态标记,其余工具原样拼接。
                let mut content = String::new();
                let mut is_error = false;
                let mut exit_code: Option<i32> = None;
                let mut timed_out = false;
                let mut duration_ms: Option<u64> = None;
                for c in tool_result.content.iter() {
                    match c {
                        ToolResultContent::Text(t) => content.push_str(&t.text),
                        ToolResultContent::Json { value } => {
                            if name == "bash" {
                                if let Some(inner) = value.get("content").and_then(Value::as_str) {
                                    content.push_str(inner);
                                }
                                if let Some(code) = value.get("exit_code").and_then(Value::as_i64) {
                                    exit_code = Some(code as i32);
                                }
                                if value
                                    .get("timed_out")
                                    .and_then(Value::as_bool)
                                    .unwrap_or(false)
                                {
                                    timed_out = true;
                                }
                                if let Some(ms) = value.get("duration_ms").and_then(Value::as_u64) {
                                    duration_ms = Some(ms);
                                }
                            } else {
                                content.push_str(&value.to_string());
                            }
                        }
                        ToolResultContent::Image(_) => {}
                    }
                }
                // 仅当明确拿到非 0 退出码或超时才视为失败;无退出码字段的
                // 工具(question 等)不受影响
                if tool_result_is_error(exit_code, timed_out) {
                    is_error = true;
                }
                running_tools.remove(&tool_result.id);
                on_event(RunEvent::ToolResult {
                    id: tool_result.id,
                    name,
                    content,
                    is_error,
                    exit_code,
                    timed_out,
                    duration_ms,
                });
            }
            MultiTurnStreamItem::CompletionCall(call) => {
                // 每个 CompletionCall 项 = 一次真实的 completion API 调用完成
                // (多轮工具循环每轮一条;usage 可能缺报,调用次数独立累计)
                turns += 1;
                on_event(RunEvent::Turns(turns));
                // 零值 usage 是 rig 约定的"provider 未上报"哨兵
                if call.usage.has_values() {
                    total_usage += call.usage; // rig 原生累计(AddAssign)
                    last_usage = call.usage;
                }
            }
            _ => {}
        }
    }
    // turns > 0 也视为有效 run(provider 不上报 usage 时仍需播报调用次数)
    if total_usage.has_values() || turns > 0 {
        on_event(RunEvent::Usage(RunUsage::new(last_usage, total_usage, turns)));
    }
    Ok(Some(out))
}

/// 交互式多轮会话:读取 stdin,流式输出,消息持久化到 sqlite。
pub async fn chat_loop(cfg: &AskConfig) -> Result<()> {
    // 加载当前目录的 AGENTS.md(项目基础规则)进 preamble。
    let cfg = cfg.with_workspace(std::env::current_dir().ok(), &[]);
    log_llm_request(&cfg);
    let model = cfg.model.clone();
    let builtin = if cfg.tools {
        crate::tools::builtin_tools(std::env::current_dir().ok(), cfg.lsp.clone())
    } else {
        Vec::new()
    };
    let mcp_cfg = cfg.mcp_specs();
    let preamble = cfg.preamble.clone();
    let provider_id = cfg.provider.id.clone();
    let ptype = cfg.provider.provider_type.clone().unwrap_or_else(|| "openai".into());
    let effort = cfg.reasoning_effort.as_deref();

    // 新建一个会话
    let db = db::CliDb::open(&db::default_db_path())?;
    let session_id = uuid::Uuid::new_v4().to_string();
    db.create_conversation(&session_id, "cli 会话", &provider_id, &model)?;
    println!("会话已创建:{session_id}(Ctrl-D 退出)");

    let mut history: Vec<Message> = Vec::new();
    let (agent, mcp_conn): (Box<dyn AnyAgent>, Option<McpConnection>) = match ptype.as_str() {
        "anthropic" => {
            let client = rig::providers::anthropic::Client::from_env()?;
            let (a, m) = build_agent(client, &model, &preamble, builtin, mcp_cfg, effort).await?;
            (Box::new(Arc::new(a)), m)
        }
        "google" => {
            let client = rig::providers::gemini::Client::from_env()?;
            let (a, m) = build_agent(client, &model, &preamble, builtin, mcp_cfg, effort).await?;
            (Box::new(Arc::new(a)), m)
        }
        _ => {
            let key = cfg.api_key()?;
            let base = cfg.endpoint();
            let builder = rig::providers::openai::CompletionsClient::builder()
                .api_key(key)
                .base_url(base);
            let client = builder
                .build()
                .map_err(|e| anyhow::anyhow!("创建 client 失败: {e}"))?;
            let (a, m) = build_agent(client, &model, &preamble, builtin, mcp_cfg, effort).await?;
            (Box::new(Arc::new(a)), m)
        }
    };
    // 保持 MCP 连接存活到会话结束
    let _mcp_conn = mcp_conn;

    use std::io::{BufRead, Write};
    let stdin = std::io::stdin();
    let mut input = stdin.lock();

    loop {
        print!("你: ");
        std::io::stdout().flush()?;
        let mut line = String::new();
        if input.read_line(&mut line)? == 0 {
            break; // EOF
        }
        let line = line.trim().to_string();
        if line.is_empty() {
            continue;
        }
        if line == "exit" || line == "退出" {
            break;
        }

        // 持久化用户消息
        db.append_message(&session_id, "user", &line)?;
        history.push(Message::user(&line));

        print!("助手: ");
        std::io::stdout().flush()?;
        let answer = agent
            .chat_stream(&line, &history, &db, &session_id)
            .await?;
        history.push(Message::assistant(&answer));
        println!();
    }
    println!("\n会话结束,记录已保存。");
    Ok(())
}

/// 盒子化 agent 的统一接口(供 chat_loop 使用)。
#[async_trait::async_trait]
trait AnyAgent: Send + Sync {
    async fn chat_stream(
        &self,
        question: &str,
        history: &[Message],
        db: &db::CliDb,
        session_id: &str,
    ) -> Result<String>;
}

#[async_trait::async_trait]
impl<M> AnyAgent for Arc<Agent<M>>
where
    M: CompletionModel + Send + Sync + 'static,
    M::StreamingResponse: GetTokenUsage,
{
    async fn chat_stream(
        &self,
        question: &str,
        history: &[Message],
        db: &db::CliDb,
        session_id: &str,
    ) -> Result<String> {
        let mut stream = self.stream_chat(question, history.to_vec()).await;
        let mut out = String::new();
        while let Some(item) = stream.next().await {
            match item? {
                MultiTurnStreamItem::StreamAssistantItem(StreamedAssistantContent::Text(t)) => {
                    out.push_str(&t.text);
                    print!("{}", t.text);
                    std::io::Write::flush(&mut std::io::stdout()).ok();
                }
                MultiTurnStreamItem::StreamAssistantItem(StreamedAssistantContent::ToolCall {
                    ..
                }) => {
                    // 工具调用结果会由 rig 自动回填,这里可提示
                }
                _ => {}
            }
        }
        db.append_message(session_id, "assistant", &out)?;
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn idle_timeout_from_parses_env_override() {
        // 未设置 → 默认 300s
        assert_eq!(idle_timeout_from(None, 300), Some(Duration::from_secs(300)));
        // 数字 → 覆盖
        assert_eq!(
            idle_timeout_from(Some("90"), 300),
            Some(Duration::from_secs(90))
        );
        // 0 → 关闭(不设超时)
        assert_eq!(idle_timeout_from(Some("0"), 300), None);
        // 空串 / 纯空白 / 非法值 → 回退默认
        assert_eq!(
            idle_timeout_from(Some(""), 300),
            Some(Duration::from_secs(300))
        );
        assert_eq!(
            idle_timeout_from(Some("  "), 300),
            Some(Duration::from_secs(300))
        );
        assert_eq!(
            idle_timeout_from(Some("abc"), 300),
            Some(Duration::from_secs(300))
        );
    }

    #[test]
    fn idle_timeout_disabled_while_tools_running() {
        // 工具执行中(question 等待用户回答可能数分钟)不施加空闲超时
        assert_eq!(idle_timeout(false), None);
    }

    #[test]
    fn tool_result_error_status_only_for_bash_failures() {
        // question 等无退出码字段的工具:用户正常回答不算失败
        assert!(!tool_result_is_error(None, false));
        // bash 成功
        assert!(!tool_result_is_error(Some(0), false));
        // bash 退出码非 0 / 超时 → 失败
        assert!(tool_result_is_error(Some(1), false));
        assert!(tool_result_is_error(Some(7), false));
        assert!(tool_result_is_error(None, true));
        assert!(tool_result_is_error(Some(0), true));
    }
}
