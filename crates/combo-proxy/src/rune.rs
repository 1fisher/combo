use crate::upstream::Upstream;
use anyhow::Result;
use http_body_util::Full;
use hyper_util::client::legacy::connect::HttpConnector;
use hyper_util::client::legacy::Client;
use hyper_util::rt::TokioExecutor;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Mutex;
use std::time::Duration;
use tokio::process::{Child, Command};
use tokio::sync::Mutex as AsyncMutex;
use tokio::time::{sleep, timeout};

/// Manages the rune (Crush) server subprocess lifecycle: ensures it is
/// running, waits until healthy, and shuts it down on exit.
///
/// 内部使用 `Mutex` 实现 `&self` 可变性,可安全包装在 `Arc` 中跨任务共享
/// (后台健康监控 + HTTP control 端点并发调用)。
pub struct RuneManager {
    bin: String,
    log_path: PathBuf,
    child: Mutex<Option<Child>>,
    /// 串行化 `ensure_running`,防止多个调用者同时启动 crush。
    op_lock: AsyncMutex<()>,
}

/// Polls `probe` until it returns true, up to `max_attempts` checks
/// spaced `interval` apart.
pub async fn poll_until<F, Fut>(mut probe: F, max_attempts: usize, interval: Duration) -> bool
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = bool>,
{
    for _ in 0..max_attempts {
        if probe().await {
            return true;
        }
        sleep(interval).await;
    }
    probe().await
}

fn uid() -> Option<String> {
    // `UID` is a bash-only variable (not exported), so read the real euid.
    Some(unsafe { libc::geteuid() }.to_string())
}

/// Replicates rune's default socket location:
/// `$XDG_RUNTIME_DIR`/`$TMPDIR`-fallback dir, named `crush-<uid>.sock`
/// (or `crush.sock` when the uid is unknown). Falls back to
/// `temp_dir()/crush-<uid>.sock` when the composed path would exceed
/// 104 bytes (macOS sun_path limit, kept for portability).
pub fn default_socket_path() -> PathBuf {
    let dir = std::env::var("XDG_RUNTIME_DIR")
        .ok()
        .filter(|d| !d.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    let name = match uid() {
        Some(u) => format!("crush-{u}.sock"),
        None => "crush.sock".to_string(),
    };
    let p = dir.join(&name);
    if p.as_os_str().len() > 104 {
        std::env::temp_dir().join(name)
    } else {
        p
    }
}

impl RuneManager {
    pub fn new(bin: String) -> Self {
        let log_path = std::env::temp_dir().join("combo-rune.log");
        Self {
            bin,
            log_path,
            child: Mutex::new(None),
            op_lock: AsyncMutex::new(()),
        }
    }

    pub fn log_path(&self) -> &Path {
        &self.log_path
    }

    /// Returns the socket path rune is expected to listen on.
    pub fn socket_path(&self) -> PathBuf {
        default_socket_path()
    }

    /// Ensures a healthy rune server: reuses one already listening on
    /// the default socket, otherwise spawns `bin server` and polls
    /// `/v1/health` until ready (up to 15s).
    pub async fn ensure_running(&self) -> Result<Upstream> {
        let _guard = self.op_lock.lock().await;
        let sock = default_socket_path();
        let upstream = Upstream::Unix(sock.clone());
        if self.health_check(&upstream).await {
            return Ok(upstream);
        }

        // 先清理上一轮残留的子进程(crush 可能已 crash 但 socket 残留)
        let old_child = { self.child.lock().unwrap().take() };
        if let Some(mut c) = old_child {
            let _ = c.kill().await;
            let _ = c.wait().await;
        }

        let log = std::fs::File::create(&self.log_path)?;
        let stderr = Stdio::from(log);
        let spawned = Command::new(&self.bin)
            .arg("server")
            .stdout(stderr)
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|e| anyhow::anyhow!("failed to spawn {}: {e}", self.bin))?;
        *self.child.lock().unwrap() = Some(spawned);

        let ready = poll_until(
            || self.health_check(&upstream),
            30,
            Duration::from_millis(500),
        )
        .await;
        if !ready {
            anyhow::bail!(
                "rune server did not become healthy within 15s; log at {}",
                self.log_path.display()
            );
        }
        Ok(upstream)
    }

    /// 快速健康检查(不加 op_lock,不阻塞 ensure_running)。
    pub async fn is_healthy(&self) -> bool {
        let upstream = Upstream::Unix(default_socket_path());
        self.health_check(&upstream).await
    }

    /// GET /v1/health over the upstream (Unix socket or TCP).
    pub async fn health_check(&self, upstream: &Upstream) -> bool {
        crate::backend::crush::check_health(upstream).await
    }

    /// Shuts the spawned rune server down: POST /v1/control shutdown,
    /// wait up to 5s, then kill as a fallback.
    pub async fn shutdown(&self) -> Result<()> {
        let sock = default_socket_path();
        let upstream = Upstream::Unix(sock);
        let _ = self.post_control_shutdown(&upstream).await;

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

    async fn post_control_shutdown(&self, upstream: &Upstream) -> Result<()> {
        let uri = match upstream {
            Upstream::Unix(path) => {
                let hex_host = hex::encode(path.to_string_lossy().as_bytes());
                format!("unix://{hex_host}/v1/control")
            }
            Upstream::Tcp(addr) => format!("http://{addr}/v1/control"),
        };
        let uri: hyper::Uri = uri.parse()?;
        let req = hyper::Request::builder()
            .method(hyper::Method::POST)
            .uri(uri)
            .header(hyper::header::CONTENT_TYPE, "application/json")
            .body(Full::new(bytes::Bytes::from_static(
                br#"{"command":"shutdown"}"#,
            )))?;
        let resp = match upstream {
            Upstream::Unix(_) => {
                let connector = hyperlocal::UnixConnector;
                let client: Client<_, Full<bytes::Bytes>> =
                    Client::builder(TokioExecutor::new()).build(connector);
                client.request(req).await?
            }
            Upstream::Tcp(_) => {
                let connector = HttpConnector::new();
                let client: Client<_, Full<bytes::Bytes>> =
                    Client::builder(TokioExecutor::new()).build(connector);
                client.request(req).await?
            }
        };
        let _ = resp.status();
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn health_polls_until_ok() {
        use std::cell::Cell;
        let calls = Cell::new(0);
        let probe = || async {
            calls.set(calls.get() + 1);
            calls.get() >= 3
        };
        let ok = poll_until(probe, 10, Duration::from_millis(1)).await;
        assert!(ok);
        assert_eq!(calls.get(), 3);
    }

    #[tokio::test]
    async fn health_gives_up_after_limit() {
        let ok = poll_until(|| async { false }, 5, Duration::from_millis(1)).await;
        assert!(!ok);
    }

    #[test]
    fn socket_path_is_absolute_with_crush_name() {
        let p = default_socket_path();
        assert!(p.is_absolute());
        assert!(p.file_name().unwrap().to_string_lossy().contains("crush"));
    }
}
