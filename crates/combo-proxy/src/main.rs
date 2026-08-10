use anyhow::Result;
use combo_proxy::combocli::ComboCliManager;
use combo_proxy::{serve, AppState, BackendRegistry, ClaudeCodeBackend, CodexBackend, ComboCliBackend, MetaStore, OpenCodeBackend, OpenCodeManager, RelayManager};
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::net::TcpListener;

#[tokio::main]
async fn main() -> Result<()> {
    let mut args = std::env::args().skip(1);
    let mut port: u16 = 0;
    let mut host: std::net::IpAddr = [127, 0, 0, 1].into();
    let mut host_explicit = false;
    let mut origins = Vec::new();
    let mut browse_root: Option<PathBuf> = None;
    let mut relay_url: Option<String> = None;
    let mut relay_token: Option<String> = None;
    while let Some(a) = args.next() {
        match a.as_str() {
            "--port" => port = args.next().unwrap().parse()?,
            "--host" => {
                host = args.next().unwrap().parse()?;
                host_explicit = true;
            }
            "--origin" => origins.push(args.next().unwrap()),
            "--browse-root" => browse_root = Some(args.next().unwrap().into()),
            "--relay" => relay_url = Some(args.next().unwrap()),
            "--relay-token" => relay_token = Some(args.next().unwrap()),
            _ => {}
        }
    }
    // --host 未显式传入时,读 COMBO_HOST 环境变量(支持域名部署绑定 0.0.0.0)。
    if !host_explicit {
        if let Ok(h) = std::env::var("COMBO_HOST") {
            if let Ok(parsed) = h.trim().parse::<std::net::IpAddr>() {
                host = parsed;
            }
        }
    }
    // 未显式传 --origin 时,允许用 COMBO_CORS_ORIGINS(逗号分隔)配置 CORS 白名单;
    // 两者都缺省时保持全开放(开发模式)。
    let origins = if origins.is_empty() {
        std::env::var("COMBO_CORS_ORIGINS")
            .map(|v| {
                v.split(',')
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .collect()
            })
            .unwrap_or_default()
    } else {
        origins
    };
    // --browse-root 未显式传入时,读环境变量 COMBO_BROWSE_ROOT。
    if browse_root.is_none() {
        browse_root = std::env::var("COMBO_BROWSE_ROOT")
            .ok()
            .filter(|s| !s.trim().is_empty())
            .map(PathBuf::from);
    }

    let mut registry = BackendRegistry::new();

    // 默认 agent:托管 combo-cli serve(本机自有 agent)。
    let combo_cli_mgr = Arc::new(ComboCliManager::new(
        std::env::var("COMBO_CLI_BIN").unwrap_or_else(|_| combo_proxy::combocli::DEFAULT_BIN.into()),
    ));
    let combo_cli_connected = match combo_cli_mgr.ensure_running().await {
        Ok(_) => {
            // 地址随重启实时解析(combo-cli 崩溃重启后端口会变)
            registry.set_combo_cli(Arc::new(ComboCliBackend::new_resolving(
                combo_cli_mgr.addr_shared(),
            )));
            println!("COMBO_CLI_STATUS=connected");
            true
        }
        Err(e) => {
            // combo-cli 不可用不致命:combo-cli workspace 转发会 502,前端显示不可用。
            eprintln!("COMBO_CLI_STATUS=failed: {e:?}");
            false
        }
    };

    // 可选:启动 OpenCode 后端
    if let Ok(oc_bin) = std::env::var("COMBO_OPENCODE_BIN") {
        let mut oc_mgr = OpenCodeManager::new(oc_bin);
        match oc_mgr.ensure_running().await {
            Ok(url) => {
                registry.set_opencode(Arc::new(OpenCodeBackend::new(url)));
                println!("COMBO_OPENCODE_STATUS=connected");
            }
            Err(e) => {
                eprintln!("COMBO_OPENCODE_STATUS=failed: {e:?}");
            }
        }
    }

    // 可选:启动 Claude Code 后端
    if let Ok(cc_bin) = std::env::var("COMBO_CLAUDE_BIN") {
        registry.set_claude_code(Arc::new(ClaudeCodeBackend::new(cc_bin)));
        println!("COMBO_CLAUDE_STATUS=connected");
    }

    // 可选:启动 Codex 后端
    if let Ok(cx_bin) = std::env::var("COMBO_CODEX_BIN") {
        registry.set_codex(Arc::new(CodexBackend::new(cx_bin)));
        println!("COMBO_CODEX_STATUS=connected");
    }

    let listener = TcpListener::bind(SocketAddr::new(host, port)).await?;
    let actual = listener.local_addr()?.port();
    println!("COMBO_PROXY_PORT={actual}");

    let state = AppState {
        meta: Arc::new(MetaStore::open_default()?),
        registry: Arc::new(registry),
        browse_root,
        relay: RelayManager::new(),
        local_port: actual,
    };

    // 启动时迁移遗留的 crush 类型 workspace 到 combo-cli。
    combo_proxy::workspace::reconcile_all(&state).await;

    // 后台健康监控:combo-cli 崩溃时自动重启
    if combo_cli_connected {
        let mgr = Arc::clone(&combo_cli_mgr);
        tokio::spawn(async move {
            use std::time::Duration;
            loop {
                tokio::time::sleep(Duration::from_secs(5)).await;
                if !mgr.is_healthy().await {
                    eprintln!("combo-cli 健康检查失败,尝试重启...");
                    match mgr.ensure_running().await {
                        Ok(_) => {
                            eprintln!("combo-cli 重启成功");
                        }
                        Err(e) => {
                            eprintln!("combo-cli 重启失败: {e}");
                        }
                    }
                }
            }
        });
    }

    // 如果配置了中转隧道(--relay + --relay-token),启动隧道客户端
    let relay_handle = if let (Some(url), Some(token)) = (&relay_url, &relay_token) {
        let config = combo_proxy::tunnel::TunnelClientConfig {
            relay_url: url.clone(),
            token: token.clone(),
            local_proxy_url: format!("http://127.0.0.1:{actual}"),
        };
        println!("COMBO_RELAY_URL={url}");
        let h = tokio::spawn(async move {
            combo_proxy::tunnel::run_tunnel_client(config).await;
        });
        Some(h)
    } else {
        None
    };

    serve(listener, state, origins).await?;

    if let Some(h) = relay_handle {
        h.abort();
    }
    Ok(())
}
