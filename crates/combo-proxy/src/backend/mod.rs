pub mod claude_code;
pub mod codex;
pub mod combo_cli;
pub mod crush;
pub mod http;
pub mod opencode;

use anyhow::Result;
use axum::http::{HeaderMap, Method};
use axum::response::Response;
use std::path::PathBuf;

/// 标识当前使用的 agent 后端类型。
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BackendType {
    /// 自有 agent(combo-cli serve,默认)。
    ComboCli,
    Crush,
    OpenCode,
    ClaudeCode,
    Codex,
}

impl BackendType {
    /// 序列化为与 wire/URL 一致的字符串。
    pub fn as_str(&self) -> &'static str {
        match self {
            BackendType::ComboCli => "combo-cli",
            BackendType::Crush => "crush",
            BackendType::OpenCode => "opencode",
            BackendType::ClaudeCode => "claude_code",
            BackendType::Codex => "codex",
        }
    }

    /// 解析后端字符串,未知值回退到 ComboCli(默认 agent)。
    pub fn parse(s: &str) -> BackendType {
        match s {
            "crush" => BackendType::Crush,
            "opencode" => BackendType::OpenCode,
            "claude_code" => BackendType::ClaudeCode,
            "codex" => BackendType::Codex,
            // combo-cli 及历史拼写都归一化到 ComboCli
            "combo-cli" | "combo_cli" | "combocli" => BackendType::ComboCli,
            _ => BackendType::ComboCli,
        }
    }
}

/// combo-proxy 面向 agent 后端的统一接口。
///
/// 每个后端(crush、opencode、claude code 等)各自实现此 trait。
/// 路由层仅调用 `&self` 方法;进程生命周期(启动/关闭)在 Backend
/// 被 `Arc` 包装之前由调用方处理。
#[async_trait::async_trait]
pub trait Backend: Send + Sync {
    /// 当前后端类型。
    fn backend_type(&self) -> BackendType;

    /// 转发原始 HTTP 请求到后端,返回流式响应(SSE 体不缓冲)。
    async fn forward(
        &self,
        method: Method,
        path_query: &str,
        headers: &HeaderMap,
        body: Vec<u8>,
    ) -> Result<Response>;

    /// 根据 workspace id 解析其文件系统根目录。
    async fn workspace_root(&self, id: &str) -> Result<PathBuf>;

    /// 后端是否健康/可达。
    async fn health(&self) -> bool;
}
