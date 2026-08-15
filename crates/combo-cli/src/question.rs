//! Question tool:让 agent 在需要用户决策时弹出问卷,阻塞等待用户回答。
//!
//! 工具调用流程:
//! 1. agent 调用 `question` 工具,传入问题列表
//! 2. 工具生成 batch_id,经 broadcast 发送 `question_batch_request` SSE 事件
//! 3. 前端弹出 QuestionDialog,用户回答后 POST `/v1/workspaces/:id/questions/answer`
//! 4. `question_answer` handler 通过 `QuestionRegistry` 唤醒等待中的工具
//! 5. 工具将答案格式化后返回给 agent

use rig::tool::{DynamicTool, ToolOutput};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio::sync::{broadcast, oneshot, watch};

/// 待回答问题的注册表:batch_id → oneshot sender。
/// 通过 AppState 共享,`question_answer` handler 按 batch_id 唤醒。
#[derive(Default)]
pub struct QuestionRegistry {
    pending: Mutex<HashMap<String, oneshot::Sender<Value>>>,
}

impl QuestionRegistry {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    fn register(&self, batch_id: &str) -> oneshot::Receiver<Value> {
        let (tx, rx) = oneshot::channel();
        self.pending
            .lock()
            .unwrap()
            .insert(batch_id.to_string(), tx);
        rx
    }

    /// 唤醒待回答问题;返回 true 表示找到并已唤醒。
    pub fn resolve(&self, batch_id: &str, answer: Value) -> bool {
        if let Some(tx) = self.pending.lock().unwrap().remove(batch_id) {
            let _ = tx.send(answer);
            true
        } else {
            false
        }
    }

    fn cancel(&self, batch_id: &str) {
        self.pending.lock().unwrap().remove(batch_id);
    }
}

/// 构建 `question` 工具:agent 调用时弹窗让用户回答,阻塞直到收到答案。
pub fn question_tool(
    session_id: String,
    tx: broadcast::Sender<Value>,
    registry: Arc<QuestionRegistry>,
    cancel_rx: watch::Receiver<bool>,
) -> DynamicTool {
    DynamicTool::new(
        "question",
        "向用户提问并等待回答。当需要用户决策、有多种方案需要用户挑选、或需要用户提供额外信息时使用。\
支持四种问题类型:single_choice(单选)、multi_choice(多选)、yes_no(是否)、free_text(自由输入)。\
可一次提多个问题(批量),用户会在弹窗中逐一回答后统一提交。\
注意:仅在确实需要用户输入时调用,能自己决定的不要频繁打扰用户。",
        json!({
            "type": "object",
            "properties": {
                "questions": {
                    "type": "array",
                    "minItems": 1,
                    "description": "问题列表(可包含多个问题)",
                    "items": {
                        "type": "object",
                        "properties": {
                            "type": {
                                "type": "string",
                                "enum": ["single_choice", "multi_choice", "yes_no", "free_text"],
                                "description": "问题类型:单选/多选/是否/自由输入"
                            },
                            "question": {
                                "type": "string",
                                "description": "问题文本(简明扼要,一行)"
                            },
                            "description": {
                                "type": "string",
                                "description": "问题补充说明(可选,给用户更多上下文)"
                            },
                            "choices": {
                                "type": "array",
                                "description": "选项列表(single_choice / multi_choice 必填)",
                                "items": {
                                    "type": "object",
                                    "properties": {
                                        "id": { "type": "string", "description": "选项唯一标识(英文短词)" },
                                        "label": { "type": "string", "description": "选项显示文本" },
                                        "description": { "type": "string", "description": "选项说明(可选)" }
                                    },
                                    "required": ["id", "label"]
                                }
                            }
                        },
                        "required": ["type", "question"]
                    }
                },
                "confirm_title": {
                    "type": "string",
                    "description": "弹窗标题(可选,默认「需要你的输入」)"
                },
                "confirm_description": {
                    "type": "string",
                    "description": "弹窗顶部说明文字(可选,解释为什么需要用户输入)"
                }
            },
            "required": ["questions"]
        }),
        move |_ctx, args| {
            let session_id = session_id.clone();
            let tx = tx.clone();
            let registry = registry.clone();
            let mut cancel_rx = cancel_rx.clone();
            Box::pin(async move {
                let raw_questions = args.get("questions").cloned().unwrap_or(Value::Array(vec![]));
                let confirm_title = args
                    .get("confirm_title")
                    .and_then(Value::as_str)
                    .unwrap_or("需要你的输入");
                let confirm_description = args
                    .get("confirm_description")
                    .and_then(Value::as_str)
                    .unwrap_or("");

                let questions_arr = match raw_questions.as_array() {
                    Some(a) if !a.is_empty() => a.clone(),
                    _ => return Ok(ToolOutput::text("错误: questions 不能为空")),
                };

                // 给每个问题补 id(LLM 可能不生成)
                let questions: Vec<Value> = questions_arr
                    .iter()
                    .enumerate()
                    .map(|(i, q)| {
                        let mut q = q.clone();
                        if q.get("id").and_then(Value::as_str).is_none() {
                            q["id"] = json!(format!("q{}", i + 1));
                        }
                        q
                    })
                    .collect();

                let batch_id = uuid::Uuid::new_v4().to_string();

                let request = json!({
                    "id": batch_id,
                    "session_id": session_id,
                    "tool_call_id": batch_id,
                    "questions": questions,
                    "confirm_title": confirm_title,
                    "confirm_description": confirm_description,
                });

                let _ = tx.send(json!({
                    "type": "question_batch_request",
                    "payload": { "type": "created", "payload": request }
                }));

                let rx = registry.register(&batch_id);
                tokio::pin!(rx);

                let answer = loop {
                    tokio::select! {
                        biased;
                        _ = cancel_rx.changed() => {
                            if *cancel_rx.borrow() {
                                registry.cancel(&batch_id);
                                let _ = tx.send(json!({
                                    "type": "question_batch_notification",
                                    "payload": { "type": "deleted", "payload": { "batch_id": batch_id } }
                                }));
                                return Ok(ToolOutput::text("问题已取消(运行被中断)"));
                            }
                            // false 告警,继续等待
                        }
                        result = &mut rx => {
                            break match result {
                                Ok(answer) => answer,
                                Err(_) => {
                                    return Ok(ToolOutput::text("问题已取消(未收到回答)"));
                                }
                            };
                        }
                    }
                };

                // 用户点击"跳过/让 agent 自行决定"
                if answer.get("skipped").and_then(Value::as_bool).unwrap_or(false) {
                    return Ok(ToolOutput::text(
                        "用户选择让你自行决定。请根据当前上下文做出最合理的判断并继续。",
                    ));
                }

                Ok(ToolOutput::text(format_answer(&questions, &answer)))
            })
        },
    )
}

