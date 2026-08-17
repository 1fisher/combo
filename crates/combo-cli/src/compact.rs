//! 会话上下文自动压缩模块。
//!
//! 压缩时机由 rig 的自动压缩窗口策略(`rig::memory::TokenWindowMemory`)
//! 决定:每次加载历史时逐消息统计 token,历史超出预算
//! (context_window × [`COMPACT_THRESHOLD_RATIO`],再预留 preamble/工具
//! 定义开销)即触发,超出预算的旧消息前缀被总结为摘要并从 sqlite 删除,
//! 释放上下文空间供后续对话使用。同时提供 `compact` 工具,供 agent
//! 主动触发压缩。
//!
//! 旧实现的触发信号是「上一轮 run 结束时 rig usage 上报的真实占用,
//! provider 未上报时回退 chars/3 字符估算」:中文会话估算偏低 2~3 倍,
//! 常在超窗报错时仍未压缩;固定保留最近 10 条 + 消息条数门槛(12 条)
//! 让「短会话 + 超大工具输出」完全漏压。rig 策略按消息粒度逐条精确
//! 判定,与 provider 是否上报 usage 无关,时机不再漂移。

use crate::agent::AskConfig;
use crate::meta::MetaStore;
use anyhow::Result;
use rig::completion::Message;
use rig::memory::{HeuristicTokenCounter, MemoryPolicy, TokenCounter, TokenWindowMemory};
use rig::tool::{DynamicTool, ToolOutput};
use serde_json::{Value, json};
use std::sync::Arc;
use tokio::sync::broadcast;

/// 触发自动压缩的阈值比例(历史 token 占 context_window 的此比例时触发)。
const COMPACT_THRESHOLD_RATIO: f64 = 0.75;

/// preamble 与工具定义等固定 token 开销,从压缩预算中预留扣除。
const FIXED_OVERHEAD_TOKENS: usize = 5_000;

/// 逐消息 token 计数器的字节/token 比(rig `HeuristicTokenCounter`)。
/// 中文实际约 3~3.6 字节/token(1 token ≈ 1~1.2 个汉字,汉字 3 字节),
/// 取 3.0 偏保守:宁可早压,不可超窗——超窗直接报错中断会话。
const BYTES_PER_TOKEN: f32 = 3.0;

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// rig 自动压缩窗口策略(TokenWindowMemory)
// ---------------------------------------------------------------------------

/// combo 的逐消息 token 计数器(基于 rig `HeuristicTokenCounter`)。
fn token_counter() -> HeuristicTokenCounter {
    HeuristicTokenCounter::new(BYTES_PER_TOKEN, 4, 256)
}

/// 压缩预算:context_window × 阈值比例,再预留 preamble/工具定义开销,
/// 下限 256 防退化为零。
fn token_budget(cfg: &AskConfig) -> usize {
    let budget = (context_window(cfg) as f64 * COMPACT_THRESHOLD_RATIO) as usize;
    budget.saturating_sub(FIXED_OVERHEAD_TOKENS).max(256)
}

