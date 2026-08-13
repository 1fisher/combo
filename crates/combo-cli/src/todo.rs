//! Todo 工具:让 agent 管理任务列表,实时推送给前端展示进度。
//!
//! 工具调用流程:
//! 1. agent 调用 `todo_write` 工具,传入完整任务列表
//! 2. 工具将任务列表存入 TodoStore(session 维度),经 broadcast 发送 `todo_update` SSE 事件
//! 3. 前端接收事件后更新 Zustand store,实时渲染任务列表与当前进度

use rig::tool::{DynamicTool, ToolOutput};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio::sync::broadcast;

/// 单个待办项的状态。
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TodoStatus {
    Pending,
    InProgress,
    Completed,
}

impl TodoStatus {
    fn parse(s: &str) -> TodoStatus {
        match s.to_lowercase().as_str() {
            "in_progress" | "inprogress" | "in-progress" => TodoStatus::InProgress,
            "completed" | "done" | "complete" => TodoStatus::Completed,
            _ => TodoStatus::Pending,
        }
    }
}

/// 单个待办项。
#[derive(Clone, Debug, serde::Serialize)]
pub struct TodoItem {
    pub content: String,
    pub status: TodoStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_form: Option<String>,
}

/// 按 session 维度保存任务列表,供前端订阅后查询或跨重连恢复。
#[derive(Default)]
pub struct TodoStore {
    sessions: Mutex<HashMap<String, Vec<TodoItem>>>,
}

impl TodoStore {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    fn set(&self, session_id: &str, todos: Vec<TodoItem>) {
        self.sessions
            .lock()
            .unwrap()
            .insert(session_id.to_string(), todos);
    }

    #[allow(dead_code)]
    fn get(&self, session_id: &str) -> Option<Vec<TodoItem>> {
        self.sessions.lock().unwrap().get(session_id).cloned()
    }

    fn clear(&self, session_id: &str) {
        self.sessions.lock().unwrap().remove(session_id);
    }
}

