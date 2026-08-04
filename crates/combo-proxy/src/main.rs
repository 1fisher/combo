use anyhow::Result;
use combo_proxy::rune::RuneManager;
use combo_proxy::{parse_upstream, serve, AppState, BackendRegistry, ClaudeCodeBackend, CodexBackend, CrushBackend, MetaStore, OpenCodeBackend, OpenCodeManager};
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::net::TcpListener;

#[tokio::main]
async fn main() -> Result<()> {
    let mut args = std::env::args().skip(1);
    let mut upstream_arg = None;
    let mut port: u16 = 0;
    let mut host: std::net::IpAddr = [127, 0, 0, 1].into();
    let mut origins = Vec::new();
    while let Some(a) = args.next() {
        match a.as_str() {
            "--upstream" => upstream_arg = Some(args.next().unwrap()),
            "--port" => port = args.next().unwrap().parse()?,
            "--host" => host = args.next().unwrap().parse()?,
            "--origin" => origins.push(args.next().unwrap()),
            _ => {}
        }
    }
    let (upstream, supervisor) = match upstream_arg {
        Some(s) => (parse_upstream(&s)?, None),
        None => {
            // 自动接管 rune 生命周期
            let mgr = RuneManager::new(
                std::env::var("COMBO_CRUSH_BIN").unwrap_or_else(|_| "crush".into()),
            );
            let mgr = Arc::new(mgr);
            let u = mgr.ensure_running().await?;
            println!("COMBO_RUNE_STATUS=connected");
            (u, Some(mgr))
        }
    };

    let mut registry = BackendRegistry::new(Arc::new(CrushBackend::new(upstream)));

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

    let state = AppState {
        meta: Arc::new(MetaStore::open_default()?),
        registry: Arc::new(registry),
        crush_supervisor: supervisor,
    };

    // crush 为内存态,重启后 workspace 会被遗忘:启动时把元数据库里的
    // workspace 重新注册/对齐,否则转发到 crush 的请求会 404。
    let failed = combo_proxy::workspace::reconcile_all(&state).await;
    if failed > 0 {
        eprintln!("COMBO_RECONCILE_WARN={failed} workspaces failed to register with crush");
    }

    // 后台健康监控:crush 崩溃时自动重启
    if let Some(sup) = &state.crush_supervisor {
        let sup = Arc::clone(sup);
        tokio::spawn(async move {
            use std::time::Duration;
            loop {
                tokio::time::sleep(Duration::from_secs(5)).await;
                if !sup.is_healthy().await {
                    eprintln!("crush 健康检查失败,尝试重启...");
                    match sup.ensure_running().await {
                        Ok(_) => {
                            eprintln!("crush 重启成功");
                        }
                        Err(e) => {
                            eprintln!("crush 重启失败: {e}");
                        }
                    }
                }
            }
        });
    }

    let listener = TcpListener::bind(SocketAddr::new(host, port)).await?;
    let actual = listener.local_addr()?.port();
    println!("COMBO_PROXY_PORT={actual}");
    serve(listener, state, origins).await?;
    Ok(())
}
