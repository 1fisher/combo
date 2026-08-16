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

/// 待回答问题条目:携带所属 session,run 结束时可按会话批量回收
/// (接收端已随任务销毁,残留的 sender 只会无限累积)。
struct PendingQuestion {
    session_id: String,
    tx: oneshot::Sender<Value>,
}

/// 待回答问题的注册表:batch_id → 待答条目。
/// 通过 AppState 共享,`question_answer` handler 按 batch_id 唤醒。
#[derive(Default)]
pub struct QuestionRegistry {
    pending: Mutex<HashMap<String, PendingQuestion>>,
}

impl QuestionRegistry {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    fn register(&self, batch_id: &str, session_id: &str) -> oneshot::Receiver<Value> {
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(
            batch_id.to_string(),
            PendingQuestion {
                session_id: session_id.to_string(),
                tx,
            },
        );
        rx
    }

    /// 唤醒待回答问题;返回 true 表示找到并已唤醒。
    pub fn resolve(&self, batch_id: &str, answer: Value) -> bool {
        if let Some(p) = self.pending.lock().unwrap().remove(batch_id) {
            let _ = p.tx.send(answer);
            true
        } else {
            false
        }
    }

    fn cancel(&self, batch_id: &str) {
        self.pending.lock().unwrap().remove(batch_id);
    }

