//! 会话上下文自动压缩模块。
//!
//! 当对话历史接近模型上下文窗口上限时,自动将旧消息总结为摘要,
//! 用摘要替换原始消息,释放上下文空间供后续对话使用。
//! 同时提供 `compact` 工具,供 agent 主动触发压缩。

use crate::agent::AskConfig;
use crate::meta::MetaStore;
use anyhow::Result;
use rig::tool::{DynamicTool, ToolOutput};
use serde_json::{Value, json};
use std::sync::Arc;
use tokio::sync::broadcast;

/// 触发自动压缩的阈值比例(达到 context_window 的此比例时触发)。
const COMPACT_THRESHOLD_RATIO: f64 = 0.75;

/// 压缩后保留的最近消息条数。
const KEEP_RECENT_MESSAGES: usize = 10;

/// 至少需要这么多条消息才考虑压缩(必须 > KEEP_RECENT_MESSAGES,
/// 否则压缩后保留条数反而变多)。真实 usage 超窗的短会话
/// (少数超大工具输出即可耗尽窗口)也要能触发,因此不宜设得过大。
const MIN_MESSAGES_TO_COMPACT: usize = 12;

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// token 估算
// ---------------------------------------------------------------------------

/// 估算历史消息的 token 用量。
/// 中英混合内容约 3 字符 ≈ 1 token,加上 preamble(~2000)和工具定义(~3000)的固定开销。
pub fn estimate_tokens(history: &[Value]) -> u64 {
    let chars: usize = history
        .iter()
        .filter_map(|h| h.get("parts").and_then(Value::as_array))
        .flat_map(|parts| parts.iter())
        .filter_map(|p| p.get("data"))
        .map(|d| d.to_string().len())
        .sum();
    (chars as f64 / 3.0) as u64 + 5000
}

/// 获取当前模型的上下文窗口大小。
pub fn context_window(cfg: &AskConfig) -> u64 {
    cfg.provider
        .find_model(&cfg.model)
        .and_then(|m| m.context_window)
        .unwrap_or(128_000) as u64
}

/// 判断是否需要压缩。
///
/// `context_tokens` 为 rig 原生 usage 上报的真实上下文占用
/// (最后一次 completion 的 input+output,含 preamble/工具定义/全部历史),
/// 是触发时机的权威信号——字符估算对中英混合内容误差可达数倍,
/// 旧实现按估算触发常导致中文会话超窗报错时仍未压缩。
/// provider 未上报 usage 时回退到本地估算。
pub fn needs_compact(cfg: &AskConfig, history: &[Value], context_tokens: Option<u64>) -> bool {
    if history.len() < MIN_MESSAGES_TO_COMPACT {
        return false;
    }
    let window = context_window(cfg);
    let threshold = (window as f64 * COMPACT_THRESHOLD_RATIO) as u64;
    let used = context_tokens
        .filter(|t| *t > 0)
        .unwrap_or_else(|| estimate_tokens(history));
    used >= threshold
}

// ---------------------------------------------------------------------------
// 格式化与总结
// ---------------------------------------------------------------------------

/// 将历史消息格式化为对话文本供 LLM 总结。
fn format_for_summary(history: &[Value]) -> String {
    let mut out = String::new();
    for msg in history {
        let role = msg.get("role").and_then(Value::as_str).unwrap_or("unknown");
        let label = match role {
            "user" => "用户",
            "assistant" => "助手",
            _ => "系统",
        };
        let Some(parts) = msg.get("parts").and_then(Value::as_array) else {
            continue;
        };
        for p in parts {
            let ptype = p.get("type").and_then(Value::as_str).unwrap_or("");
            let Some(data) = p.get("data") else { continue };
            match ptype {
                "text" => {
                    let t = data.get("text").and_then(Value::as_str).unwrap_or("");
                    if !t.is_empty() {
                        out.push_str(&format!("【{label}】{t}\n\n"));
                    }
                }
                "tool_call" => {
                    let name = data.get("name").and_then(Value::as_str).unwrap_or("");
                    let input = data.get("input").and_then(Value::as_str).unwrap_or("");
                    let preview = truncate(input, 500);
                    out.push_str(&format!("【{label} 调用工具 {name}】{preview}\n\n"));
                }
                "tool_result" => {
                    let content = data.get("content").and_then(Value::as_str).unwrap_or("");
                    let preview = truncate(content, 500);
                    out.push_str(&format!("【工具结果】{preview}\n\n"));
                }
                _ => {}
            }
        }
    }
    out
}

