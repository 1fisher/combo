//! LSP 支持:配置与 crush 同格式的 LSP server(command/args/env),
//! 提供 `lsp list`(查看已配置 server 与可执行状态)。
//!
//! combo-cli 本身不内嵌完整 LSP 客户端;本模块负责 server 配置、
//! 可执行性检查与进程探测,供后续接入代码诊断等能力。

use crate::config::ResolvedConfig;
use anyhow::Result;
use std::path::PathBuf;

/// 一个 LSP server 的状态。
#[allow(dead_code)]
pub struct LspStatus {
    pub name: String,
    pub command: String,
    pub executable: bool,
    pub path: Option<PathBuf>,
}

/// 列出配置的 LSP server 及其可执行状态(供 `lsp list` 使用)。
pub fn list(cfg: &ResolvedConfig) -> Result<()> {
    if cfg.lsp.is_empty() {
        println!("未配置 LSP server(配置文件的 [lsp] 字段,格式同 crush)");
        return Ok(());
    }
    println!("已配置 {} 个 LSP server:", cfg.lsp.len());
    for (name, srv) in &cfg.lsp {
        let exe = find_executable(&srv.command);
        match &exe {
            Some(p) => println!("  {}  {}  ✓ {}", name, srv.command, p.display()),
            None => println!("  {}  {}  ✗ 未找到", name, srv.command),
        }
    }
    Ok(())
}

/// 按 PATH 查找可执行文件。
fn find_executable(cmd: &str) -> Option<PathBuf> {
    if cmd.contains('/') {
        let p = PathBuf::from(cmd);
        return p.is_file().then_some(p);
    }
    let path = std::env::var("PATH").unwrap_or_default();
    for dir in path.split(':') {
        let p = PathBuf::from(dir).join(cmd);
        if p.is_file() {
            return Some(p);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_executable_on_path() {
        // 一定存在且带斜杠的命令
        assert!(find_executable("/bin/ls").is_some());
        assert!(find_executable("/nonexistent/xyz").is_none());
    }
}