/// 将用户回答格式化为 agent 可读的文本。
fn format_answer(questions: &[Value], answer: &Value) -> String {
    let responses = answer
        .get("responses")
        .and_then(|r| r.as_array())
        .cloned()
        .unwrap_or_default();

    // 建立 question id → question 的索引,用于查 choice label
    let qmap: HashMap<&str, &Value> = questions
        .iter()
        .filter_map(|q| q.get("id").and_then(Value::as_str).map(|id| (id, q)))
        .collect();

    if responses.is_empty() {
        return "用户未回答任何问题".to_string();
    }

    let mut out = String::from("用户回答如下:\n");
    for (i, resp) in responses.iter().enumerate() {
        let qid = resp.get("request_id").and_then(Value::as_str).unwrap_or("?");
        let q = qmap.get(qid).copied();
        let qtext = q
            .and_then(|q| q.get("question"))
            .and_then(Value::as_str)
            .unwrap_or(qid);

        if let Some(yes) = resp.get("yes").and_then(Value::as_bool) {
            out.push_str(&format!("{}. {} → {}\n", i + 1, qtext, if yes { "是" } else { "否" }));
        } else if let Some(ids) = resp.get("selected_ids").and_then(|v| v.as_array()) {
            // 将 choice id 翻译为 label,方便 agent 理解
            let choices = q.and_then(|q| q.get("choices")).and_then(|c| c.as_array());
            let labels: Vec<String> = ids
                .iter()
                .filter_map(|v| v.as_str())
                .map(|id| {
                    choices
                        .and_then(|cs| {
                            cs.iter().find(|c| c.get("id").and_then(Value::as_str) == Some(id))
                        })
                        .and_then(|c| c.get("label"))
                        .and_then(Value::as_str)
                        .unwrap_or(id)
                        .to_string()
                })
                .collect();
            // 「其他(手动输入)」的自定义答案:与已选选项合并输出
            // (前端 QuestionCard 允许单选/多选同时附带自定义文本)
            let custom = resp
                .get("fill_in_text")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|t| !t.is_empty());
            let mut parts: Vec<String> = Vec::new();
            if !labels.is_empty() {
                parts.push(labels.join(", "));
            }
            match custom {
                // 仅有自定义(没选任何预置选项)→ 直接输出文本,不加前缀
                Some(text) if parts.is_empty() => parts.push(text.to_string()),
                // 选项 + 自定义并存 → 标注「自定义:」便于 agent 区分
                Some(text) => parts.push(format!("自定义:{}", text)),
                None => {}
            }
            if parts.is_empty() {
                out.push_str(&format!("{}. {} → (未选择)\n", i + 1, qtext));
            } else {
                out.push_str(&format!("{}. {} → {}\n", i + 1, qtext, parts.join(" | ")));
            }
        } else if let Some(text) = resp.get("fill_in_text").and_then(Value::as_str) {
            if text.is_empty() {
                out.push_str(&format!("{}. {} → (用户未输入)\n", i + 1, qtext));
            } else {
                out.push_str(&format!("{}. {} → {}\n", i + 1, qtext, text));
            }
        } else {
            out.push_str(&format!("{}. {} → (未知回答格式)\n", i + 1, qtext));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn format_single_choice_answer() {
        let questions = vec![json!({
            "id": "q1",
            "type": "single_choice",
            "question": "用哪个数据库?",
            "choices": [
                {"id": "pg", "label": "PostgreSQL"},
                {"id": "mongo", "label": "MongoDB"}
            ]
        })];
        let answer = json!({
            "responses": [{"request_id": "q1", "selected_ids": ["pg"]}]
        });
        let out = format_answer(&questions, &answer);
        assert!(out.contains("PostgreSQL"));
    }

    #[test]
    fn format_choice_with_custom_text_only() {
        // 前端「其他(手动输入)」:未选预置选项,仅输入自定义文本
        let questions = vec![json!({
            "id": "q1",
            "type": "single_choice",
            "question": "用哪个分支?",
            "choices": [{"id": "main", "label": "main"}]
        })];
        let answer = json!({
            "responses": [{"request_id": "q1", "selected_ids": [], "fill_in_text": "feature/xyz"}]
        });
        let out = format_answer(&questions, &answer);
        assert!(out.contains("feature/xyz"));
        assert!(!out.contains("自定义:"));
        assert!(!out.contains("(未选择)"));
    }

    #[test]
    fn format_multi_choice_with_options_and_custom() {
        // 多选:预置选项 + 「其他」自定义文本并存,合并输出
        let questions = vec![json!({
            "id": "q1",
            "type": "multi_choice",
            "question": "要哪些功能?",
            "choices": [{"id": "a", "label": "选项A"}]
        })];
        let answer = json!({
            "responses": [{"request_id": "q1", "selected_ids": ["a"], "fill_in_text": "再加个开关"}]
        });
        let out = format_answer(&questions, &answer);
        assert!(out.contains("选项A"));
        assert!(out.contains("自定义:再加个开关"));
        assert!(out.contains("选项A | 自定义:再加个开关"));
    }

    #[test]
    fn format_yes_no_answer() {
        let questions = vec![json!({"id": "q1", "type": "yes_no", "question": "继续?"})];
        let answer = json!({"responses": [{"request_id": "q1", "yes": true}]});
        let out = format_answer(&questions, &answer);
        assert!(out.contains("是"));
    }

    #[test]
    fn format_free_text_answer() {
        let questions = vec![json!({"id": "q1", "type": "free_text", "question": "项目名?"})];
        let answer = json!({"responses": [{"request_id": "q1", "fill_in_text": "combo"}]});
        let out = format_answer(&questions, &answer);
        assert!(out.contains("combo"));
    }

    #[test]
    fn registry_resolve_wakes_waiter() {
        let reg = QuestionRegistry::default();
        let rx = reg.register("batch-1");
        assert!(reg.resolve("batch-1", json!({"ok": true})));
        let val = rx.blocking_recv().unwrap();
        assert_eq!(val["ok"], true);
    }

    #[test]
    fn registry_resolve_missing_returns_false() {
        let reg = QuestionRegistry::default();
        assert!(!reg.resolve("nope", json!({})));
    }
}
