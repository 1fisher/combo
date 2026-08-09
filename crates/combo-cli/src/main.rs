//! combo-cli:combo 自有 agent 命令行工具。
//! 基于 rig 0.41,支持多 provider(openai/anthropic/gemini/ollama/deepseek)、
//! 内置工具 + MCP 工具、sqlite 会话持久化,以及 serve 服务模式
//! (RuneManager 式进程管理,health + control 端点,供 combo-proxy 托管)。

mod agent;
mod config;
mod db;
mod lsp;
mod mcp;
mod providers;
mod serve;
mod skills;
mod tools;

use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(
    name = "combo-cli",
    version,
    about = "combo 自有 agent CLI(rig 驱动)"
)]
struct Cli {
    /// 模型提供商(openai/anthropic/gemini/ollama/deepseek);未指定时读配置文件
    #[arg(long, global = true)]
    provider: Option<String>,

    /// 模型名称(默认按提供商取)
    #[arg(long, global = true)]
    model: Option<String>,

    /// 系统提示词;未指定时读配置文件
    #[arg(long, global = true)]
    preamble: Option<String>,

    /// 内置工具开关(当前时间/日期等),默认开启
    #[arg(long, global = true)]
    tools: Option<bool>,

    /// MCP server 命令(stdio),如 "npx -y @modelcontextprotocol/server-filesystem /tmp"
    #[arg(long, global = true)]
    mcp_command: Option<String>,

    /// MCP server URL(streamable HTTP),如 http://127.0.0.1:3001/mcp
    #[arg(long, global = true)]
    mcp_url: Option<String>,

    /// 配置文件路径(默认 ~/.config/combo/combo-cli.toml)
    #[arg(long, global = true)]
    config: Option<std::path::PathBuf>,

    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// 单轮问答
    Ask {
        /// 问题内容
        question: String,
    },
    /// 交互式多轮会话(历史持久化到 sqlite,流式输出)
    Chat,
    /// 会话管理(列/看/删)
    Sessions {
        #[command(subcommand)]
        action: SessionsAction,
    },
    /// 以服务模式运行(health + control 端点,RuneManager 式进程管理)
    Serve {
        /// 监听端口(默认 0 = 随机)
        #[arg(long, default_value_t = 0)]
        port: u16,
        /// 监听地址
        #[arg(long, default_value = "127.0.0.1")]
        host: String,
    },
    /// 配置文件管理(显示路径/重新生成)
    Config {
        #[command(subcommand)]
        action: ConfigAction,
    },
    /// 查看可用 skills(扫描配置的 skills 路径)
    Skills {
        #[command(subcommand)]
        action: SkillsAction,
    },
    /// LSP server 管理(查看配置与可执行状态)
    Lsp {
        #[command(subcommand)]
        action: LspAction,
    },
}

#[derive(Subcommand)]
enum SessionsAction {
    /// 列出所有会话
    List,
    /// 查看某个会话的消息
    Show {
        /// 会话 id
        id: String,
    },
    /// 删除会话
    Rm {
        /// 会话 id
        id: String,
    },
}

#[derive(Subcommand)]
enum ConfigAction {
    /// 显示配置文件路径与当前生效配置
    Path,
    /// 重新生成默认配置文件(覆盖已有文件)
    Init,
    /// 从 opencode auth.json 导入 API key 到配置文件
    Import,
}

#[derive(Subcommand)]
enum SkillsAction {
    /// 列出扫描到的 skills
    List,
}

#[derive(Subcommand)]
enum LspAction {
    /// 列出配置的 LSP server 与可执行状态
    List,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();
    // 自动加载/生成配置文件(用户目录),命令行参数优先于文件
    let config_path = cli
        .config
        .clone()
        .unwrap_or_else(config::default_config_path);
    // 先加载同目录 .env(为 $ENV_VAR 形式的 key/base_url 提供默认值,
    // 也供下方 tracing 的 RUST_LOG 使用),再初始化日志与读配置文件
    config::load_dotenv(&config_path);

    tracing_subscriber::fmt()
        .with_max_level(tracing::Level::INFO)
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let file_cfg = config::AppConfig::load_or_create(&config_path)?;
    let resolved = file_cfg.resolve(
        cli.provider.as_deref(),
        cli.model.as_deref(),
        cli.preamble.as_deref(),
        cli.tools,
        cli.mcp_command.as_deref(),
        cli.mcp_url.as_deref(),
    );

    // 只有显式传了 --config 时才提示配置文件位置,避免每次运行刷屏
    if cli.config.is_some() {
        tracing::info!("使用配置文件:{}", config_path.display());
    }

    let provider_id = resolved.provider.clone();
    // 解析 provider:自定义配置列表 → crush providers.json → 内置
    let provider = providers::find_provider(&provider_id, &resolved.providers)?;
    let cfg = agent::AskConfig::from_resolved(&resolved, provider);

    match &cli.command {
        Command::Ask { question } => {
            agent::ask_with(&cfg, question).await?;
        }
        Command::Chat => {
            agent::chat_loop(&cfg).await?;
        }
        Command::Sessions { action } => match action {
            SessionsAction::List => db::list_sessions()?,
            SessionsAction::Show { id } => db::show_session(id)?,
            SessionsAction::Rm { id } => db::rm_session(id)?,
        },
        Command::Serve { port, host } => {
            serve::run(&cfg, host.clone(), *port).await?;
        }
        Command::Config { action } => match action {
            ConfigAction::Path => config::print_path(&config_path)?,
            ConfigAction::Init => {
                config::write_default(&config_path, true)?;
                println!("已重新生成配置文件:{}", config_path.display());
            }
            ConfigAction::Import => {
                config::import_opencode_key(&config_path)?;
            }
        },
        Command::Skills { action } => match action {
            SkillsAction::List => skills::list(&resolved)?,
        },
        Command::Lsp { action } => match action {
            LspAction::List => lsp::list(&resolved)?,
        },
    }
    Ok(())
}