/// 按 UTF-8 字符边界安全截断:截断点若落在多字节字符中间,回退到最近的字符边界。
/// 历史含超长中文(工具调用/结果)时自动压缩会调用本函数,旧的 `&s[..max]` 字节切片
/// 在截断点处 panic,导致 run_agent_ws 请求中断、前端报「发送失败 network error」。
fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max {
        s.to_string()
    } else {
        let mut end = max.min(s.len());
        while end > 0 && !s.is_char_boundary(end) {
            end -= 1;
        }
        format!("{}…", &s[..end])
    }
}

/// 调用模型总结对话内容(无工具、纯文本输出)。
async fn summarize(cfg: &AskConfig, conversation: &str) -> Result<String> {
    if conversation.is_empty() {
        return Ok(String::new());
    }
    let prompt = format!(
        "请将以下对话历史总结为简洁的要点摘要。必须保留:\n\
         1. 用户的核心需求和目标\n\
         2. 已做出的关键决策及原因\n\
         3. 已完成的任务和重要发现\n\
         4. 关键技术细节(文件路径、函数名、配置值等)\n\
         5. 当前正在进行的任务和待解决的问题\n\n\
         用中文输出,保持简洁但不要遗漏关键信息。\n\n--- 对话历史 ---\n{conversation}"
    );
    let summary_cfg = AskConfig {
        tools: false,
        mcp_servers: vec![],
        mcp_command: None,
        mcp_url: None,
        ..cfg.clone()
    };
    crate::agent::ask_answer(&summary_cfg, &prompt, None).await
}

// ---------------------------------------------------------------------------
// 压缩核心逻辑
// ---------------------------------------------------------------------------

/// 压缩结果。
pub struct CompactResult {
    /// 被压缩(删除)的消息 ID 列表。
    pub removed_ids: Vec<String>,
    /// 摘要文本。
    pub summary: String,
    /// 被压缩的消息数量。
    pub compacted_count: usize,
    /// 压缩前估算 token 数。
    pub tokens_before: u64,
    /// 压缩后估算 token 数。
    pub tokens_after: u64,
}

/// 执行上下文压缩:总结旧消息,保留最近几轮。
///
/// `history` 为 role+parts 的 Value 数组,`ids` 为对应的消息 ID(长度须一致)。
/// `context_tokens` 为真实上下文占用(rig usage;None 时用估算)。
/// 返回 `Ok(None)` 表示无需压缩;`Ok(Some(result))` 表示压缩完成。
pub async fn compact(
    cfg: &AskConfig,
    history: &[Value],
    ids: &[String],
    context_tokens: Option<u64>,
) -> Result<Option<CompactResult>> {
    if !needs_compact(cfg, history, context_tokens) {
        return Ok(None);
    }
    let total = history.len();
    if total <= KEEP_RECENT_MESSAGES || ids.len() != total {
        return Ok(None);
    }

    let split = total - KEEP_RECENT_MESSAGES;
    let old = &history[..split];
    let tokens_before = context_tokens
        .filter(|t| *t > 0)
        .unwrap_or_else(|| estimate_tokens(history));

    let conversation_text = format_for_summary(old);
    let summary = summarize(cfg, &conversation_text).await?;

    let removed_ids: Vec<String> = ids[..split].to_vec();
    let summary_tokens = (summary.len() as f64 / 3.0) as u64;
    let recent_tokens = estimate_tokens(&history[split..]);
    let tokens_after = summary_tokens + recent_tokens + 5000;

    Ok(Some(CompactResult {
        removed_ids,
        summary,
        compacted_count: split,
        tokens_before,
        tokens_after,
    }))
}

// ---------------------------------------------------------------------------
// 持久化
// ---------------------------------------------------------------------------

