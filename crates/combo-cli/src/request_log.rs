//! Agent 请求/响应日志:把每次发送给 agent 接口的请求与返回结果
//! 以 JSON Lines 格式追加写入日志文件,便于调试与审计。
//!
//! 日志目录:`$COMBO_DATA_DIR/logs/` 或 `~/.config/combo/logs/`。
//! 每天一个文件:`agent-YYYY-MM-DD.log`。
//! 每行一个 JSON 对象(`request` / `event` / `response`),通过 `run_id` 关联。
//! 流式文本/思考增量不逐条落日志:经 [`StreamLogBuffer`] 拼接后按段整行写出。

use chrono::Local;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::fs::{OpenOptions, create_dir_all};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

/// 返回日志目录(`$COMBO_DATA_DIR/logs` 或统一目录 `~/.config/combo/logs`,
/// 见 `paths::default_data_dir`)。
fn log_dir() -> PathBuf {
    crate::paths::default_data_dir().join("logs")
}

/// 返回今天的日志文件路径。
fn today_log_path() -> PathBuf {
    let date = Local::now().format("%Y-%m-%d").to_string();
    log_dir().join(format!("agent-{date}.log"))
}

/// 全局日志写入锁(append 模式下保证行原子性)。
static LOG_LOCK: Mutex<()> = Mutex::new(());

/// 把一个 JSON 值作为一行追加写入日志文件。
fn append_line(entry: Value) {
    let path = today_log_path();
    let _guard = LOG_LOCK.lock();
    if let Some(parent) = path.parent() {
        let _ = create_dir_all(parent);
    }
    let mut line = serde_json::to_string(&entry).unwrap_or_default();
    line.push('\n');
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(&path) {
        let _ = f.write_all(line.as_bytes());
    }
}

/// 把一个 JSON 值作为一行追加写入指定目录的日志文件。
fn append_line_to(dir: &std::path::Path, entry: Value) {
    let date = Local::now().format("%Y-%m-%d").to_string();
    let path = dir.join("logs").join(format!("agent-{date}.log"));
    let _guard = LOG_LOCK.lock();
    if let Some(parent) = path.parent() {
        let _ = create_dir_all(parent);
    }
    let mut line = serde_json::to_string(&entry).unwrap_or_default();
    line.push('\n');
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(&path) {
        let _ = f.write_all(line.as_bytes());
    }
}

/// 记录 agent 请求(进入 `/v1/workspaces/{id}/agent` 时调用)。
#[allow(clippy::too_many_arguments)]
pub fn log_request(
    ws_id: &str,
    session_id: &str,
    run_id: &str,
    prompt: &str,
    provider: &str,
    model: &str,
    history_len: usize,
) {
    let entry = json!({
        "ts": Local::now().to_rfc3339(),
        "type": "request",
        "ws_id": ws_id,
        "session_id": session_id,
        "run_id": run_id,
        "provider": provider,
        "model": model,
        "prompt": prompt,
        "history_len": history_len,
    });
    append_line(entry);
}

#[cfg(test)]
#[allow(clippy::too_many_arguments)]
fn log_request_to(
    dir: &std::path::Path,
    ws_id: &str,
    session_id: &str,
    run_id: &str,
    prompt: &str,
    provider: &str,
    model: &str,
    history_len: usize,
) {
    let entry = json!({
        "ts": Local::now().to_rfc3339(),
        "type": "request",
        "ws_id": ws_id,
        "session_id": session_id,
        "run_id": run_id,
        "provider": provider,
        "model": model,
        "prompt": prompt,
        "history_len": history_len,
    });
    append_line_to(dir, entry);
}

/// 记录 agent 离散事件(工具调用 / 工具结果)。
/// 流式文本/思考增量不在此逐条记录:经 [`StreamLogBuffer`] 拼接后整段写出。
pub fn log_event(
    run_id: &str,
    session_id: &str,
    event_type: &str,
    data: Value,
) {
    let entry = json!({
        "ts": Local::now().to_rfc3339(),
        "type": "event",
        "run_id": run_id,
        "session_id": session_id,
        "event": event_type,
        "data": data,
    });
    append_line(entry);
}

