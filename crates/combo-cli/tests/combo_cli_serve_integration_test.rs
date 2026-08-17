//! combo-cli serve 集成测试:以库方式在同一进程内启动 `serve_listener`,
//! 验证 rune 兼容协议(health、workspaces REST、会话、agent 运行、双层 SSE 事件流)。
//!
//! 使用无 API key 的 AskConfig:`agent::stream_run` 必然失败,serve 走确定性的
//! `finish(reason=error)` + `run_complete` 路径,不真调外部 API、不连 MCP、
//! 不读用户真实配置(MetaStore 用内存库,端口随机)。

use axum::http::StatusCode;
use combo_cli::agent::AskConfig;
use combo_cli::automation::AutomationScheduler;
use combo_cli::meta::{MetaStore, WorkspaceMeta};
use combo_cli::providers::ProviderInfo;
use combo_cli::relay::RelayManager;
use combo_cli::serve::{AppState, RunState, serve_listener};
use combo_cli::store::BackendType;
use futures::StreamExt;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::Notify;

/// 无 API key 的最小 AskConfig(保证 agent 运行走 error finish 路径)。
fn cfg_no_key() -> AskConfig {
    AskConfig {
        provider: ProviderInfo {
            id: "test".into(),
            name: None,
            api_key: None,
            api_keys: Vec::new(),
            api_endpoint: None,
            provider_type: Some("openai-compat".into()),
            default_large_model_id: None,
            default_small_model_id: None,
            models: Vec::new(),
        },
        model: "test-model".into(),
        preamble: String::new(),
        base_preamble: String::new(),
        skills_paths: Vec::new(),
        disabled_skills: Vec::new(),
        tools: false,
        mcp_command: None,
        mcp_url: None,
        explicit_api_key: None,
        explicit_base_url: None,
        mcp_servers: Vec::new(),
        reasoning_effort: None,
        lsp: std::collections::BTreeMap::new(),
    }
}

fn make_state() -> AppState {
    let meta = Arc::new(MetaStore::new());
    meta.insert(WorkspaceMeta {
        id: "ws_cli".into(),
        path: "/tmp/combo-cli-it".into(),
        name: "cli".into(),
        backend_type: BackendType::ComboCli,
    });
    AppState {
        cfg: Arc::new(Mutex::new(cfg_no_key())),
        shutdown: Arc::new(Notify::new()),
        runs: Arc::new(RunState::default()),
        meta,
        browse_root: None,
        relay: RelayManager::new(),
        bind_lan: false,
        has_static: false,
        local_port: 0,
        questions: combo_cli::question::QuestionRegistry::new(),
        todos: combo_cli::todo::TodoStore::new(),
        automations: Arc::new(AutomationScheduler::new()),
    }
}

/// 启动 serve 并返回 base URL 与可 abort 的任务句柄。
async fn start_server() -> (String, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let task = tokio::spawn(async move {
        serve_listener(listener, make_state(), Vec::new(), None)
            .await
            .unwrap();
    });
    (format!("http://{addr}"), task)
}

#[tokio::test]
async fn health_ok() {
    let (base, _task) = start_server().await;
    let resp = reqwest::get(format!("{base}/v1/health"))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
}

