//! 内置工具:通过 rig 的 DynamicTool 提供给 agent 调用。

use rig::tool::DynamicTool;
use serde_json::json;

/// 返回内置工具列表(当前时间/日期)。
pub fn builtin_tools() -> Vec<DynamicTool> {
    vec![current_time_tool(), current_date_tool()]
}

/// `current_time`:返回当前本地时间(时:分:秒)。
fn current_time_tool() -> DynamicTool {
    DynamicTool::new(
        "current_time",
        "获取当前本地时间(HH:MM:SS)。当你需要知道现在几点时使用。",
        json!({
            "type": "object",
            "properties": {}
        }),
        |_context, _args| {
            Box::pin(async move {
                use chrono::Local;
                let now = Local::now().format("%H:%M:%S").to_string();
                Ok(rig::tool::ToolOutput::text(format!("当前时间:{now}")))
            })
        },
    )
}

/// `current_date`:返回当前日期(年-月-日)。
fn current_date_tool() -> DynamicTool {
    DynamicTool::new(
        "current_date",
        "获取当前日期(YYYY-MM-DD)。当你需要知道今天几号时使用。",
        json!({
            "type": "object",
            "properties": {}
        }),
        |_context, _args| {
            Box::pin(async move {
                use chrono::Local;
                let date = Local::now().format("%Y-%m-%d").to_string();
                Ok(rig::tool::ToolOutput::text(format!("当前日期:{date}")))
            })
        },
    )
}