#[cfg(test)]
fn log_event_to(
    dir: &std::path::Path,
    run_id: &str,
    session_id: &str,
    event_type: &str,
    data: Value,
) {
    let entry = json!({
        "ts": Local::now().to_rfc3339(),
        "type": "event",
        "run_id": run_id,
        "session_id": session_id,
        "event": event_type,
        "data": data,
    });
    append_line_to(dir, entry);
}

/// 流式内容日志缓冲:文本/思考增量先在内存拼接,到段边界
/// (工具调用、run 结束/取消/出错)时才整段写入日志——替代逐 delta
/// 落一行,避免一次流式回复产生上百行碎片日志。
///
/// 写出的事件名为 `text` / `reasoning`(`data.text` 为拼接后的完整内容),
/// 与离散事件 `tool_call` / `tool_result` 区分。
#[derive(Default)]
pub struct StreamLogBuffer {
    text: String,
    reasoning: String,
}

impl StreamLogBuffer {
    /// 追加一段流式文本增量。
    pub fn push_text(&mut self, delta: &str) {
        self.text.push_str(delta);
    }

    /// 追加一段流式思考增量。
    pub fn push_reasoning(&mut self, delta: &str) {
        self.reasoning.push_str(delta);
    }

    /// 把拼接后的流式内容作为单条日志写出(先 reasoning 后 text),并清空缓冲;
    /// 空缓冲为 no-op。工具调用边界与 run 收尾时调用。
    pub fn flush(&mut self, run_id: &str, session_id: &str) {
        self.flush_inner(None, run_id, session_id);
    }

    fn flush_inner(&mut self, dir: Option<&std::path::Path>, run_id: &str, session_id: &str) {
        // 同一段内 reasoning 在 text 之前到达,按此固定顺序写出
        for (event, content) in [("reasoning", &self.reasoning), ("text", &self.text)] {
            if content.is_empty() {
                continue;
            }
            let entry = json!({
                "ts": Local::now().to_rfc3339(),
                "type": "event",
                "run_id": run_id,
                "session_id": session_id,
                "event": event,
                "data": { "text": content },
            });
            match dir {
                Some(d) => append_line_to(d, entry),
                None => append_line(entry),
            }
        }
        self.reasoning.clear();
        self.text.clear();
    }
}

#[cfg(test)]
impl StreamLogBuffer {
    fn flush_to(&mut self, dir: &std::path::Path, run_id: &str, session_id: &str) {
        self.flush_inner(Some(dir), run_id, session_id);
    }
}

/// 记录 agent 运行结束(成功 / 取消 / 错误)。
pub fn log_response(
    run_id: &str,
    session_id: &str,
    reason: &str,
    text: &str,
    error: Option<&str>,
    usage: Option<(u64, u64)>,
    tool_calls: &[ToolCallSummary],
) {
    log_response_inner(None, run_id, session_id, reason, text, error, usage, tool_calls);
}

fn log_response_inner(
    dir: Option<&std::path::Path>,
    run_id: &str,
    session_id: &str,
    reason: &str,
    text: &str,
    error: Option<&str>,
    usage: Option<(u64, u64)>,
    tool_calls: &[ToolCallSummary],
) {
    let tools: Vec<Value> = tool_calls
        .iter()
        .map(|t| {
            json!({
                "name": t.name,
                "input_preview": t.input.chars().take(500).collect::<String>(),
            })
        })
        .collect();

    let mut entry = json!({
        "ts": Local::now().to_rfc3339(),
        "type": "response",
        "run_id": run_id,
        "session_id": session_id,
        "reason": reason,
        "text": text,
        "tool_calls": tools,
    });
    if let Some(err) = error {
        entry["error"] = json!(err);
    }
    if let Some((input, output)) = usage {
        entry["usage"] = json!({ "input_tokens": input, "output_tokens": output });
    }
    match dir {
        Some(d) => append_line_to(d, entry),
        None => append_line(entry),
    }
}

/// 工具调用摘要(用于响应日志)。
pub struct ToolCallSummary {
    pub name: String,
    pub input: String,
}

/// 单个模型的聚合统计。
#[derive(Clone, Debug, Default)]
pub struct ModelStats {
    pub provider: String,
    pub model: String,
    pub request_count: u64,
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    pub cost: f64,
}