    /// 回收指定会话全部未被回答的问题条目(run 结束/会话删除时调用)。
    pub(crate) fn cancel_pending(&self, session_id: &str) {
        self.pending
            .lock()
            .unwrap()
            .retain(|_, p| p.session_id != session_id);
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
                let raw_questions =
                    coerce_questions(args.get("questions").cloned().unwrap_or(Value::Array(vec![])));
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

                // 规范化每个问题:补 id、归一 type/choices(LLM 常漏 type 或写错字段名,
                // 前端按 type 分支渲染,漏了 type 选项就不会显示)
                let questions: Vec<Value> = questions_arr
                    .iter()
                    .enumerate()
                    .map(|(i, q)| normalize_question(q.clone(), i))
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

                let rx = registry.register(&batch_id, &session_id);
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

/// `questions` 参数容错:数组原样返回;JSON 字符串(部分模型沿用其他工具的
/// 字符串传参习惯)解析为数组;其余置为空数组。
fn coerce_questions(v: Value) -> Value {
    match v {
        Value::String(s) => serde_json::from_str(&s).unwrap_or(Value::Array(vec![])),
        Value::Array(_) => v,
        _ => Value::Array(vec![]),
    }
}

/// 规范化单个问题条目,容错 LLM 常见偏差:
/// - 补 `id`(LLM 可能不生成)
/// - `options` → `choices`(字段名混用)
/// - 纯字符串选项 → `{id, label}`;对象缺 id 时按序号补
/// - `type` 别名归一(single/multi/boolean/text…);缺失时有选项默认
///   `single_choice`,无选项默认 `free_text`(前端按 type 分支渲染,
///   漏了 type 选项区会整个不显示)
fn normalize_question(mut q: Value, idx: usize) -> Value {
    if !q.is_object() {
        return q;
    }
    if q.get("id").and_then(Value::as_str).is_none() {
        q["id"] = json!(format!("q{}", idx + 1));
    }
    if q.get("choices").map_or(true, Value::is_null) {
        if let Some(opts) = q.get("options").cloned() {
            q["choices"] = opts;
        }
    }
    if let Some(arr) = q.get_mut("choices").and_then(Value::as_array_mut) {
        for (i, c) in arr.iter_mut().enumerate() {
            if let Some(s) = c.as_str() {
                let label = s.to_string();
                *c = json!({ "id": format!("opt{}", i + 1), "label": label });
            } else if c.is_object() {
                if c.get("id").and_then(Value::as_str).is_none() {
                    c["id"] = json!(format!("opt{}", i + 1));
                }
            } else if !c.is_null() {
                let label = c.to_string();
                *c = json!({ "id": format!("opt{}", i + 1), "label": label });
            }
        }
    }
    let has_choices = q
        .get("choices")
        .and_then(Value::as_array)
        .map_or(false, |a| !a.is_empty());
    let canonical = match q
        .get("type")
        .and_then(Value::as_str)
        .map(|t| t.trim().to_lowercase())
        .as_deref()
    {
        Some("single_choice" | "single" | "choice" | "radio") => "single_choice",
        Some("multi_choice" | "multi" | "multiple_choice" | "multi_select" | "checkbox") => {
            "multi_choice"
        }
        Some("yes_no" | "yesno" | "yes/no" | "boolean" | "bool" | "confirm") => "yes_no",
        Some("free_text" | "text" | "free" | "input" | "string") => "free_text",
        _ => {
            if has_choices {
                "single_choice"
            } else {
                "free_text"
            }
        }
    };
    q["type"] = json!(canonical);
    q
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
    fn normalize_adds_missing_type_and_id() {
        // LLM 漏 type:有 choices → single_choice;无 choices → free_text;同时补 id
        let q = normalize_question(
            json!({"question": "选哪个?", "choices": [{"id": "a", "label": "A"}]}),
            0,
        );
        assert_eq!(q["type"], "single_choice");
        assert_eq!(q["id"], "q1");
        let q = normalize_question(json!({"question": "名字?"}), 1);
        assert_eq!(q["type"], "free_text");
        assert_eq!(q["id"], "q2");
    }

    #[test]
    fn normalize_maps_type_aliases() {
        for (raw, want) in [
            ("single", "single_choice"),
            ("Multi", "multi_choice"),
            ("boolean", "yes_no"),
            ("text", "free_text"),
        ] {
            let q = normalize_question(json!({"type": raw, "question": "q"}), 0);
            assert_eq!(q["type"], want, "alias {}", raw);
        }
    }

    #[test]
    fn normalize_moves_options_and_fixes_choices() {
        // options → choices;纯字符串选项转 {id, label};对象缺 id 补序号
        let q = normalize_question(
            json!({"type": "single", "question": "选?", "options": ["甲", "乙"]}),
            0,
        );
        assert_eq!(q["choices"][0]["id"], "opt1");
        assert_eq!(q["choices"][0]["label"], "甲");
        assert_eq!(q["choices"][1]["label"], "乙");
        let q = normalize_question(
            json!({"type": "single", "question": "选?", "choices": [{"label": "只有label"}]}),
            0,
        );
        assert_eq!(q["choices"][0]["id"], "opt1");
        assert_eq!(q["choices"][0]["label"], "只有label");
    }

    #[test]
    fn coerce_questions_parses_json_string() {
        let v = coerce_questions(Value::String(
            r#"[{"type":"yes_no","question":"继续?"}]"#.to_string(),
        ));
        assert_eq!(v.as_array().map(Vec::len), Some(1));
        // 非法字符串与其他类型 → 空数组
        assert!(coerce_questions(json!("not json")).as_array().unwrap().is_empty());
        assert!(coerce_questions(json!({"a": 1})).as_array().unwrap().is_empty());
    }

    #[test]
    fn registry_resolve_wakes_waiter() {
        let reg = QuestionRegistry::default();
        let rx = reg.register("batch-1", "s1");
        assert!(reg.resolve("batch-1", json!({"ok": true})));
        let val = rx.blocking_recv().unwrap();
        assert_eq!(val["ok"], true);
    }

    #[test]
    fn registry_resolve_missing_returns_false() {
        let reg = QuestionRegistry::default();
        assert!(!reg.resolve("nope", json!({})));
    }

    #[test]
    fn registry_cancel_pending_drops_only_that_session() {
        let reg = QuestionRegistry::default();
        let rx1 = reg.register("b1", "s1");
        let rx2 = reg.register("b2", "s2");
        // run 结束回收 s1 的待答问题:s1 的接收端收到关闭,s2 不受影响
        reg.cancel_pending("s1");
        assert!(rx1.blocking_recv().is_err());
        assert!(reg.resolve("b2", json!({"ok": true})));
        assert_eq!(rx2.blocking_recv().unwrap()["ok"], true);
    }
}