/// 构建 `todo_write` 工具:agent 调用时更新任务列表并广播给前端。
///
/// 每次调用传入完整列表(非增量),工具校验后覆写存储并广播 `todo_update`。
pub fn todo_write_tool(
    session_id: String,
    tx: broadcast::Sender<Value>,
    store: Arc<TodoStore>,
) -> DynamicTool {
    DynamicTool::new(
        "todo_write",
        "管理任务列表(Todo List)。用于将多步骤工作拆分为可追踪的任务清单,实时展示进度。\
每次调用传入**完整**的任务列表(全量覆盖,而非增量更新)。\
规则:\
(1) 仅在需要分步处理的多步骤任务时使用(3 步以上的工作),简单单步任务无需创建;\
(2) 同一时刻只能有一个任务处于 in_progress 状态;\
(3) 开始处理某个任务时,将其标记为 in_progress;\
(4) 完成某个任务后立即将其标记为 completed;\
(5) 如果计划发生变化(新增/删除/调整顺序),用更新后的完整列表再次调用。",
        json!({
            "type": "object",
            "properties": {
                "todos": {
                    "type": "array",
                    "description": "完整任务列表(全量覆盖)",
                    "items": {
                        "type": "object",
                        "properties": {
                            "content": {
                                "type": "string",
                                "description": "任务描述(祈使句,如「安装依赖并编译项目」)"
                            },
                            "status": {
                                "type": "string",
                                "enum": ["pending", "in_progress", "completed"],
                                "description": "任务状态:pending=待处理、in_progress=进行中(同时只能有一个)、completed=已完成"
                            },
                            "active_form": {
                                "type": "string",
                                "description": "任务进行中时的现在进行时描述(如「正在编译项目」),可选"
                            }
                        },
                        "required": ["content", "status"]
                    }
                }
            },
            "required": ["todos"]
        }),
        move |_ctx, args| {
            let session_id = session_id.clone();
            let tx = tx.clone();
            let store = store.clone();
            Box::pin(async move {
                let raw_todos = match args.get("todos").and_then(Value::as_array) {
                    Some(a) => a.clone(),
                    None => return Ok(ToolOutput::text("错误: todos 必须是数组")),
                };

                if raw_todos.is_empty() {
                    // 空列表:清除该 session 的任务
                    store.clear(&session_id);
                    let _ = tx.send(json!({
                        "type": "todo_update",
                        "payload": { "type": "deleted", "payload": { "session_id": session_id } }
                    }));
                    return Ok(ToolOutput::text("任务列表已清空"));
                }

                let mut todos: Vec<TodoItem> = Vec::with_capacity(raw_todos.len());
                for (i, item) in raw_todos.iter().enumerate() {
                    let content = item
                        .get("content")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .trim()
                        .to_string();
                    if content.is_empty() {
                        return Ok(ToolOutput::text(format!(
                            "错误: 第 {} 个任务缺少 content",
                            i + 1
                        )));
                    }
                    let status_str = item
                        .get("status")
                        .and_then(Value::as_str)
                        .unwrap_or("pending");
                    let active_form = item
                        .get("active_form")
                        .and_then(Value::as_str)
                        .map(|s| s.to_string());
                    todos.push(TodoItem {
                        content,
                        status: TodoStatus::parse(status_str),
                        active_form,
                    });
                }

                // 校验:最多一个 in_progress
                let in_progress_count = todos
                    .iter()
                    .filter(|t| t.status == TodoStatus::InProgress)
                    .count();
                if in_progress_count > 1 {
                    return Ok(ToolOutput::text(format!(
                        "错误: 同时只能有一个任务处于 in_progress 状态,当前有 {in_progress_count} 个"
                    )));
                }

                // 统计信息
                let total = todos.len();
                let completed = todos
                    .iter()
                    .filter(|t| t.status == TodoStatus::Completed)
                    .count();
                let in_progress = todos
                    .iter()
                    .find(|t| t.status == TodoStatus::InProgress)
                    .map(|t| t.content.clone());

                store.set(&session_id, todos.clone());

                // 广播给前端
                let _ = tx.send(json!({
                    "type": "todo_update",
                    "payload": {
                        "type": "updated",
                        "payload": {
                            "session_id": session_id,
                            "todos": todos,
                        }
                    }
                }));

                let mut summary = format!("任务列表已更新({completed}/{total} 完成):\n");
                for (i, t) in todos.iter().enumerate() {
                    let mark = match t.status {
                        TodoStatus::Completed => "x",
                        TodoStatus::InProgress => ">",
                        TodoStatus::Pending => " ",
                    };
                    summary.push_str(&format!("  [{mark}] {}. {}\n", i + 1, t.content));
                }
                if let Some(current) = in_progress {
                    summary.push_str(&format!("\n当前进行中:{current}"));
                }
                Ok(ToolOutput::text(summary))
            })
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn todo_status_parse_variants() {
        assert_eq!(TodoStatus::parse("pending"), TodoStatus::Pending);
        assert_eq!(TodoStatus::parse("PENDING"), TodoStatus::Pending);
        assert_eq!(TodoStatus::parse("in_progress"), TodoStatus::InProgress);
        assert_eq!(TodoStatus::parse("inprogress"), TodoStatus::InProgress);
        assert_eq!(TodoStatus::parse("completed"), TodoStatus::Completed);
        assert_eq!(TodoStatus::parse("done"), TodoStatus::Completed);
        assert_eq!(TodoStatus::parse("anything"), TodoStatus::Pending);
    }

    #[test]
    fn todo_store_set_get_clear() {
        let store = TodoStore::new();
        let todos = vec![
            TodoItem { content: "任务A".into(), status: TodoStatus::Completed, active_form: None },
            TodoItem { content: "任务B".into(), status: TodoStatus::InProgress, active_form: Some("正在处理B".into()) },
            TodoItem { content: "任务C".into(), status: TodoStatus::Pending, active_form: None },
        ];
        store.set("s1", todos.clone());
        let got = store.get("s1").unwrap();
        assert_eq!(got.len(), 3);
        assert_eq!(got[0].content, "任务A");
        assert_eq!(got[1].active_form.as_deref(), Some("正在处理B"));

        store.clear("s1");
        assert!(store.get("s1").is_none());
    }

    #[test]
    fn todo_store_isolates_sessions() {
        let store = TodoStore::new();
        store.set(
            "s1",
            vec![TodoItem { content: "A".into(), status: TodoStatus::Pending, active_form: None }],
        );
        store.set(
            "s2",
            vec![TodoItem { content: "B".into(), status: TodoStatus::Pending, active_form: None }],
        );
        assert_eq!(store.get("s1").unwrap()[0].content, "A");
        assert_eq!(store.get("s2").unwrap()[0].content, "B");
        store.clear("s1");
        assert!(store.get("s1").is_none());
        assert!(store.get("s2").is_some());
    }
}
