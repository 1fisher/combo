//! combo-cli serve 进程守护(ComboCliManager)。
//!
//! 启动 `combo-cli serve`(默认监听随机端口),解析 stdout 输出的
//! `COMBO_CLI_PORT=` 得到实际端口,轮询 `/v1/health` 直至就绪;
//! 失败自动重启,退出时经 `/v1/control` 优雅关闭。

use crate::backend::http::ProxyClient;
use crate::upstream::Upstream;
use anyhow::Result;
use axum::http::Method;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, ChildStdout, Command};
use tokio::sync::Mutex as AsyncMutex;
use tokio::time::timeout;

/// 启动 combo-cli serve 的默认二进制名。
pub const DEFAULT_BIN: &str = "combo-cli";

/// 轮询 `probe` 直到返回 true,最多 `max_attempts` 次,间隔 `interval`。
async fn poll_until<F, Fut>(mut probe: F, max_attempts: usize, interval: Duration) -> bool
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = bool>,
{
    use tokio::time::sleep;
    for _ in 0..max_attempts {
        if probe().await {
            return true;
        }
        sleep(interval).await;
    }
    probe().await
}

/// combo-cli serve 进程守护。内部用 `Mutex` 实现 `&self` 可变性,
/// 可安全包装在 `Arc` 中跨任务共享(后台健康监控 + 优雅关闭)。
pub struct ComboCliManager {
    bin: String,
    log_path: PathBuf,
    child: Mutex<Option<Child>>,
    /// 当前 combo-cli 监听地址(127.0.0.1:<port>)。共享单元格供
    /// ComboCliBackend 实时解析(重启换端口后后端自动生效)。
    addr: Arc<Mutex<Option<std::net::SocketAddr>>>,
    /// 串行化 `ensure_running`,防止多个调用者同时启动。
    op_lock: AsyncMutex<()>,
}

impl ComboCliManager {
    pub fn new(bin: String) -> Self {
        let log_path = std::env::temp_dir().join("combo-cli.log");
        Self {
            bin,
            log_path,
            child: Mutex::new(None),
            addr: Arc::new(Mutex::new(None)),
            op_lock: AsyncMutex::new(()),
        }
    }

    pub fn log_path(&self) -> &Path {
        &self.log_path
    }

    /// 当前监听地址(未启动/未知时为 None)。
    pub fn addr(&self) -> Option<std::net::SocketAddr> {
        *self.addr.lock().unwrap()
    }

    /// 共享地址单元格(供 ComboCliBackend::new_resolving 实时解析)。
    pub fn addr_shared(&self) -> Arc<Mutex<Option<std::net::SocketAddr>>> {
        Arc::clone(&self.addr)
    }

    /// 确保 combo-cli serve 健康运行:复用已就绪实例,否则启动新进程并
    /// 等待就绪(解析 `COMBO_CLI_PORT=`,轮询 /v1/health,最多 15s)。
    pub async fn ensure_running(&self) -> Result<std::net::SocketAddr> {
        let _guard = self.op_lock.lock().await;
        let addr_now = *self.addr.lock().unwrap();
        if let Some(addr) = addr_now {
            if self.health_at(addr).await {
                return Ok(addr);
            }
        }

        // 先清理上一轮残留的子进程(可能已 crash 但端口记录残留)
        let old_child = { self.child.lock().unwrap().take() };
        if let Some(mut c) = old_child {
            let _ = c.kill().await;
            let _ = c.wait().await;
        }

        let log = std::fs::File::create(&self.log_path)?;
        let stderr = Stdio::from(log);
        let mut spawned = Command::new(&self.bin)
            .arg("serve")
            .stdout(Stdio::piped())
            .stderr(stderr)
            .spawn()
            .map_err(|e| anyhow::anyhow!("failed to spawn {}: {e}", self.bin))?;
        let stdout = spawned
            .stdout
            .take()
            .ok_or_else(|| anyhow::anyhow!("{0} serve 未提供 stdout", self.bin))?;

        let addr = match parse_port(stdout, Duration::from_secs(15)).await {
            Some(port) => std::net::SocketAddr::from(([127, 0, 0, 1], port)),
            None => {
                let _ = spawned.kill().await;
                anyhow::bail!(
                    "combo-cli serve 未在 15s 内输出端口;日志: {}",
                    self.log_path.display()
                );
            }
        };
        *self.child.lock().unwrap() = Some(spawned);
        *self.addr.lock().unwrap() = Some(addr);

        let ready = poll_until(|| self.health_at(addr), 30, Duration::from_millis(500)).await;
        if !ready {
            anyhow::bail!(
                "combo-cli serve 未在 15s 内就绪;日志: {}",
                self.log_path.display()
            );
        }
        Ok(addr)
    }

