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
use rig::completion::{CompletionModel, GetTokenUsage, Message};
use rig::prelude::AgentClientExt;
use rig::streaming::{StreamedAssistantContent, StreamedUserContent, StreamingChat, StreamingPrompt};
use rig::tool::DynamicTool;
use std::path::PathBuf;
use std::sync::Arc;

/// 组装一个 agent:内置工具 + 可选 MCP 工具。
///
/// `client` 来自具体 provider;MCP 连接需要 ToolServerHandle 才能注册工具,
/// 所以先建 ToolServer(带内置工具),MCP 连接后 agent 用该 handle。
async fn build_agent<C>(
    client: C,
    model: &str,
    preamble: &str,
    builtin: Vec<DynamicTool>,
    mcp_specs: Vec<(String, Option<String>, Option<String>)>,
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
    let agent = client
        .agent(model)
        .preamble(preamble)
        .tool_server_handle(handle)
        .build();

    Ok((agent, mcp_conn))
}

/// 单轮问答配置。
/// 单轮问答配置:已解析出 provider 信息、模型、key、endpoint。
#[derive(Clone)]
pub struct AskConfig {
    pub provider: ProviderInfo,
    pub model: String,
    pub preamble: String,
    pub tools: bool,
    pub mcp_command: Option<String>,
    pub mcp_url: Option<String>,
    /// 显式 API key(配置文件 api_key 字段);优先于 provider 定义。
    pub explicit_api_key: Option<String>,
    /// 显式 base_url(配置文件 base_url 字段);优先于 provider 定义。
    pub explicit_base_url: Option<String>,
    /// 配置文件中的 MCP server 列表((name, command, url))。
    pub mcp_servers: Vec<(String, Option<String>, Option<String>)>,
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
            tools: r.tools,
            mcp_command: r.mcp_command.clone(),
            mcp_url: r.mcp_url.clone(),
            explicit_api_key: r.api_key.clone(),
            explicit_base_url: r.base_url.clone(),
            mcp_servers,
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
        // opencode zen(内置 id 或 crush 的 opencode-zen)回退到 opencode auth.json
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

/// 单轮问答:返回最终答案。
pub async fn ask_answer(
    cfg: &AskConfig,
    question: &str,
    workspace_dir: Option<PathBuf>,
) -> Result<String> {
    let builtin = if cfg.tools {
        crate::tools::builtin_tools(workspace_dir)
    } else {
        Vec::new()
    };
    let mcp = cfg.mcp_specs();
    let ptype = cfg.provider.provider_type.as_deref().unwrap_or("openai");

    match ptype {
        "anthropic" => {
            let client = rig::providers::anthropic::Client::from_env()?;
            let (agent, _mcp) =
                build_agent(client, &cfg.model, &cfg.preamble, builtin, mcp).await?;
            ask_one(&agent, question).await
        }
        "google" => {
            let client = rig::providers::gemini::Client::from_env()?;
            let (agent, _mcp) =
                build_agent(client, &cfg.model, &cfg.preamble, builtin, mcp).await?;
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
                build_agent(client, &cfg.model, &cfg.preamble, builtin, mcp).await?;
            ask_one(&agent, question).await
        }
    }
}

/// 单轮问答:直接打印最终结果。
pub async fn ask_with(cfg: &AskConfig, question: &str) -> Result<()> {
    let answer = ask_answer(cfg, question, std::env::current_dir().ok()).await?;
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

/// 流式运行事件(serve 模式转发为 SSE 事件)。
#[derive(Clone, Debug)]
pub enum RunEvent {
    /// 文本增量。
    TextDelta(String),
    /// 完整工具调用(rig 已执行并自动回填结果)。
    ToolCall { id: String, name: String, input: String },
    /// 工具执行结果。
    ToolResult { id: String, content: String },
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
    mut on_event: F,
) -> Result<Option<String>>
where
    F: FnMut(RunEvent),
{
    let builtin = if cfg.tools {
        crate::tools::builtin_tools(workspace_dir)
    } else {
        Vec::new()
    };
    let mcp = cfg.mcp_specs();
    let ptype = cfg.provider.provider_type.clone().unwrap_or_else(|| "openai".into());
    match ptype.as_str() {
        "anthropic" => {
            let client = rig::providers::anthropic::Client::from_env()?;
            let (agent, _mcp) = build_agent(client, &cfg.model, &cfg.preamble, builtin, mcp).await?;
            stream_one(&agent, question, history, &mut cancel, &mut on_event).await
        }
        "google" => {
            let client = rig::providers::gemini::Client::from_env()?;
            let (agent, _mcp) = build_agent(client, &cfg.model, &cfg.preamble, builtin, mcp).await?;
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
            let (agent, _mcp) = build_agent(client, &cfg.model, &cfg.preamble, builtin, mcp).await?;
            stream_one(&agent, question, history, &mut cancel, &mut on_event).await
        }
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
    loop {
        let item = tokio::select! {
            _ = cancel.changed() => {
                if *cancel.borrow() {
                    return Ok(None);
                }
                continue;
            }
            item = stream.next() => item,
        };
        let Some(item) = item else { break };
        match item? {
            MultiTurnStreamItem::StreamAssistantItem(StreamedAssistantContent::Text(t)) => {
                out.push_str(&t.text);
                on_event(RunEvent::TextDelta(t.text));
            }
            MultiTurnStreamItem::StreamAssistantItem(StreamedAssistantContent::ToolCall {
                tool_call,
                ..
            }) => {
                let input = tool_call.function.arguments.to_string();
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
                let content = tool_result
                    .content
                    .iter()
                    .filter_map(|c| c.as_text().map(|s| s.to_string()))
                    .collect::<Vec<_>>()
                    .join("\n");
                on_event(RunEvent::ToolResult {
                    id: tool_result.id,
                    content,
                });
            }
            _ => {}
        }
    }
    Ok(Some(out))
}

/// 交互式多轮会话:读取 stdin,流式输出,消息持久化到 sqlite。
pub async fn chat_loop(cfg: &AskConfig) -> Result<()> {
    let model = cfg.model.clone();
    let builtin = if cfg.tools {
        crate::tools::builtin_tools(std::env::current_dir().ok())
    } else {
        Vec::new()
    };
    let mcp_cfg = cfg.mcp_specs();
    let preamble = cfg.preamble.clone();
    let provider_id = cfg.provider.id.clone();
    let ptype = cfg.provider.provider_type.clone().unwrap_or_else(|| "openai".into());

    // 新建一个会话
    let db = db::CliDb::open(&db::default_db_path())?;
    let session_id = uuid::Uuid::new_v4().to_string();
    db.create_conversation(&session_id, "cli 会话", &provider_id, &model)?;
    println!("会话已创建:{session_id}(Ctrl-D 退出)");

    let mut history: Vec<Message> = Vec::new();
    let (agent, mcp_conn): (Box<dyn AnyAgent>, Option<McpConnection>) = match ptype.as_str() {
        "anthropic" => {
            let client = rig::providers::anthropic::Client::from_env()?;
            let (a, m) = build_agent(client, &model, &preamble, builtin, mcp_cfg).await?;
            (Box::new(Arc::new(a)), m)
        }
        "google" => {
            let client = rig::providers::gemini::Client::from_env()?;
            let (a, m) = build_agent(client, &model, &preamble, builtin, mcp_cfg).await?;
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
            let (a, m) = build_agent(client, &model, &preamble, builtin, mcp_cfg).await?;
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
