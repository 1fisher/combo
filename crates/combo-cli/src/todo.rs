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
// snake_case:InProgress 序列化为 "in_progress"(与前端 Api.TodoStatus 一致)。
// 此前用 lowercase 会产出 "inprogress",前端按 'in_progress' 匹配失败,
// 退化为「第一条 pending」推导当前项,导致当前项错位到第二条。
#[serde(rename_all = "snake_case")]
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

/// 若列表中没有 in_progress 且存在 pending,自动把第一个 pending 标记为 in_progress,
/// 保证一次性提交完整任务列表时「从第一条开始处理」,前端能立即看到第一条处于进行中。
fn auto_start_first(todos: &mut [TodoItem]) {
    if todos.iter().any(|t| t.status == TodoStatus::InProgress) {
        return;
    }
    if let Some(first) = todos.iter_mut().find(|t| t.status == TodoStatus::Pending) {
        first.status = TodoStatus::InProgress;
    }
}

/// 状态继承:LLM 每次全量重写任务列表时,常会把之前已完成的任务又写成
/// pending(丢失历史状态),导致进度倒退、前端「当前处理项」错位。这里按
/// content 精确匹配,把旧列表中已完成、新列表中又退回 pending 的条目自动
/// 恢复为 completed。返回被恢复的 (序号, 描述) 列表,供工具返回文本告知
/// agent;agent 若确需重做某项,可修改该项任务描述后重新提交以绕过继承。
///
/// 仅在两个证据同时成立时才继承,防止误伤同会话的**新计划**:
/// 1. 旧列表仍有未完成项(in_progress/pending),即计划还在进行中。已全部
///    完成的旧清单属于上一个已结束的任务,同会话的下一个计划即使复用了
///    相同的任务描述(如「运行测试」)也是全新计划,继承会把新计划的第一条
///    (乃至全部)直接标成 completed,导致开局从下标 1 开始、跳过第一条;
/// 2. 新列表仍覆盖旧列表的**全部**已完成条目(按 content 匹配)。同一计划
///    的全量重写会保留所有条目;只命中个别同名条目(改写/删除了已完成项)
///    视为计划已调整,不继承。
fn inherit_completed(prev: &[TodoItem], next: &mut [TodoItem]) -> Vec<(usize, String)> {
    let mut restored = Vec::new();
    // 证据 1:旧计划仍在进行中(全部已完成 = 上一个任务已收尾,不继承)
    if prev.iter().all(|t| t.status == TodoStatus::Completed) {
        return restored;
    }
    let prev_completed: Vec<&str> = prev
        .iter()
        .filter(|t| t.status == TodoStatus::Completed)
        .map(|t| t.content.as_str())
        .collect();
    // 证据 2:新列表覆盖旧计划全部已完成条目(同一计划的全量重写)
    if !prev_completed
        .iter()
        .all(|c| next.iter().any(|t| t.content == *c))
    {
        return restored;
    }
    for (i, t) in next.iter_mut().enumerate() {
        if t.status == TodoStatus::Pending && prev_completed.contains(&t.content.as_str()) {
            t.status = TodoStatus::Completed;
            restored.push((i + 1, t.content.clone()));
        }
    }
    restored
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

    pub fn get(&self, session_id: &str) -> Option<Vec<TodoItem>> {
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
每次调用传入**完整**的任务列表(全量覆盖,而非增量更新),且**必须保留之前已完成任务的 completed 状态**(漏标会导致进度倒退)。\
规则:\
(1) 仅在需要分步处理的多步骤任务时使用(3 步以上的工作),简单单步任务无需创建;\
(2) 同一时刻只能有一个任务处于 in_progress 状态;\
(3) **开始**处理某个任务前,先调用本工具将其标记为 in_progress 再动手;\
(4) **完成**某个任务后立即调用本工具将其标记为 completed(并把下一项标为 in_progress),不要攒几项一起更新;\
(5) 如果计划发生变化(新增/删除/调整顺序),用更新后的完整列表再次调用(已完成的不受影响,保持 completed)。\
注意:若提交的列表中没有任何 in_progress 且存在 pending,工具会自动把第一条 pending \
标记为 in_progress(从第一条开始处理);agent 处理时按顺序逐条推进即可。",
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

                // 状态继承:LLM 重写列表时可能把之前已完成的任务又写成 pending,
                // 这里按 content 匹配自动恢复 completed,防止进度倒退、当前项错位。
                let prev = store.get(&session_id).unwrap_or_default();
                let restored = inherit_completed(&prev, &mut todos);

                // 自动从第一条开始处理:若列表中没有 in_progress 且存在 pending,
                // 自动把第一个 pending 标记为 in_progress(agent 一次性提交完整列表时
                // 通常不会自标状态,前端需要立即知道「正在处理第一条」)。
                auto_start_first(&mut todos);

                // 统计信息
                let total = todos.len();
                let completed = todos
                    .iter()
                    .filter(|t| t.status == TodoStatus::Completed)
                    .count();
                let current_idx = todos
                    .iter()
                    .position(|t| t.status == TodoStatus::InProgress);

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
                if !restored.is_empty() {
                    let items = restored
                        .iter()
                        .map(|(i, _)| format!("第 {i} 项"))
                        .collect::<Vec<_>>()
                        .join("、");
                    summary.push_str(&format!(
                        "\n注意:{items}此前已完成,已自动保留 completed 状态(你提交的是 pending)。\
如确需重做,请修改该项的任务描述后重新提交。\n"
                    ));
                }
                if let Some(idx) = current_idx {
                    summary.push_str(&format!(
                        "\n当前进行中:第 {}/{} 项「{}」。",
                        idx + 1,
                        total,
                        todos[idx].content
                    ));
                    // 下一步指引:明确告诉 agent 完成后该把哪一条标成什么,
                    // 持续强化「即时更新 + 对准第几项」的纪律。
                    match todos.iter().position(|t| t.status == TodoStatus::Pending) {
                        Some(next) => summary.push_str(&format!(
                            "\n提示:完成该项后立即调用 todo_write,将其标为 completed \
并把第 {} 项标为 in_progress;提交时保留已完成任务的 completed 状态。",
                            next + 1
                        )),
                        None => summary.push_str(
                            "\n提示:这是最后一项;完成后调用 todo_write 将其标为 completed 即可。",
                        ),
                    }
                } else if completed == total {
                    summary.push_str("\n任务清单已全部完成,无需再更新。");
                }
                Ok(ToolOutput::text(summary))
            })
        },
    )
}

