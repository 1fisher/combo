//! MCP(Model Context Protocol)工具集成。
//! 支持 stdio(子进程命令)与 streamable HTTP 两种 transport;
//! 通过 rig 的 ToolServer + McpClientHandler 自动注册工具并保持连接存活。

use rig::tool::rmcp::McpClientHandler;
use rig::tool::server::{ToolServer, ToolServerHandle};
use rmcp::model::ClientInfo;
use rmcp::transport::TokioChildProcess;
use rmcp::service::{RoleClient, RunningService};

type McpRunning = RunningService<RoleClient, McpClientHandler>;

/// 一个已连接的 MCP 服务。持有 RunningService 保证连接不因 Drop 关闭。
pub struct McpConnection {
    /// ToolServerHandle:agent 通过它读取工具集。
    #[allow(dead_code)]
    pub handle: ToolServerHandle,
    /// 持有存活中的服务(字段不读取,仅防 Drop)。
    _running: Vec<McpRunning>,
}

impl McpConnection {
    /// 取出内部 RunningService(供组合时合并持有)。
    pub fn take_running(&mut self) -> Vec<McpRunning> {
        std::mem::take(&mut self._running)
    }

    /// 用多个已连接服务构造(共享 handle)。
    pub fn from_many(handle: ToolServerHandle, conns: Vec<McpConnection>) -> Self {
        let mut running = Vec::new();
        for mut c in conns {
            running.extend(c.take_running());
        }
        McpConnection {
            handle,
            _running: running,
        }
    }
}

/// 建立单个 MCP 连接。`command` 与 `url` 二选一(都提供时优先 command)。
/// `name` 仅用于日志。
pub async fn connect_one(
    name: &str,
    command: Option<&str>,
    url: Option<&str>,
    handle: ToolServerHandle,
) -> anyhow::Result<McpConnection> {
    let client_info = ClientInfo::default();
    let handler = McpClientHandler::new(client_info, handle.clone());
    let mut running: Vec<McpRunning> = Vec::new();

    if let Some(cmd) = command {
        tracing::info!("连接 MCP[{name}](stdio):{cmd}");
        // 解析 shell 命令为 argv
        let argv = shell_words(cmd)?;
        let (prog, args) = argv
            .split_first()
            .ok_or_else(|| anyhow::anyhow!("MCP[{name}] 命令为空"))?;
        let mut process = tokio::process::Command::new(prog);
        process.args(args);
        let child = TokioChildProcess::new(process)?;
        let service = handler.connect(child).await?;
        running.push(service);
    } else if let Some(url) = url {
        tracing::info!("连接 MCP[{name}](http):{url}");
        use rmcp::transport::streamable_http_client::StreamableHttpClientWorker;
        let worker =
            StreamableHttpClientWorker::<reqwest::Client>::new_simple(url.to_string());
        let transport = rmcp::transport::streamable_http_client::StreamableHttpClientTransport::spawn(worker);
        let service = handler.connect(transport).await?;
        running.push(service);
    } else {
        anyhow::bail!("MCP[{name}] 连接需要 command 或 url");
    }

    Ok(McpConnection {
        handle,
        _running: running,
    })
}

/// 建立多个 MCP 连接(全部注册到同一 ToolServerHandle)。
/// `specs` 为 (name, command, url) 三元组;`skip_missing` 时单个失败仅告警。
pub async fn connect_many(
    specs: Vec<(String, Option<String>, Option<String>)>,
    handle: ToolServerHandle,
    skip_missing: bool,
) -> anyhow::Result<Vec<McpConnection>> {
    let mut conns = Vec::new();
    for (name, cmd, url) in specs {
        if cmd.is_none() && url.is_none() {
            continue;
        }
        match connect_one(&name, cmd.as_deref(), url.as_deref(), handle.clone()).await {
            Ok(c) => conns.push(c),
            Err(e) if skip_missing => {
                tracing::warn!("跳过 MCP[{name}]: {e}");
            }
            Err(e) => return Err(e),
        }
    }
    Ok(conns)
}

/// 简易 shell 分词:按空白拆分,支持单双引号。
pub(crate) fn shell_words(s: &str) -> anyhow::Result<Vec<String>> {
    let mut words = Vec::new();
    let mut cur = String::new();
    let mut quote: Option<char> = None;
    for c in s.chars() {
        match quote {
            Some(q) => {
                if c == q {
                    quote = None;
                } else {
                    cur.push(c);
                }
            }
            None => match c {
                '\'' | '"' => quote = Some(c),
                c if c.is_whitespace() => {
                    if !cur.is_empty() {
                        words.push(std::mem::take(&mut cur));
                    }
                }
                c => cur.push(c),
            },
        }
    }
    if quote.is_some() {
        anyhow::bail!("引号未闭合:{s}");
    }
    if !cur.is_empty() {
        words.push(cur);
    }
    Ok(words)
}

/// 创建带内置工具的 ToolServer 并返回其 handle。
pub fn tool_server_with_builtin(tools: &[rig::tool::DynamicTool]) -> ToolServerHandle {
    let mut server = ToolServer::new();
    for t in tools {
        server = server.dynamic_tool(t.clone());
    }
    server.run()
}

#[cfg(test)]
mod tests {
    use super::shell_words;

    #[test]
    fn parses_plain_args() {
        let w = shell_words("npx -y @modelcontextprotocol/server-filesystem /tmp").unwrap();
        assert_eq!(
            w,
            vec!["npx", "-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
        );
    }

    #[test]
    fn parses_quoted_args() {
        let w = shell_words("echo 'hello world' \"a b\"").unwrap();
        assert_eq!(w, vec!["echo", "hello world", "a b"]);
    }

    #[test]
    fn rejects_unclosed_quote() {
        assert!(shell_words("echo 'oops").is_err());
    }
}