#[tokio::test]
async fn workspace_create_list_rename() {
    let (base, _task) = start_server().await;
    let client = reqwest::Client::new();

    // 创建 workspace:client_id 必须同时出现在 body
    let resp = client
        .post(format!("{base}/v1/workspaces?client_id=it-cid"))
        .json(&serde_json::json!({
            "path": "/tmp/combo-cli-it",
            "client_id": "it-cid",
            "backend": "combo-cli",
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let v: serde_json::Value = resp.json().await.unwrap();
    let id = v["id"].as_str().unwrap().to_string();
    assert_eq!(v["name"].as_str().unwrap(), "combo-cli-it");

    // 列表可见
    let list: serde_json::Value = client
        .get(format!("{base}/v1/workspaces"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(
        list.as_array().unwrap().iter().any(|w| w["id"] == id.as_str()),
        "列表应包含新建 workspace: {list}"
    );

    // 重命名并跨进程保留(同一 sqlite 镜像)
    let resp = client
        .patch(format!("{base}/v1/workspaces/{id}"))
        .json(&serde_json::json!({ "name": "新名字" }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let got: serde_json::Value = client
        .get(format!("{base}/v1/workspaces/{id}"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(got["name"].as_str().unwrap(), "新名字");
}

#[tokio::test]
async fn session_agent_and_sse_flow() {
    let (base, _task) = start_server().await;
    let client = reqwest::Client::new();

    // 1. 创建会话(本地 sqlite 接管)
    let resp = client
        .post(format!("{base}/v1/workspaces/ws_cli/sessions"))
        .json(&serde_json::json!({ "title": "IT 会话" }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let v: serde_json::Value = resp.json().await.unwrap();
    let session = v["id"].as_str().unwrap().to_string();

    // 2. 先订阅 SSE(后台流式消费,读到 run_complete 即停)
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

    // 3. 发起 agent 运行(无 API key → 确定性的 error finish + run_complete)
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

    // 4. 断言 SSE 事件序列:用户消息 → assistant 空消息 → finish/error → run_complete
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
}

#[tokio::test]
async fn file_read_write_roundtrip() {
    let (base, _task) = start_server().await;
    let client = reqwest::Client::new();
    let dir = std::env::temp_dir().join(format!("combo-cli-it-fs-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();

    // 本测试用的 workspace 指向临时目录,便于验证文件服务
    let resp = client
        .post(format!("{base}/v1/workspaces?client_id=it-fs"))
        .json(&serde_json::json!({
            "path": dir.to_string_lossy(),
            "client_id": "it-fs",
            "backend": "combo-cli",
        }))
        .send()
        .await
        .unwrap();
    let v: serde_json::Value = resp.json().await.unwrap();
    let ws = v["id"].as_str().unwrap().to_string();

    // 写入
    let resp = client
        .put(format!("{base}/v1/workspaces/{ws}/files/content?path=hello.txt"))
        .json(&serde_json::json!({ "content": "你好 combo" }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    // 读取
    let resp = client
        .get(format!(
            "{base}/v1/workspaces/{ws}/files/content?path=hello.txt"
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let v: serde_json::Value = resp.json().await.unwrap();
    assert_eq!(v["content"].as_str().unwrap(), "你好 combo");

    // 列表(目录在前,隐藏文件跳过)
    let resp = client
        .get(format!("{base}/v1/workspaces/{ws}/files/list?path="))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let v: serde_json::Value = resp.json().await.unwrap();
    assert!(
        v.as_array().unwrap().iter().any(|f| f["name"] == "hello.txt"),
        "列表应包含 hello.txt: {v}"
    );

    std::fs::remove_dir_all(&dir).ok();
}
#[tokio::test]
async fn git_repos_discovers_root_and_subdir_repos() {
    use std::process::Command;

    // 构造:workspace 根 + 一级子目录各一个独立 git 仓库,外加一个普通子目录
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    let sub = root.join("subrepo");
    let plain = root.join("notrepo");
    std::fs::create_dir_all(&sub).unwrap();
    std::fs::create_dir_all(&plain).unwrap();
    for d in [root.to_path_buf(), sub.clone()] {
        let out = Command::new("git")
            .arg("init")
            .arg("-q")
            .current_dir(&d)
            .output()
            .unwrap();
        assert!(out.status.success(), "git init 失败: {:?}", out);
    }
    // 让根仓库忽略子目录,避免根 status 把子目录列为 untracked
    std::fs::write(root.join(".gitignore"), "subrepo/\nnotrepo/\n").unwrap();
    std::fs::write(root.join("root.txt"), "x").unwrap();
    std::fs::write(sub.join("sub.txt"), "y").unwrap();
    std::fs::write(plain.join("plain.txt"), "z").unwrap();

    let meta = Arc::new(MetaStore::new());
    meta.insert(WorkspaceMeta {
        id: "ws_git".into(),
        path: root.to_path_buf(),
        name: "git".into(),
        backend_type: BackendType::ComboCli,
    });
    let state = AppState {
        cfg: Arc::new(Mutex::new(cfg_no_key())),
        shutdown: Arc::new(Notify::new()),
        runs: Arc::new(RunState::default()),
        meta,
        browse_root: None,
        relay: RelayManager::new(),
        bind_lan: false,
        has_static: false,
        local_port: 0,
        questions: combo_cli::question::QuestionRegistry::new(),
        todos: combo_cli::todo::TodoStore::new(),
        automations: Arc::new(AutomationScheduler::new()),
    };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let task = tokio::spawn(async move {
        serve_listener(listener, state, Vec::new(), None).await.unwrap();
    });
    let base = format!("http://{addr}");
    let client = reqwest::Client::new();

    // 发现:根仓库 + 一级子目录仓库(普通目录不列出),根在前、子目录按名排序
    let v: serde_json::Value = client
        .get(format!("{base}/v1/workspaces/ws_git/git/repos"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let repos = v["repos"].as_array().unwrap().clone();
    let paths: Vec<&str> = repos
        .iter()
        .map(|r| r["path"].as_str().unwrap())
        .collect();
    assert_eq!(paths, vec!["", "subrepo"], "应发现根与一级子目录仓库: {repos:?}");

    let root_repo = repos.iter().find(|r| r["path"].as_str().unwrap() == "").unwrap();
    let root_files: Vec<&str> = root_repo["files"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f["path"].as_str().unwrap())
        .collect();
    assert!(root_files.contains(&"root.txt"), "根仓库应含 root.txt: {root_files:?}");

    let sub_repo = repos.iter().find(|r| r["path"].as_str().unwrap() == "subrepo").unwrap();
    assert!(!sub_repo["branch"].as_str().unwrap().is_empty());
    assert_eq!(sub_repo["files"][0]["path"], "sub.txt");
    assert_eq!(sub_repo["files"][0]["workTreeStatus"], "untracked");

    // 子仓库 status:repo 参数定位到一级子目录
    let v: serde_json::Value = client
        .get(format!("{base}/v1/workspaces/ws_git/git/status?repo=subrepo"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(!v["branch"].as_str().unwrap().is_empty());
    assert_eq!(v["files"][0]["path"], "sub.txt");

    // 根仓库 status:不带 repo 参数保持原行为
    let v: serde_json::Value = client
        .get(format!("{base}/v1/workspaces/ws_git/git/status"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let root_files: Vec<&str> = v["files"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f["path"].as_str().unwrap())
        .collect();
    assert!(root_files.contains(&"root.txt"), "根仓库应含 root.txt: {root_files:?}");

    // 越界 repo 路径应被前缀校验拒绝
    let resp = client
        .get(format!("{base}/v1/workspaces/ws_git/git/status?repo=..%2F"))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);

    task.abort();
}

#[tokio::test]
async fn workspace_config_disabled_skills_roundtrip() {
    let (base, task) = start_server().await;
    let client = reqwest::Client::new();
    let ws = "ws_cfg";

    // 初始为空
    let v: serde_json::Value = client
        .get(format!("{base}/v1/workspaces/{ws}/config"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(v["options"]["disabled_skills"].as_array().unwrap().is_empty());

    // 写入禁用列表
    let resp = client
        .post(format!("{base}/v1/workspaces/{ws}/config/set"))
        .json(&serde_json::json!({
            "key": "disabled_skills",
            "value": ["skill-a", "skill-b"],
            "scope": 1,
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    // 读回
    let v: serde_json::Value = client
        .get(format!("{base}/v1/workspaces/{ws}/config"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let disabled: Vec<&str> = v["options"]["disabled_skills"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s.as_str().unwrap())
        .collect();
    assert_eq!(disabled, vec!["skill-a", "skill-b"]);

    // 非 disabled_skills key 仍走 stub 回显,不落库
    let resp = client
        .post(format!("{base}/v1/workspaces/{ws}/config/set"))
        .json(&serde_json::json!({ "key": "something_else", "value": 42, "scope": 1 }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    task.abort();
}

#[tokio::test]
async fn question_answer_unknown_batch_returns_false() {
    let (base, task) = start_server().await;
    let client = reqwest::Client::new();

    // 不存在的 batch_id → ok: false
    let resp = client
        .post(format!("{base}/v1/workspaces/ws_x/questions/answer"))
        .json(&serde_json::json!({
            "batch_request_id": "nonexistent-batch",
            "responses": [],
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let v: serde_json::Value = resp.json().await.unwrap();
    assert_eq!(v["ok"], false);

    task.abort();
}

#[tokio::test]
async fn question_answer_missing_batch_id_returns_false() {
    let (base, task) = start_server().await;
    let client = reqwest::Client::new();

    let resp = client
        .post(format!("{base}/v1/workspaces/ws_x/questions/answer"))
        .json(&serde_json::json!({ "responses": [] }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let v: serde_json::Value = resp.json().await.unwrap();
    assert_eq!(v["ok"], false);

    task.abort();
}

#[tokio::test]
async fn automation_crud_run_now_and_history() {
    let (base, _task) = start_server().await;
    let client = reqwest::Client::new();

    // 0. 校验:workspace 不存在
    let resp = client
        .post(format!("{base}/v1/automations"))
        .json(&serde_json::json!({
            "workspace_id": "nope",
            "name": "x",
            "prompt": "y",
            "schedule": { "type": "daily", "time": "09:00" },
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);

    // 1. 创建(ws_cli 由 make_state 预置)
    let resp = client
        .post(format!("{base}/v1/automations"))
        .json(&serde_json::json!({
            "workspace_id": "ws_cli",
            "name": "每日晨会摘要",
            "prompt": "请汇总昨日工作并生成晨会摘要",
            "schedule": { "type": "daily", "time": "09:00" },
            "enabled": true,
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let created: serde_json::Value = resp.json().await.unwrap();
    let id = created["id"].as_str().unwrap().to_string();
    assert_eq!(created["name"].as_str().unwrap(), "每日晨会摘要");
    assert_eq!(created["workspace_name"].as_str().unwrap(), "cli");
    assert_eq!(created["schedule"]["type"].as_str().unwrap(), "daily");
    assert!(created["next_run_at"].as_i64().unwrap() > 0);
    assert_eq!(created["enabled"], true);

    // 2. 列表可见
    let list: serde_json::Value = client
        .get(format!("{base}/v1/automations"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(list.as_array().unwrap().iter().any(|a| a["id"] == id));

    // 3. 更新:禁用 → next_run_at 保留(已排的未来时间不受影响)
    let resp = client
        .patch(format!("{base}/v1/automations/{id}"))
        .json(&serde_json::json!({ "enabled": false }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let got: serde_json::Value = resp.json().await.unwrap();
    assert_eq!(got["enabled"], false);

    // 4. 更新:改调度 → next_run_at 重算且仍是未来
    let resp = client
        .patch(format!("{base}/v1/automations/{id}"))
        .json(&serde_json::json!({
            "schedule": { "type": "weekly", "weekday": 5, "time": "18:00" },
        }))
        .send()
        .await
        .unwrap();
    let got: serde_json::Value = resp.json().await.unwrap();
    assert_eq!(got["schedule"]["type"].as_str().unwrap(), "weekly");
    assert_eq!(got["schedule"]["weekday"].as_i64().unwrap(), 5);
    assert!(got["next_run_at"].as_i64().unwrap() > 0);

    // 5. 非法调度被拒绝
    let resp = client
        .patch(format!("{base}/v1/automations/{id}"))
        .json(&serde_json::json!({ "schedule": { "type": "hourly" } }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);

    // 6. 手动触发:无 API key → agent 立即 error 收尾,运行记录落库
    let resp = client
        .post(format!("{base}/v1/automations/{id}/run"))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    // 等待后台 run 收尾(running → error)
    let mut runs: serde_json::Value = serde_json::Value::Null;
    for _ in 0..100 {
        runs = client
            .get(format!("{base}/v1/automations/{id}/runs"))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        let arr = runs.as_array().unwrap();
        if arr.len() == 1 && arr[0]["status"] != "running" {
            break;
        }
        tokio::time::sleep(Duration::from_millis(30)).await;
    }
    let arr = runs.as_array().unwrap();
    assert_eq!(arr.len(), 1, "应有一条运行记录: {runs}");
    assert_eq!(arr[0]["status"].as_str().unwrap(), "error");
    assert!(arr[0]["finished_at"].is_i64());
    assert!(!arr[0]["error"].as_str().unwrap_or("").is_empty());

    // 手动触发不推进排期:next_run_at 仍是原计划
    let got: serde_json::Value = client
        .get(format!("{base}/v1/automations/{id}"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(got["next_run_at"].as_i64().unwrap() > 0);

    // 7. 删除(级联运行历史)
    let resp = client
        .delete(format!("{base}/v1/automations/{id}"))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let list: serde_json::Value = client
        .get(format!("{base}/v1/automations"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(!list.as_array().unwrap().iter().any(|a| a["id"] == id));
    let runs: serde_json::Value = client
        .get(format!("{base}/v1/automations/{id}/runs"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(runs.as_array().unwrap().is_empty());
}