/// 将压缩结果持久化到 sqlite:删除旧消息,插入摘要消息。
///
/// `summary_created_at` 为摘要消息的时间戳:必须早于保留尾部的第一条消息
/// (list_messages 按 created_at 升序,若用当前时间,摘要会排到最近消息
/// 之后,注入 LLM 的历史顺序错乱)。调用方一般传
/// `stored[compacted_count].created_at - 1`。
/// 返回摘要消息的 ID。
pub fn persist_compaction(
    meta: &MetaStore,
    workspace_id: &str,
    session_id: &str,
    result: &CompactResult,
    summary_created_at: i64,
) -> Result<String> {
    let db = meta.db();

    // 删除被压缩的旧消息
    for id in &result.removed_ids {
        let _ = db.delete_message(id);
    }

    // 插入摘要消息(role=user,带特殊标记前缀)
    let summary_id = format!("compact-{}", uuid::Uuid::new_v4());
    let summary_text = format!(
        "📋 **上下文已自动压缩**(约 {} → {} tokens,{} 条历史消息已总结)\n\n\
         {}\n\n--- 以上为历史摘要,请基于此继续对话 ---",
        result.tokens_before, result.tokens_after, result.compacted_count, result.summary
    );
    let parts = json!([{
        "type": "text",
        "data": { "text": summary_text }
    }]);
    db.upsert_message(
        workspace_id,
        session_id,
        &summary_id,
        "user",
        &parts.to_string(),
        summary_created_at,
        summary_created_at,
    )?;

    Ok(summary_id)
}

/// 构建摘要消息的 SSE payload(与 user_message_json 结构一致)。
/// `created_at` 用与持久化一致的 `summary_created_at`,保证前端
/// 重新加载历史时顺序与压缩时一致。
pub fn summary_message_json(
    session_id: &str,
    summary_id: &str,
    summary: &str,
    compacted_count: usize,
    tokens_before: u64,
    tokens_after: u64,
    cfg: &AskConfig,
    summary_created_at: i64,
) -> Value {
    let text = format!(
        "📋 **上下文已自动压缩**(约 {} → {} tokens,{} 条历史消息已总结)\n\n\
         {}\n\n--- 以上为历史摘要,请基于此继续对话 ---",
        tokens_before, tokens_after, compacted_count, summary
    );
    json!({
        "id": summary_id,
        "session_id": session_id,
        "role": "user",
        "parts": [{
            "type": "text",
            "data": { "text": text }
        }],
        "model": cfg.model,
        "provider": cfg.provider.id,
        "created_at": summary_created_at,
        "updated_at": summary_created_at,
    })
}

/// 从 sqlite 重新加载压缩后的历史为 Value 数组。
pub fn load_compacted_history(
    meta: &MetaStore,
    workspace_id: &str,
    session_id: &str,
) -> Vec<Value> {
    meta.db()
        .list_messages(workspace_id, session_id)
        .unwrap_or_default()
        .iter()
        .map(|m| {
            let parts: Value = serde_json::from_str(&m.parts).unwrap_or(Value::Array(vec![]));
            json!({ "role": m.role, "parts": parts })
        })
        .collect()
}

// ---------------------------------------------------------------------------
// compact 工具(供 agent 主动调用)
// ---------------------------------------------------------------------------

