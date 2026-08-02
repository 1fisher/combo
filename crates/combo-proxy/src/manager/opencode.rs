//! OpenCode 服务器进程管理。
//! 启动 `opencode serve`,等待健康,关闭时 kill 进程。

use anyhow::Result;
use std::process::Stdio;
use std::time::Duration;
use tokio::process::{Child, Command};
use tokio::time::timeout;

pub struct OpenCodeManager {
    bin: String,
    port: u16,
    log_path: std::path::PathBuf,
    child: Option<Child>,
}

impl OpenCodeManager {
    pub fn new(bin: String) -> Self {
        let log_path = std::env::temp_dir().join("combo-opencode.log");
        Self {
            bin,
            port: 0,
            log_path,
            child: None,
        }
    }

    /// 返回 OpenCode server 的 base URL(启动后可用)。
    pub fn base_url(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }

    /// 启动 OpenCode server 并等待健康。
    pub async fn ensure_running(&mut self) -> Result<String> {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        self.port = listener.local_addr()?.port();
        drop(listener);

        let log = std::fs::File::create(&self.log_path)?;
        let stderr = Stdio::from(log);
        self.child = Some(
            Command::new(&self.bin)
                .arg("serve")
                .arg("--port")
                .arg(self.port.to_string())
                .arg("--hostname")
                .arg("127.0.0.1")
                .stdout(stderr)
                .stderr(Stdio::inherit())
                .spawn()
                .map_err(|e| anyhow::anyhow!("failed to spawn {}: {e}", self.bin))?,
        );

        let base_url = self.base_url();
        let ready = timeout(Duration::from_secs(15), poll_health(&base_url)).await;
        match ready {
            Ok(true) => Ok(base_url),
            _ => anyhow::bail!(
                "opencode server did not become healthy within 15s; log at {}",
                self.log_path.display()
            ),
        }
    }

    pub async fn shutdown(&mut self) -> Result<()> {
        if let Some(mut child) = self.child.take() {
            let _ = child.kill().await;
            let _ = child.wait().await;
        }
        Ok(())
    }
}

async fn poll_health(base_url: &str) -> bool {
    let url = format!("{}/global/health", base_url);
    loop {
        if let Ok(resp) = reqwest::get(&url).await {
            if resp.status().is_success() {
                return true;
            }
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}