/// 单日的聚合统计(用于曲线图)。
#[derive(Clone, Debug, Default)]
pub struct DailyStats {
    pub date: String,
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    pub cost: f64,
    pub request_count: u64,
}

/// 全量聚合统计(API 返回值)。
#[derive(Clone, Debug, Default)]
pub struct UsageStats {
    pub total_prompt_tokens: u64,
    pub total_completion_tokens: u64,
    pub total_cost: f64,
    pub total_requests: u64,
    pub by_model: Vec<ModelStats>,
    pub daily: Vec<DailyStats>,
}

/// 读取全部日志文件(从 30 天前至今),聚合返回用量统计。
pub fn collect_stats() -> UsageStats {
    let dir = log_dir();
    let mut requests: HashMap<String, (String, String)> = HashMap::new();
    let mut by_model_map: HashMap<String, ModelStats> = HashMap::new();
    let mut daily_map: HashMap<String, DailyStats> = HashMap::new();
    let mut stats = UsageStats::default();

    // 枚举 30 天的日志文件
    let today = Local::now().date_naive();
    for i in 0..30u32 {
        let date = today - chrono::Duration::days(i as i64);
        let date_str = date.format("%Y-%m-%d").to_string();
        let path = dir.join(format!("agent-{date_str}.log"));
        let Ok(content) = std::fs::read_to_string(&path) else { continue };

        for line in content.lines() {
            let Ok(entry) = serde_json::from_str::<Value>(line) else { continue };
            let ts = entry.get("ts").and_then(Value::as_str).unwrap_or("");
            let entry_date = ts.get(..10).unwrap_or(&date_str).to_string();

            match entry.get("type").and_then(Value::as_str) {
                Some("request") => {
                    let run_id = entry.get("run_id").and_then(Value::as_str).unwrap_or("").to_string();
                    let provider = entry.get("provider").and_then(Value::as_str).unwrap_or("").to_string();
                    let model = entry.get("model").and_then(Value::as_str).unwrap_or("").to_string();
                    if !run_id.is_empty() {
                        requests.insert(run_id, (provider, model));
                    }
                }
                Some("response") => {
                    let run_id = entry.get("run_id").and_then(Value::as_str).unwrap_or("").to_string();
                    let (provider, model) = requests.get(&run_id)
                        .cloned()
                        .unwrap_or(("unknown".into(), "unknown".into()));
                    let key = format!("{provider}/{model}");

                    let input = entry.get("usage")
                        .and_then(|u| u.get("input_tokens"))
                        .and_then(Value::as_u64)
                        .unwrap_or(0);
                    let output = entry.get("usage")
                        .and_then(|u| u.get("output_tokens"))
                        .and_then(Value::as_u64)
                        .unwrap_or(0);

                    // 计算费用
                    let prov = crate::providers::ProviderInfo {
                        id: provider.clone(),
                        name: None,
                        api_key: None,
                        api_keys: vec![],
                        api_endpoint: None,
                        provider_type: None,
                        default_large_model_id: None,
                        default_small_model_id: None,
                        models: Vec::new(),
                    };
                    let (pin, pout) = crate::providers::get_model_pricing(&prov, &model);
                    let cost = (input as f64 / 1_000_000.0) * pin
                        + (output as f64 / 1_000_000.0) * pout;

                    // 按模型聚合
                    let ms = by_model_map.entry(key).or_insert_with(|| ModelStats {
                        provider: provider.clone(),
                        model: model.clone(),
                        ..Default::default()
                    });
                    ms.request_count += 1;
                    ms.prompt_tokens += input;
                    ms.completion_tokens += output;
                    ms.cost += cost;

                    // 按日聚合
                    let ds = daily_map.entry(entry_date.clone()).or_insert_with(|| DailyStats {
                        date: entry_date.clone(),
                        ..Default::default()
                    });
                    ds.prompt_tokens += input;
                    ds.completion_tokens += output;
                    ds.cost += cost;
                    ds.request_count += 1;

                    // 总计
                    stats.total_prompt_tokens += input;
                    stats.total_completion_tokens += output;
                    stats.total_cost += cost;
                    stats.total_requests += 1;
                }
                _ => {}
            }
        }
    }

    stats.by_model = by_model_map.into_values().collect();
    stats.by_model.sort_by(|a, b| b.cost.partial_cmp(&a.cost).unwrap_or(std::cmp::Ordering::Equal));

    let mut daily: Vec<DailyStats> = daily_map.into_values().collect();
    daily.sort_by(|a, b| a.date.cmp(&b.date));
    stats.daily = daily;

    stats
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn log_dir_uses_env_var() {
        let _env = crate::paths::ENV_LOCK.lock().unwrap();
        std::env::set_var("COMBO_DATA_DIR", "/tmp/combo-test-logs");
        let dir = log_dir();
        assert_eq!(dir, PathBuf::from("/tmp/combo-test-logs/logs"));
        std::env::remove_var("COMBO_DATA_DIR");
    }

    #[test]
    fn append_line_creates_file() {
        let dir = tempfile::tempdir().unwrap();
        append_line_to(dir.path(), json!({ "type": "request", "prompt": "hello" }));
        append_line_to(dir.path(), json!({ "type": "response", "text": "hi" }));

        let date = Local::now().format("%Y-%m-%d").to_string();
        let path = dir.path().join("logs").join(format!("agent-{date}.log"));
        assert!(path.exists());

        let content = std::fs::read_to_string(&path).unwrap();
        let lines: Vec<&str> = content.trim().lines().collect();
        assert_eq!(lines.len(), 2);

        let first: Value = serde_json::from_str(lines[0]).unwrap();
        assert_eq!(first["type"], "request");
        assert_eq!(first["prompt"], "hello");

        let second: Value = serde_json::from_str(lines[1]).unwrap();
        assert_eq!(second["type"], "response");
        assert_eq!(second["text"], "hi");
    }

    #[test]
    fn log_request_writes_expected_fields() {
        let dir = tempfile::tempdir().unwrap();
        log_request_to(
            dir.path(),
            "ws-1",
            "sess-1",
            "run-1",
            "你好",
            "opencode-zen",
            "deepseek-v4-flash-free",
            3,
        );

        let date = Local::now().format("%Y-%m-%d").to_string();
        let path = dir.path().join("logs").join(format!("agent-{date}.log"));
        let content = std::fs::read_to_string(&path).unwrap();
        let entry: Value = serde_json::from_str(content.trim()).unwrap();
        assert_eq!(entry["type"], "request");
        assert_eq!(entry["ws_id"], "ws-1");
        assert_eq!(entry["session_id"], "sess-1");
        assert_eq!(entry["run_id"], "run-1");
        assert_eq!(entry["prompt"], "你好");
        assert_eq!(entry["provider"], "opencode-zen");
        assert_eq!(entry["model"], "deepseek-v4-flash-free");
        assert_eq!(entry["history_len"], 3);
    }

    #[test]
    fn log_response_includes_usage_and_tools() {
        let dir = tempfile::tempdir().unwrap();
        log_response_inner(
            Some(dir.path()),
            "run-1",
            "sess-1",
            "end_turn",
            "这是回答",
            None,
            Some((100, 50)),
            &[ToolCallSummary {
                name: "read".into(),
                input: r#"{"path":"src/main.rs"}"#.into(),
            }],
        );

        let date = Local::now().format("%Y-%m-%d").to_string();
        let path = dir.path().join("logs").join(format!("agent-{date}.log"));
        let content = std::fs::read_to_string(&path).unwrap();
        let entry: Value = serde_json::from_str(content.trim()).unwrap();
        assert_eq!(entry["type"], "response");
        assert_eq!(entry["reason"], "end_turn");
        assert_eq!(entry["text"], "这是回答");
        assert_eq!(entry["usage"]["input_tokens"], 100);
        assert_eq!(entry["usage"]["output_tokens"], 50);
        assert!(entry["error"].is_null());
        assert_eq!(entry["tool_calls"][0]["name"], "read");
    }

    #[test]
    fn log_response_with_error() {
        let dir = tempfile::tempdir().unwrap();
        log_response_inner(
            Some(dir.path()),
            "run-2",
            "sess-2",
            "error",
            "",
            Some("API 密钥无效"),
            None,
            &[],
        );

        let date = Local::now().format("%Y-%m-%d").to_string();
        let path = dir.path().join("logs").join(format!("agent-{date}.log"));
        let content = std::fs::read_to_string(&path).unwrap();
        let entry: Value = serde_json::from_str(content.trim()).unwrap();
        assert_eq!(entry["error"], "API 密钥无效");
        assert_eq!(entry["reason"], "error");
    }

    #[test]
    fn log_event_records_discrete_events() {
        let dir = tempfile::tempdir().unwrap();
        log_event_to(dir.path(), "run-1", "sess-1", "tool_call", json!({ "name": "grep" }));
        log_event_to(
            dir.path(),
            "run-1",
            "sess-1",
            "tool_result",
            json!({ "content_preview": "foo" }),
        );

        let date = Local::now().format("%Y-%m-%d").to_string();
        let path = dir.path().join("logs").join(format!("agent-{date}.log"));
        let content = std::fs::read_to_string(&path).unwrap();
        let lines: Vec<&str> = content.trim().lines().collect();
        assert_eq!(lines.len(), 2);
        let first: Value = serde_json::from_str(lines[0]).unwrap();
        assert_eq!(first["event"], "tool_call");
        assert_eq!(first["data"]["name"], "grep");
    }

    /// 流式增量拼接后整段落日志:多个 delta 合并为一行,flush 后缓冲清空。
    #[test]
    fn stream_log_buffer_merges_deltas_into_single_lines() {
        let dir = tempfile::tempdir().unwrap();
        let mut buf = StreamLogBuffer::default();
        buf.push_reasoning("先");
        buf.push_reasoning("分析");
        buf.push_text("你");
        buf.push_text("好");

        buf.flush_to(dir.path(), "run-1", "sess-1");
        // 空缓冲再 flush 不产生新行
        buf.flush_to(dir.path(), "run-1", "sess-1");

        let date = Local::now().format("%Y-%m-%d").to_string();
        let path = dir.path().join("logs").join(format!("agent-{date}.log"));
        let content = std::fs::read_to_string(&path).unwrap();
        let lines: Vec<&str> = content.trim().lines().collect();
        assert_eq!(lines.len(), 2, "拼接后应只有两行: {content}");
        let first: Value = serde_json::from_str(lines[0]).unwrap();
        assert_eq!(first["type"], "event");
        assert_eq!(first["run_id"], "run-1");
        assert_eq!(first["event"], "reasoning");
        assert_eq!(first["data"]["text"], "先分析");
        let second: Value = serde_json::from_str(lines[1]).unwrap();
        assert_eq!(second["event"], "text");
        assert_eq!(second["data"]["text"], "你好");

        // flush 后缓冲已清空:后续增量从零拼接(下一段)
        buf.push_text("新段");
        buf.flush_to(dir.path(), "run-1", "sess-1");
        let content = std::fs::read_to_string(&path).unwrap();
        let lines: Vec<&str> = content.trim().lines().collect();
        assert_eq!(lines.len(), 3);
        let third: Value = serde_json::from_str(lines[2]).unwrap();
        assert_eq!(third["event"], "text");
        assert_eq!(third["data"]["text"], "新段");
    }

    /// 只有文本(无思考)时 flush 只落一行;全空时完全不落。
    #[test]
    fn stream_log_buffer_skips_empty_sections() {
        let dir = tempfile::tempdir().unwrap();
        let mut buf = StreamLogBuffer::default();
        buf.flush_to(dir.path(), "run-1", "sess-1"); // 全空 → 无文件

        let date = Local::now().format("%Y-%m-%d").to_string();
        let path = dir.path().join("logs").join(format!("agent-{date}.log"));
        assert!(!path.exists(), "空缓冲不应写文件");

        buf.push_text("仅文本");
        buf.flush_to(dir.path(), "run-1", "sess-1");
        let content = std::fs::read_to_string(&path).unwrap();
        let lines: Vec<&str> = content.trim().lines().collect();
        assert_eq!(lines.len(), 1);
        let first: Value = serde_json::from_str(lines[0]).unwrap();
        assert_eq!(first["event"], "text");
        assert_eq!(first["data"]["text"], "仅文本");
    }
}
