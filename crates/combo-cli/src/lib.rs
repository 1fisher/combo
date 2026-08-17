//! combo-cli 库入口:serve 服务模式(combo 全部 REST/WS 端点)+
//! 会话/文件/auth/workspace 等模块。供 src-tauri 内嵌调用或外部集成。

pub mod agent;
pub mod agents_md;
pub mod auth;
pub mod automation;
pub mod binpath;
pub mod compact;
pub mod config;
pub mod db;
pub mod fs;
pub mod git;
pub mod host;
pub mod lan;
pub mod lsp;
pub mod mcp;
pub mod meta;
pub mod p2p;
pub mod paths;
pub mod providers;
pub mod question;
pub mod relay;
pub mod request_log;
pub mod serve;
pub mod session;
pub mod skills;
pub mod skills_api;
pub mod store;
pub mod terminal;
pub mod todo;
pub mod tools;
pub mod tunnel;
pub mod workspace;

pub use serve::{AppState, run, serve_listener};