/// 把一行 wire 历史(role + parts)转成 rig `Message`:parts 的全部内容
/// (含 tool_call 参数、tool_result 输出)按序列化体积计入 token 计数。
/// 行与消息一一对应,策略切分点可直接映射回 sqlite 行。
fn row_to_message(row: &Value) -> Message {
    let role = row.get("role").and_then(Value::as_str).unwrap_or("user");
    let text = row
        .get("parts")
        .and_then(Value::as_array)
        .map(|parts| {
            parts
                .iter()
                .map(|p| match p.get("type").and_then(Value::as_str) {
                    Some("text") => p
                        .pointer("/data/text")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string(),
                    _ => p.get("data").map(|d| d.to_string()).unwrap_or_default(),
                })
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default();
    match role {
        "assistant" => Message::assistant(text),
        _ => Message::user(text),
    }
}

/// 用 rig 计数器统计一段历史的 token 总量。
pub fn count_tokens(history: &[Value]) -> u64 {
    let counter = token_counter();
    history
        .iter()
        .map(|r| counter.count(&row_to_message(r)) as u64)
        .sum()
}

/// 获取当前模型的上下文窗口大小:provider 模型列表(含 `[providers.<id>]
/// .context_windows` 手动覆盖)→ 内置定义兜底(拉取模型缓存会丢该字段)→
/// 128k 默认。与 agent_info / 前端用量展示同一口径。
pub fn context_window(cfg: &AskConfig) -> u64 {
    cfg.provider
        .find_model(&cfg.model)
        .and_then(|m| m.context_window)
        .or_else(|| {
            crate::providers::builtin_context_map()
                .get(&cfg.provider.id)
                .and_then(|map| map.get(&cfg.model))
                .copied()
        })
        .unwrap_or(128_000) as u64
}

/// 判断是否需要压缩并计算切分点(rig `TokenWindowMemory` 策略)。
///
/// 策略从最新消息往旧逐条累计 token(含每条固定开销),预算耗尽处即
/// 切分点:更旧的前缀超出预算、需要总结压缩。每次加载历史都重新判定,
/// 无状态、不依赖 provider usage 上报,中文短会话与超大工具输出不再漏压。
/// 返回 `None` 表示无需压缩;`Some(evicted)` 为需总结压缩的历史前缀
/// 行数(与 sqlite 消息行一一对应)。
pub fn plan_compaction(cfg: &AskConfig, history: &[Value]) -> Option<usize> {
    if history.len() < 2 {
        return None;
    }
    let policy = TokenWindowMemory::new(token_budget(cfg), token_counter());
    let messages: Vec<Message> = history.iter().map(row_to_message).collect();
    let (_kept, evicted) = policy.apply_with_demoted(messages).ok()?;
    if evicted.is_empty() {
        None
    } else {
        Some(evicted.len())
    }
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

/// 执行上下文压缩:总结超出预算的旧消息前缀,保留预算内的最近消息。
///
/// `history` 为 role+parts 的 Value 数组,`ids` 为对应的消息 ID(长度须一致),
/// `evicted_count` 为 [`plan_compaction`] 计算出的需压缩前缀行数。
/// 返回 `Ok(None)` 表示无需压缩;`Ok(Some(result))` 表示压缩完成。
pub async fn compact(
    cfg: &AskConfig,
    history: &[Value],
    ids: &[String],
    evicted_count: usize,
) -> Result<Option<CompactResult>> {
    let total = history.len();
    if evicted_count == 0 || ids.len() != total {
        return Ok(None);
    }
    let split = evicted_count.min(total);

    let old = &history[..split];
    let tokens_before = count_tokens(history);

    let conversation_text = format_for_summary(old);
    let summary = summarize(cfg, &conversation_text).await?;

    let removed_ids: Vec<String> = ids[..split].to_vec();
    let summary_tokens = (summary.len() as f64 / BYTES_PER_TOKEN as f64) as u64;
    let recent_tokens = count_tokens(&history[split..]);
    let tokens_after = summary_tokens + recent_tokens + FIXED_OVERHEAD_TOKENS as u64;

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

/// 构建 `compact` 工具:agent 调用时按 rig TokenWindowMemory 策略
/// 检查并压缩当前会话上下文。
///
/// 工具读取 sqlite 中的会话消息,若超出 token 预算则总结旧消息并持久化,
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

                match plan_compaction(&cfg, &history) {
                    Some(count) => match compact(&cfg, &history, &ids, count).await {
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
                            // 重置上下文占用,避免用量环显示压缩前的旧值
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
                    },
                    None => Ok(ToolOutput::text(format!(
                        "当前上下文用量未达到压缩阈值(共 {msg_count} 条消息),无需压缩。"
                    ))),
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
    fn count_tokens_counts_all_parts_and_grows_with_content() {
        let history = vec![
            msg("user", "你好"),
            json!({
                "role": "assistant",
                "parts": [{
                    "type": "tool_call",
                    "data": { "name": "read", "input": "{\"path\":\"src/main.rs\"}" }
                }]
            }),
        ];
        // tool_call 参数按序列化体积计入
        assert!(count_tokens(&history) > 0);
        let bigger = vec![msg("user", &"x".repeat(3000))];
        assert!(count_tokens(&bigger) > count_tokens(&history));
    }

    #[test]
    fn plan_compaction_none_when_under_budget() {
        let cfg = test_cfg(128_000);
        let history: Vec<Value> = (0..20)
            .map(|i| msg("user", &format!("普通长度的测试消息 {i}")))
            .collect();
        assert_eq!(plan_compaction(&cfg, &history), None);
    }

    #[test]
    fn plan_compaction_splits_at_token_budget() {
        // 窗口 20000 → 预算 = 15000 - 5000 = 10000;
        // 每条 6000 字节(2000 个汉字)→ 2004 token(2000 + 4 开销):
        // 保留 4 条 = 8016 ≤ 10000,第 5 条 = 10020 > 10000 → 切分在前 6 条。
        let cfg = test_cfg(20_000);
        let history: Vec<Value> = (0..10).map(|_| msg("user", &"压".repeat(2000))).collect();
        assert_eq!(plan_compaction(&cfg, &history), Some(6));
    }

    #[test]
    fn plan_compaction_triggers_for_short_huge_history() {
        // 回归:短会话 + 超大消息也必须触发(旧实现有 12 条消息门槛,
        // 这类会话在超窗报错时仍未压缩——「时机不对」的根源之一)。
        // 窗口 20000 → 预算 10000;每条 20000 字节 → 6667+4 = 6671 token:
        // 保留 1 条(6671 ≤ 10000),第 2 条即超 → 压缩前 2 条。
        let cfg = test_cfg(20_000);
        let history: Vec<Value> = (0..3).map(|_| msg("assistant", &"x".repeat(20_000))).collect();
        assert_eq!(plan_compaction(&cfg, &history), Some(2));
    }

    #[test]
    fn plan_compaction_none_for_single_message() {
        // 仅 1 条消息无切分意义(本轮问题会单独传给模型),不压缩
        let cfg = test_cfg(128_000);
        let history = vec![msg("user", &"压".repeat(600_000))];
        assert_eq!(plan_compaction(&cfg, &history), None);
    }

    #[test]
    fn plan_compaction_budget_reserves_preamble_overhead() {
        // 窗口 8000 → 0.75×8000 = 6000,再扣 5000 开销 → 预算 1000:
        // 每条 2400 字节 → 804 token,2 条 = 1608 > 1000 → 只保留 1 条。
        let cfg = test_cfg(8_000);
        let history: Vec<Value> = (0..4).map(|_| msg("user", &"压".repeat(800))).collect();
        assert_eq!(plan_compaction(&cfg, &history), Some(3));
    }

    #[test]
    fn context_window_falls_back_to_builtin_definitions() {
        // 拉取模型缓存/裸配置会丢 context_window:provider 列表无值时应回落
        // 内置定义(与 agent_info 展示同口径),否则压缩预算按 128k 默认值
        // 过于激进、频繁触发压缩。
        let mut cfg = test_cfg(0);
        cfg.provider.id = "opencode".into();
        cfg.provider.models = vec![crate::providers::ModelInfo {
            id: "deepseek-v4-flash-free".into(),
            ..Default::default()
        }];
        cfg.model = "deepseek-v4-flash-free".into();
        // 内置 opencode 的 deepseek-v4-flash-free 窗口为 1M
        assert_eq!(context_window(&cfg), 1_000_000);
        // 未知 provider + 无窗口 → 128k 默认
        let mut unknown = test_cfg(0);
        unknown.provider.id = "no-such-provider".into();
        unknown.provider.models = Vec::new();
        assert_eq!(context_window(&unknown), 128_000);
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
