//! combo-cli serve 集成测试:验证 ComboCliManager 托管 + rune 兼容协议
//! (会话本地创建、agent 运行、SSE 事件流)。由 `COMBO_CLI_BIN` 指定二进制
//! (默认 `combo-cli`),二进制缺失时跳过。
use axum::http::StatusCode;
use combo_proxy::combocli::ComboCliManager;
use combo_proxy::{Backend, BackendRegistry, ComboCliBackend, MetaStore, Upstream};
use futures_util::StreamExt;
use std::sync::Arc;
use std::sync::OnceLock;
use std::time::Duration;

/// 共享的隔离配置目录:serve 子进程在这里找不到任何 API key / MCP 配置,
/// 保证测试走确定性的 error finish 路径,不真调外部 API、不连 MCP,
/// 多个 serve 并行启动也不会因共享用户配置互相干扰。
fn isolated_config_dir() -> &'static std::path::Path {
    static DIR: OnceLock<std::path::PathBuf> = OnceLock::new();
    DIR.get_or_init(|| {
        use std::time::{SystemTime, UNIX_EPOCH};
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "combo-cli-it-{}-{nanos}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).expect("创建隔离配置目录");
        // 预先写入最小配置:provider=openai 且无 api_key,serve 启动即报错。
        std::fs::write(
            dir.join("combo-cli.toml"),
            "# 集成测试隔离配置\nprovider = \"openai\"\n",
        )
        .expect("写入隔离配置");
        dir
    })
}

/// 启动 combo-cli serve 并返回 (地址, 守护对象)。守护对象保持存活,
/// 测试结束 drop 时强杀子进程,不残留孤儿进程。
async fn start_combo_cli() -> Option<(std::net::SocketAddr, Arc<ComboCliManager>)> {
    let bin = std::env::var("COMBO_CLI_BIN").unwrap_or_else(|_| "combo-cli".into());
    // 子进程继承本进程环境;隔离配置目录使 serve 不读用户真实配置。
    std::env::set_var("COMBO_CONFIG_DIR", isolated_config_dir());
    let mgr = Arc::new(ComboCliManager::new(bin));
    match mgr.ensure_running().await {
        Ok(addr) => Some((addr, mgr)),
        Err(e) => {
            eprintln!("skipping: combo-cli 不可用: {e:?}");
            None
        }
    }
}

fn make_state(addr: std::net::SocketAddr) -> combo_proxy::AppState {
    let mut reg = BackendRegistry::new();
    reg.set_combo_cli(Arc::new(ComboCliBackend::new(
        Upstream::Tcp(addr),
    )));
    let state = combo_proxy::AppState {
        meta: Arc::new(MetaStore::new()),
        registry: Arc::new(reg),
        browse_root: None,
        relay: combo_proxy::RelayManager::new(),
        local_port: 0,
    };
    state.meta.insert(combo_proxy::WorkspaceMeta {
        id: "ws_cli".into(),
        path: "/tmp/combo-cli-it".into(),
        name: "cli".into(),
        backend_type: combo_proxy::BackendType::ComboCli,
    });
    state
}

#[tokio::test]
async fn combo_cli_serve_health() {
    let Some((addr, _mgr)) = start_combo_cli().await else { return };
    let backend = ComboCliBackend::new(Upstream::Tcp(addr));
    assert!(backend.health().await);
}

#[tokio::test]
async fn combo_cli_session_agent_and_sse_flow() {
    let Some((addr, _mgr)) = start_combo_cli().await else { return };
    let state = make_state(addr);

    // 1. 创建会话:combo-cli 后端由本地 sqlite 接管(不转发到 serve)
    let resp = combo_proxy::session::create(
        axum::extract::State(state.clone()),
        axum::extract::Path("ws_cli".to_string()),
        axum::extract::Json(serde_json::json!({ "title": "IT 会话" })),
    )
    .await;
    assert_eq!(resp.status(), StatusCode::OK);
    let bytes = axum::body::to_bytes(resp.into_body(), 65536).await.unwrap();
    let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    let session = v["id"].as_str().unwrap().to_string();

    // 2. 启动代理
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let proxy_addr = listener.local_addr().unwrap();
    let proxy_task = tokio::spawn(async move {
        combo_proxy::serve(listener, state, vec![]).await.unwrap();
    });
    let base = format!("http://{proxy_addr}");
    let client = reqwest::Client::new();

    // 3. 先订阅 SSE(后台流式消费)
    let sse_url = format!("{base}/v1/workspaces/ws_cli/events?client_id=it");
    let sse = client
        .get(&sse_url)
        .header("Accept", "text/event-stream")
        .send()
        .await
        .unwrap();
    assert_eq!(sse.status(), StatusCode::OK);
    assert!(sse
        .headers()
        .get("content-type")
        .unwrap()
        .to_str()
        .unwrap()
        .contains("text/event-stream"));
    let sse_task = tokio::spawn(async move {
        let mut out = String::new();
        let mut stream = sse.bytes_stream();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        while tokio::time::Instant::now() < deadline {
            match tokio::time::timeout(Duration::from_secs(1), stream.next()).await {
                Ok(Some(Ok(chunk))) => {
                    out.push_str(&String::from_utf8_lossy(&chunk));
                    if out.contains("run_complete") {
                        break;
                    }
                }
                _ => break,
            }
        }
        out
    });

    // 4. 发起 agent 运行(无 API key 时 combo-cli 也会发 error finish + run_complete)
    let resp = client
        .post(format!("{base}/v1/workspaces/ws_cli/agent"))
        .json(&serde_json::json!({
            "session_id": session,
            "run_id": "it-run",
            "prompt": "你好",
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    // 5. 断言 SSE 事件序列:用户消息 → assistant 空消息 → finish/error → run_complete
    let events = sse_task.await.unwrap();
    assert!(
        events.contains("\"type\":\"message\"") && events.contains("\"role\":\"user\""),
        "缺少用户消息事件: {events}"
    );
    assert!(
        events.contains("\"role\":\"assistant\""),
        "缺少 assistant 消息事件: {events}"
    );
    assert!(
        events.contains("\"type\":\"finish\""),
        "缺少 finish part: {events}"
    );
    assert!(
        events.contains("run_complete"),
        "缺少 run_complete 事件: {events}"
    );

    proxy_task.abort();
}