/// 为新一轮 run 的 prompt 生成「任务清单状态」上下文(清单存在且未全部完成时)。
///
/// 中断续跑场景:上一轮 agent 未跑完(报错/取消/用户中断),清单仍留在
/// TodoStore 里;新一轮 run 若不注入,agent 只能从对话历史里猜「现在该做
/// 第几项」,常导致进度错位。注入后 agent 开局即对准当前进度。
pub fn todo_context_prompt(todos: &[TodoItem]) -> Option<String> {
    if todos.is_empty() || todos.iter().all(|t| t.status == TodoStatus::Completed) {
        return None;
    }
    let total = todos.len();
    let completed = todos
        .iter()
        .filter(|t| t.status == TodoStatus::Completed)
        .count();
    let mut lines = vec![format!(
        "[当前任务清单状态]({completed}/{total} 已完成,来自上一轮 todo_write,以本状态为准):"
    )];
    for (i, t) in todos.iter().enumerate() {
        let mark = match t.status {
            TodoStatus::Completed => "x",
            TodoStatus::InProgress => ">",
            TodoStatus::Pending => " ",
        };
        lines.push(format!("  [{mark}] {}. {}", i + 1, t.content));
    }
    if let Some(idx) = todos.iter().position(|t| t.status == TodoStatus::InProgress) {
        lines.push(format!(
            "当前进行中:第 {}/{} 项「{}」。",
            idx + 1,
            total,
            todos[idx].content
        ));
    }
    lines.push(
        "- 若本次请求是继续该清单:从「当前进行中」的任务接着做;每完成一项立即调用 \
todo_write 更新状态(完成标 completed、下一项标 in_progress),提交时保留已完成任务的 completed 状态。"
            .into(),
    );
    lines.push(
        "- 若计划需要调整:调用 todo_write 提交调整后的完整列表(已完成的不受影响,保持 completed)。"
            .into(),
    );
    lines.push("- 若本次请求与该清单无关:忽略以上内容。".into());
    Some(lines.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn todo_status_serializes_snake_case_wire_format() {
        // SSE 下发的前端 Api.TodoStatus 期望 'pending' | 'in_progress' | 'completed';
        // 若 serde 退回 lowercase(产出 "inprogress"),前端按 'in_progress'
        // 匹配失败,「当前处理项」会错位到第一条 pending。
        assert_eq!(
            serde_json::to_value(TodoStatus::Pending).unwrap(),
            serde_json::json!("pending")
        );
        assert_eq!(
            serde_json::to_value(TodoStatus::InProgress).unwrap(),
            serde_json::json!("in_progress")
        );
        assert_eq!(
            serde_json::to_value(TodoStatus::Completed).unwrap(),
            serde_json::json!("completed")
        );
    }

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
    fn auto_start_first_marks_first_pending_when_all_pending() {
        let mut todos = vec![
            TodoItem { content: "任务1".into(), status: TodoStatus::Pending, active_form: None },
            TodoItem { content: "任务2".into(), status: TodoStatus::Pending, active_form: None },
            TodoItem { content: "任务3".into(), status: TodoStatus::Pending, active_form: None },
        ];
        auto_start_first(&mut todos);
        assert_eq!(todos[0].status, TodoStatus::InProgress);
        assert_eq!(todos[1].status, TodoStatus::Pending);
        assert_eq!(todos[2].status, TodoStatus::Pending);
    }

    #[test]
    fn auto_start_first_keeps_existing_in_progress() {
        let mut todos = vec![
            TodoItem { content: "任务1".into(), status: TodoStatus::Completed, active_form: None },
            TodoItem { content: "任务2".into(), status: TodoStatus::InProgress, active_form: Some("正在处理任务2".into()) },
            TodoItem { content: "任务3".into(), status: TodoStatus::Pending, active_form: None },
        ];
        auto_start_first(&mut todos);
        assert_eq!(todos[1].status, TodoStatus::InProgress);
        assert_eq!(todos[2].status, TodoStatus::Pending);
    }

    #[test]
    fn auto_start_first_resumes_at_first_pending() {
        // 已有完成项、无 in_progress:自动从第一个 pending 继续
        let mut todos = vec![
            TodoItem { content: "任务1".into(), status: TodoStatus::Completed, active_form: None },
            TodoItem { content: "任务2".into(), status: TodoStatus::Pending, active_form: None },
            TodoItem { content: "任务3".into(), status: TodoStatus::Pending, active_form: None },
        ];
        auto_start_first(&mut todos);
        assert_eq!(todos[0].status, TodoStatus::Completed);
        assert_eq!(todos[1].status, TodoStatus::InProgress);
        assert_eq!(todos[2].status, TodoStatus::Pending);
    }

    #[test]
    fn auto_start_first_noop_when_all_completed() {
        let mut todos = vec![
            TodoItem { content: "任务1".into(), status: TodoStatus::Completed, active_form: None },
            TodoItem { content: "任务2".into(), status: TodoStatus::Completed, active_form: None },
        ];
        auto_start_first(&mut todos);
        assert!(todos.iter().all(|t| t.status == TodoStatus::Completed));
    }

    fn item(content: &str, status: TodoStatus) -> TodoItem {
        TodoItem { content: content.into(), status, active_form: None }
    }

    #[test]
    fn inherit_completed_restores_lost_status() {
        // LLM 重写列表丢了已完成状态 → 按 content 自动恢复
        // (旧计划仍在进行中:还有 pending 项未做完)
        let prev = vec![
            item("安装依赖", TodoStatus::Completed),
            item("编译项目", TodoStatus::Completed),
            item("运行测试", TodoStatus::Pending),
        ];
        let mut next = vec![
            item("安装依赖", TodoStatus::Pending),
            item("编译项目", TodoStatus::Pending),
            item("运行测试", TodoStatus::Pending),
        ];
        let restored = inherit_completed(&prev, &mut next);
        assert_eq!(next[0].status, TodoStatus::Completed);
        assert_eq!(next[1].status, TodoStatus::Completed);
        // 未完成项不受影响
        assert_eq!(next[2].status, TodoStatus::Pending);
        assert_eq!(restored.len(), 2);
        assert_eq!(restored[0], (1, "安装依赖".to_string()));
        assert_eq!(restored[1], (2, "编译项目".to_string()));
    }

    #[test]
    fn inherit_completed_noop_when_prev_plan_finished() {
        // 旧清单已全部完成(上一个任务收尾),同会话的新计划即使复用了相同
        // 任务描述也不能继承,否则新计划第一条被直接标成 completed、被跳过
        let prev = vec![
            item("分析需求", TodoStatus::Completed),
            item("运行测试", TodoStatus::Completed),
        ];
        let mut next = vec![
            item("分析需求", TodoStatus::Pending),
            item("运行测试", TodoStatus::Pending),
            item("部署上线", TodoStatus::Pending),
        ];
        assert!(inherit_completed(&prev, &mut next).is_empty());
        auto_start_first(&mut next);
        // 从第一条(下标 0)开始处理,不跳过
        assert_eq!(next[0].status, TodoStatus::InProgress);
        assert_eq!(next[1].status, TodoStatus::Pending);
        assert_eq!(next[2].status, TodoStatus::Pending);
    }

    #[test]
    fn inherit_completed_requires_full_coverage_of_prev_completed() {
        // 旧计划进行中,但新列表改写了已完成条目的描述(未全覆盖)→ 不继承
        let prev = vec![
            item("安装依赖", TodoStatus::Completed),
            item("编译项目", TodoStatus::Pending),
        ];
        let mut next = vec![
            item("重新安装依赖", TodoStatus::Pending),
            item("编译项目", TodoStatus::Pending),
        ];
        assert!(inherit_completed(&prev, &mut next).is_empty());
        assert!(next.iter().all(|t| t.status == TodoStatus::Pending));
    }

    #[test]
    fn inherit_completed_skips_modified_content() {
        // agent 修改了任务描述(如重做)→ 不继承,尊重 agent 的新列表
        let prev = vec![
            item("实现功能 A", TodoStatus::Completed),
            item("联调验证", TodoStatus::Pending),
        ];
        let mut next = vec![
            item("重新实现功能 A", TodoStatus::Pending),
            item("联调验证", TodoStatus::Pending),
        ];
        let restored = inherit_completed(&prev, &mut next);
        assert!(restored.is_empty());
        assert_eq!(next[0].status, TodoStatus::Pending);
    }

    #[test]
    fn inherit_completed_noop_without_prev() {
        // 首次提交(无旧列表)→ 不继承
        let mut next = vec![item("任务1", TodoStatus::Pending)];
        assert!(inherit_completed(&[], &mut next).is_empty());
        assert_eq!(next[0].status, TodoStatus::Pending);
    }

    #[test]
    fn inherit_completed_ignores_non_completed_prev() {
        // 旧列表里是 in_progress(未完成)→ 不恢复为 completed
        let prev = vec![item("任务1", TodoStatus::InProgress)];
        let mut next = vec![item("任务1", TodoStatus::Pending)];
        assert!(inherit_completed(&prev, &mut next).is_empty());
        assert_eq!(next[0].status, TodoStatus::Pending);
    }

    #[test]
    fn inherit_then_auto_start_resumes_correctly() {
        // 继承 + 自动推进组合:丢状态的提交也能恢复到正确的「当前项」
        let prev = vec![
            item("任务1", TodoStatus::Completed),
            item("任务2", TodoStatus::Completed),
            item("任务4", TodoStatus::Pending),
        ];
        let mut next = vec![
            item("任务1", TodoStatus::Pending),
            item("任务2", TodoStatus::Pending),
            item("任务3", TodoStatus::Pending),
        ];
        inherit_completed(&prev, &mut next);
        auto_start_first(&mut next);
        assert_eq!(next[0].status, TodoStatus::Completed);
        assert_eq!(next[1].status, TodoStatus::Completed);
        // 前两项已恢复完成,当前项应推进到第 3 项
        assert_eq!(next[2].status, TodoStatus::InProgress);
    }

    #[test]
    fn todo_context_prompt_injects_when_unfinished() {
        let todos = vec![
            item("任务1", TodoStatus::Completed),
            item("任务2", TodoStatus::InProgress),
            item("任务3", TodoStatus::Pending),
        ];
        let ctx = todo_context_prompt(&todos).unwrap();
        assert!(ctx.contains("[当前任务清单状态](1/3 已完成"));
        assert!(ctx.contains("当前进行中:第 2/3 项「任务2」"));
        assert!(ctx.contains("保留已完成任务的 completed 状态"));
    }

    #[test]
    fn todo_context_prompt_none_when_all_completed_or_empty() {
        assert!(todo_context_prompt(&[]).is_none());
        assert!(todo_context_prompt(&[
            item("任务1", TodoStatus::Completed),
            item("任务2", TodoStatus::Completed),
        ])
        .is_none());
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