    /// 快速健康检查(不加 op_lock,不阻塞 ensure_running)。
    pub async fn is_healthy(&self) -> bool {
        match self.addr() {
            Some(addr) => self.health_at(addr).await,
            None => false,
        }
    }

    async fn health_at(&self, addr: std::net::SocketAddr) -> bool {
        let upstream = Upstream::Tcp(addr);
        let client = ProxyClient::for_upstream(&upstream);
        client.check_health(&upstream).await
    }

    /// 优雅关闭:POST /v1/control,等待 5s,超时后 kill。
    pub async fn shutdown(&self) -> Result<()> {
        let addr_now = *self.addr.lock().unwrap();
        if let Some(addr) = addr_now {
            let upstream = Upstream::Tcp(addr);
            let client = ProxyClient::for_upstream(&upstream);
            let _ = client
                .forward(&upstream, Method::POST, "/v1/control", &Default::default(), Vec::new())
                .await;
        }

        let mut child_opt = { self.child.lock().unwrap().take() };
        if let Some(mut child) = child_opt.take() {
            match timeout(Duration::from_secs(5), child.wait()).await {
                Ok(_) => {}
                Err(_) => {
                    let _ = child.kill().await;
                    let _ = child.wait().await;
                }
            }
        }
        Ok(())
    }
}

/// 守护对象析构时强杀子进程,避免测试/退出残留孤儿进程。
impl Drop for ComboCliManager {
    fn drop(&mut self) {
        if let Some(mut child) = self.child.lock().unwrap().take() {
            let _ = child.start_kill();
        }
    }
}

/// 从 stdout 读取 `COMBO_CLI_PORT=<port>` 行。读完后把剩余输出交给后台任务
/// 排空,避免管道写满阻塞子进程。超时返回 None。
async fn parse_port(stdout: ChildStdout, dur: Duration) -> Option<u16> {
    let mut reader = BufReader::new(stdout);
    let deadline = tokio::time::Instant::now() + dur;
    let mut line = String::new();
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            break;
        }
        let n = match timeout(remaining, reader.read_line(&mut line)).await {
            Ok(Ok(n)) => n,
            _ => break,
        };
        if n == 0 {
            break; // EOF
        }
        if let Some(rest) = line.strip_prefix("COMBO_CLI_PORT=") {
            if let Ok(port) = rest.trim().parse::<u16>() {
                // 剩余输出交给后台任务排空(子进程之后几乎不再写 stdout)
                tokio::spawn(async move {
                    let mut l = String::new();
                    while let Ok(n) = reader.read_line(&mut l).await {
                        if n == 0 {
                            break;
                        }
                        l.clear();
                    }
                });
                return Some(port);
            }
        }
        line.clear();
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn parse_port_extracts_port_line() {
        // 假子进程:先打印端口行,再保持运行
        let mut child = Command::new("sh")
            .arg("-c")
            .arg("echo COMBO_CLI_PORT=12345; sleep 30")
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let stdout = child.stdout.take().unwrap();
        let port = parse_port(stdout, Duration::from_secs(5)).await;
        assert_eq!(port, Some(12345));
        let _ = child.kill().await;
        let _ = child.wait().await;
    }
}