/// 构建 `compact` 工具:agent 调用时检查并压缩当前会话上下文。
///
/// 工具读取 sqlite 中的会话消息,若达到阈值则总结旧消息并持久化,
/// 压缩结果在下一轮对话生效。工具同步等待总结完成。
pub fn compact_tool(
    workspace_id: String,
    session_id: String,
    meta: Arc<MetaStore>,
    cfg: AskConfig,
    tx: broadcast::Sender<Value>,
) -> DynamicTool {
    DynamicTool::new(
        "compact",
        "压缩会话上下文。当对话历史过长、接近模型上下文窗口上限时调用此工具,\
         自动总结旧消息以释放上下文空间。无需参数。压缩结果在下一轮对话生效。",
        json!({"type": "object", "properties": {}}),
        move |_ctx, _args| {
            let ws_id = workspace_id.clone();
            let sid = session_id.clone();
            let meta = meta.clone();
            let cfg = cfg.clone();
            let tx = tx.clone();
            Box::pin(async move {
                let stored = match meta.db().list_messages(&ws_id, &sid) {
                    Ok(msgs) => msgs,
                    Err(e) => return Ok(ToolOutput::text(format!("读取历史失败: {e}"))),
                };
                let history: Vec<Value> = stored
                    .iter()
                    .map(|m| {
                        let parts: Value =
                            serde_json::from_str(&m.parts).unwrap_or(json!([]));
                        json!({ "role": m.role, "parts": parts })
                    })
                    .collect();
                let ids: Vec<String> = stored.iter().map(|m| m.id.clone()).collect();
                let msg_count = history.len();
                // 真实上下文占用(rig usage 上报)优先,未上报时回退估算
                let ctx_tokens = meta
                    .db()
                    .get_context_tokens(&sid)
                    .map(|t| t as u64);

                match compact(&cfg, &history, &ids, ctx_tokens).await {
                    Ok(Some(result)) => {
                        let tokens_before = result.tokens_before;
                        let tokens_after = result.tokens_after;
                        let count = result.compacted_count;
                        let removed_ids = result.removed_ids.clone();

                        // 摘要时间戳:排在保留尾部第一条消息之前
                        let summary_at = stored
                            .get(count)
                            .map(|m| m.created_at - 1)
                            .unwrap_or_else(now_secs);
                        let summary_id = match persist_compaction(
                            &meta, &ws_id, &sid, &result, summary_at,
                        ) {
                            Ok(id) => id,
                            Err(e) => {
                                return Ok(ToolOutput::text(format!(
                                    "压缩持久化失败: {e}"
                                )))
                            }
                        };
                        // 重置上下文占用,避免旧值在下一轮反复触发压缩
                        let _ = meta.db().set_context_tokens(&sid, tokens_after as i64);

                        // 广播:删除旧消息 + 插入摘要消息
                        for id in &removed_ids {
                            let _ = tx.send(json!({
                                "type": "message",
                                "payload": {
                                    "type": "deleted",
                                    "payload": { "id": id, "session_id": &sid }
                                }
                            }));
                        }
                        let summary_msg = summary_message_json(
                            &sid,
                            &summary_id,
                            &result.summary,
                            count,
                            tokens_before,
                            tokens_after,
                            &cfg,
                            summary_at,
                        );
                        let _ = tx.send(json!({
                            "type": "message",
                            "payload": { "type": "created", "payload": summary_msg }
                        }));

                        Ok(ToolOutput::text(format!(
                            "已压缩 {count} 条历史消息(约 {tokens_before} → {tokens_after} tokens)。\
                             压缩将在下一轮对话生效。"
                        )))
                    }
                    Ok(None) => Ok(ToolOutput::text(format!(
                        "当前上下文用量未达到压缩阈值(共 {msg_count} 条消息),无需压缩。"
                    ))),
                    Err(e) => Ok(ToolOutput::text(format!("压缩失败: {e}"))),
                }
            })
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn msg(role: &str, text: &str) -> Value {
        json!({
            "role": role,
            "parts": [{ "type": "text", "data": { "text": text } }]
        })
    }

    #[test]
    fn estimate_tokens_returns_nonzero_for_nonempty_history() {
        let history = vec![
            msg("user", "你好,请帮我写一个 Python 脚本"),
            msg("assistant", "好的,这是一个简单的 Python 脚本..."),
        ];
        let tokens = estimate_tokens(&history);
        assert!(tokens > 5000, "应包含固定开销 5000,实际: {tokens}");
    }

    #[test]
    fn estimate_tokens_grows_with_content() {
        let short = vec![msg("user", "hi")];
        let long = vec![msg("user", &"x".repeat(3000))];
        assert!(estimate_tokens(&long) > estimate_tokens(&short));
    }

    #[test]
    fn needs_compact_false_for_short_history() {
        let cfg = test_cfg(128_000);
        let history: Vec<Value> = (0..5).map(|_| msg("user", "短消息")).collect();
        assert!(!needs_compact(&cfg, &history, None));
    }

    #[test]
    fn needs_compact_true_for_large_history() {
        let cfg = test_cfg(1000); // 极小的 context_window 便于测试
        let history: Vec<Value> = (0..20)
            .map(|i| msg("user", &format!("这是一段较长的测试消息内容 {i}")))
            .collect();
        assert!(needs_compact(&cfg, &history, None));
    }

    #[test]
    fn needs_compact_respects_min_message_threshold() {
        let cfg = test_cfg(1); // 极小窗口
        let history: Vec<Value> = (0..5).map(|_| msg("user", &"x".repeat(500))).collect();
        // 少于 MIN_MESSAGES_TO_COMPACT(12),不应触发(即使真实 usage 超窗)
        assert!(!needs_compact(&cfg, &history, Some(9_999_999)));
    }

    #[test]
    fn needs_compact_prefers_real_usage_over_estimate() {
        // 真实 usage 驱动:估算很小(短消息),但 rig 上报的上下文占用已超阈值。
        // 旧实现按 chars/3 估算,中文会话误差 2~3 倍,常在超窗报错时仍未触发。
        let cfg = test_cfg(128_000); // 阈值 0.75 * 128k = 96k
        let history: Vec<Value> = (0..13).map(|_| msg("user", "短")).collect();
        assert!(!needs_compact(&cfg, &history, None), "估算远低于阈值,不应触发");
        assert!(needs_compact(&cfg, &history, Some(100_000)), "真实占用超阈值应触发");
    }

    #[test]
    fn needs_compact_real_usage_below_threshold_blocks_estimate() {
        // 真实 usage 低于阈值时,即使估算偏高也不触发(真实值优先):
        // 窗口 1000 → 阈值 750;估算 39k 字符/3+5000 ≈ 18k(远超),
        // 但 rig 上报真实占用仅 600 → 不应触发。
        let cfg = test_cfg(1000);
        let history: Vec<Value> = (0..13)
            .map(|_| msg("assistant", &"x".repeat(3000)))
            .collect();
        assert!(needs_compact(&cfg, &history, None), "无真实值时按估算应触发");
        assert!(!needs_compact(&cfg, &history, Some(600)), "真实值低于阈值应阻止触发");
    }

    #[test]
    fn truncate_short_text_unchanged() {
        assert_eq!(truncate("hello", 10), "hello");
    }

    #[test]
    fn truncate_long_text_capped() {
        let result = truncate("abcdefghij", 5);
        assert_eq!(result, "abcde…");
    }

    #[test]
    fn truncate_handles_multibyte_boundary() {
        // 回归测试:截断点 500 字节落在 UTF-8 中文字符(3 字节)内部时不得 panic。
        // 旧实现 `&s[..max]` 在此 panic → 自动压缩中断 → 前端报 network error。
        let s = "为".repeat(200); // 600 字节,500 % 3 = 2 → 截断点在字符中间
        let result = truncate(&s, 500);
        assert!(result.starts_with("为"));
        assert!(result.ends_with('…'));
        // 回退到最近的字符边界(498 字节 = 166 个"为")+ "…"(3 字节)
        assert_eq!(result.len(), 501);
        assert!(result.ends_with('…'));
        assert!(!result.contains('\u{FFFD}'));
    }

    #[test]
    fn truncate_multibyte_max_inside_char() {
        let s = "中文abc中文"; // 3+3+3+3+3 = 15 字节
        let result = truncate(s, 7); // 第 7 字节落在第二个"中"内部(6..9)
        assert!(!result.contains('\u{FFFD}'));
        assert!(result.ends_with('…'));
    }

    #[test]
    fn truncate_empty_or_zero() {
        assert_eq!(truncate("", 10), "");
        assert_eq!(truncate("abc", 0), "…");
        assert_eq!(truncate("为", 0), "…");
    }

    #[test]
    fn format_for_summary_includes_roles() {
        let history = vec![
            msg("user", "请帮我写代码"),
            msg("assistant", "好的,马上开始"),
        ];
        let text = format_for_summary(&history);
        assert!(text.contains("用户"));
        assert!(text.contains("请帮我写代码"));
        assert!(text.contains("助手"));
        assert!(text.contains("马上开始"));
    }

    #[test]
    fn format_for_summary_includes_tool_calls() {
        let history = vec![json!({
            "role": "assistant",
            "parts": [{
                "type": "tool_call",
                "data": { "name": "read", "input": "{\"path\":\"src/main.rs\"}" }
            }]
        })];
        let text = format_for_summary(&history);
        assert!(text.contains("read"));
        assert!(text.contains("src/main.rs"));
    }

    fn test_cfg(window: i64) -> AskConfig {
        use crate::config::{LspServerConfig, McpServerConfig, ModelsConfig, ModelRef, ProviderConfig, ResolvedConfig};
        use std::collections::BTreeMap;

        let provider = crate::providers::ProviderInfo {
            id: "test".into(),
            name: None,
            api_key: None,
            api_keys: vec![],
            api_endpoint: None,
            provider_type: None,
            default_large_model_id: None,
            default_small_model_id: None,
            models: vec![crate::providers::ModelInfo {
                id: "test-model".into(),
                name: None,
                context_window: Some(window),
                ..Default::default()
            }],
        };
        AskConfig {
            provider,
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
            lsp: BTreeMap::new(),
        }
    }
}
