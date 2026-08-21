//! 多 agent 协作(supervisor / worker,基于 rig 的 agent-as-tool 模式)。
//!
//! rig 0.41 的多 agent 原语是「把子 agent 暴露为工具」:主对话 agent 通过
//! `agent` 工具把子任务派发给独立的 rig `Agent` 实例(各自 preamble /
//! 可独立指定 provider+model / 可选只读工具集),子 agent 在隔离的上下文
//! 中多轮工具循环执行(`agent::stream_run`),最终报告作为工具结果返回主
//! agent 汇总。`tasks` 数组可一次派发多个子任务(tokio 并发,join_all),
//! 互不依赖的探索/调研/实现/审查可并行推进。
//!
//! 与主 run 的关系:
//! - **上下文隔离**:子 agent 历史为空(不携带主对话上下文),任务描述需
//!   自包含;结果只回传最终报告,不污染主对话窗口;
//! - **取消联动**:子 run 共享主 run 的 cancel watch,用户停止主任务时
//!   全部子任务一并中止;
//! - **工具降级**:子 run 不注入 question / todo_write / compact / agent
//!   等交互工具(子 agent 为自主 worker,不能再派生孙 agent,防止递归失控);
//! - **实时进度**:子任务状态经 `subagent_update` SSE(双层信封,与
//!   `todo_update` 同构)广播,前端 `SubAgentPanel` 实时展示;
//! - **用量归账**:子 run 的 rig 原生 usage / API 调用次数直接累加进所属
//!   会话(sqlite),前端「调用次数」经 `usage` 事件同步收敛。
//!
//! 角色定义:内置 researcher(只读调研)/ coder(全量工具)/ reviewer
//! (只读审查),可在 `combo-cli.toml` 的 `[agents.<name>]` 段覆盖字段、
//! 新增自定义角色或 `disabled = true` 移除内置角色。

use crate::agent::{stream_run, AskConfig, RunEvent, RunUsage};
use crate::meta::MetaStore;
use futures::future::join_all;
use rig::tool::{DynamicTool, ToolOutput};
use serde_json::{Value, json};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::broadcast;

/// 单次工具调用允许并行派发的子任务上限(防失控)。
pub const MAX_PARALLEL_TASKS: usize = 5;

/// 进度广播最小间隔(TextDelta 高频增量节流;状态突变不受限)。
const BROADCAST_MIN_INTERVAL: Duration = Duration::from_millis(400);

/// 进度预览保留的最新文本长度(字符)。
const PREVIEW_CHARS: usize = 240;

/// 子 agent 角色定义(运行时形态,由内置 + `[agents.<name>]` 配置合并)。
#[derive(Clone, Debug)]
pub struct SubAgentDef {
    /// 角色 id(工具参数 `agent` 的取值)。
    pub name: String,
    /// 角色说明(拼进工具描述,引导主模型选择)。
    pub description: String,
    /// 角色系统提示词。
    pub preamble: String,
    /// 覆盖 provider id(None 继承主对话)。
    pub provider: Option<String>,
    /// 覆盖模型名(None 继承主对话;换了 provider 时回落其默认大模型)。
    pub model: Option<String>,
    /// 推理强度覆盖(nothink / high / max)。
    pub reasoning_effort: Option<String>,
    /// 只读角色:true 时子 agent 仅获得 read/search/grep/web_search/ocr/LSP 工具。
    pub readonly: bool,
}

/// 内置角色:开箱即用的三个 worker。
pub fn builtin_defs() -> Vec<SubAgentDef> {
    vec![
        SubAgentDef {
            name: "researcher".into(),
            description: "调研员(只读):搜索/阅读代码与网页,产出事实与结论,不改动任何文件"
                .into(),
            preamble: "你是调研员(researcher),在 supervisor 的指派下完成调研子任务。\n\
                你只有只读工具(read/search/grep/web_search/ocr/LSP),不能写文件、不能执行命令。\n\
                工作方式:先明确子任务的目标与范围,系统地检索与阅读,交叉验证后输出结论。\n\
                最终输出一份自包含的调研报告:关键事实、证据位置(文件路径/行号/链接)、\
                结论与建议。不要臆测,查不到就明说。"
                .into(),
            provider: None,
            model: None,
            reasoning_effort: None,
            readonly: true,
        },
        SubAgentDef {
            name: "coder".into(),
            description: "程序员(全量工具):读写代码、执行命令、完成实现/修复/重构类子任务"
                .into(),
            preamble: "你是程序员(coder),在 supervisor 的指派下完成实现类子任务。\n\
                你拥有全部工具(读写文件/搜索/执行命令/LSP)。\n\
                工作方式:动手前先阅读相关代码理解现状;修改保持最小、聚焦子任务边界,\
                不要顺手重构无关代码;完成后运行可用的检查(编译/测试)验证。\n\
                最终输出:做了什么改动(文件+要点)、验证结果、遗留问题。"
                .into(),
            provider: None,
            model: None,
            reasoning_effort: None,
            readonly: false,
        },
        SubAgentDef {
            name: "reviewer".into(),
            description: "审查员(只读):审查代码/变更/方案,给出问题清单与改进建议"
                .into(),
            preamble: "你是审查员(reviewer),在 supervisor 的指派下审查代码或方案。\n\
                你只有只读工具(read/search/grep/LSP),不能改动任何文件。\n\
                工作方式:对照子任务给出的审查对象与关注点逐项检查;区分\
                [阻断问题]/[建议改进]/[可选优化] 三级。\n\
                最终输出:分级问题清单,每条附位置与理由;没有问题时明确说明检查过什么。"
                .into(),
            provider: None,
            model: None,
            reasoning_effort: None,
            readonly: true,
        },
    ]
}

/// 合并内置角色与 `[agents.<name>]` 配置:同名覆盖已设置的字段,
/// `disabled = true` 移除,新名追加。
pub fn collect_defs(app: &crate::config::AppConfig) -> Vec<SubAgentDef> {
    let mut defs = builtin_defs();
    // 先应用对内置角色的覆盖/禁用,再追加新角色(保持内置在前稳定顺序)。
    defs.retain(|d| {
        app.agents
            .get(&d.name)
            .and_then(|c| c.disabled)
            .unwrap_or(false)
            != true
    });
    for d in defs.iter_mut() {
        if let Some(c) = app.agents.get(&d.name) {
            if let Some(v) = c.description.as_deref().filter(|s| !s.is_empty()) {
                d.description = v.to_string();
            }
            if let Some(v) = c.preamble.as_deref().filter(|s| !s.is_empty()) {
                d.preamble = v.to_string();
            }
            if let Some(v) = c.provider.as_deref().filter(|s| !s.is_empty()) {
                d.provider = Some(v.to_string());
            }
            if let Some(v) = c.model.as_deref().filter(|s| !s.is_empty()) {
                d.model = Some(v.to_string());
            }
            if let Some(v) = c.reasoning_effort.as_deref().filter(|s| !s.is_empty()) {
                d.reasoning_effort = Some(v.to_string());
            }
            if let Some(v) = c.readonly {
                d.readonly = v;
            }
        }
    }
    for (name, c) in &app.agents {
        if c.disabled.unwrap_or(false) || defs.iter().any(|d| &d.name == name) {
            continue;
        }
        defs.push(SubAgentDef {
            name: name.clone(),
            description: c.description.clone().unwrap_or_else(|| "自定义子 agent".into()),
            preamble: c.preamble.clone().unwrap_or_default(),
            provider: c.provider.clone(),
            model: c.model.clone(),
            reasoning_effort: c.reasoning_effort.clone(),
            readonly: c.readonly.unwrap_or(false),
        });
    }
    defs
}

// ---------------------------------------------------------------------------
// 工具参数解析与子配置构造
// ---------------------------------------------------------------------------

/// 一次工具调用解析出的子任务请求。
#[derive(Clone, Debug, PartialEq)]
pub struct SubTaskReq {
    pub agent: String,
    pub task: String,
}

/// 解析工具参数:`{agent, task}` 单任务或 `{tasks: [{agent, task}]}` 批量。
/// 校验角色存在、任务非空、数量上限;错误信息直接面向主模型(中文)。
pub fn parse_tool_args(args: &Value, defs: &[SubAgentDef]) -> Result<Vec<SubTaskReq>, String> {
    let valid_names: Vec<&str> = defs.iter().map(|d| d.name.as_str()).collect();
    let one = |v: &Value| -> Result<SubTaskReq, String> {
        let agent = v
            .get("agent")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim()
            .to_string();
        let task = v
            .get("task")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim()
            .to_string();
        if agent.is_empty() {
            return Err("缺少 agent 字段(子 agent 角色)".into());
        }
        if !valid_names.contains(&agent.as_str()) {
            return Err(format!(
                "未知角色 `{agent}`,可用角色:{}",
                valid_names.join(" / ")
            ));
        }
        if task.is_empty() {
            return Err(format!("角色 `{agent}` 的 task 为空,请描述具体子任务"));
        }
        Ok(SubTaskReq { agent, task })
    };
    let reqs = if let Some(arr) = args.get("tasks").and_then(Value::as_array) {
        if arr.is_empty() {
            return Err("tasks 为空数组,请提供至少一个 {agent, task}".into());
        }
        let mut out = Vec::new();
        for item in arr {
            out.push(one(item)?);
        }
        out
    } else {
        vec![one(args)?]
    };
    if reqs.len() > MAX_PARALLEL_TASKS {
        return Err(format!(
            "一次最多并行 {MAX_PARALLEL_TASKS} 个子任务,当前 {} 个,请拆分多次派发",
            reqs.len()
        ));
    }
    Ok(reqs)
}

/// 从主 run 配置派生子 agent 配置:角色 preamble / provider / model /
/// 推理强度 / 只读工具集;AGENTS.md 与 skills 由调用方经 `with_workspace`
/// 追加(与主 run 同一拼装路径)。
pub fn resolve_sub_cfg(parent: &AskConfig, def: &SubAgentDef) -> AskConfig {
    let mut cfg = parent.clone();
    // 仅在角色真的要换 provider 时才读配置文件(常见路径零磁盘 IO)
    let needs_provider = def
        .provider
        .as_deref()
        .filter(|p| !p.is_empty())
        .map(|p| p != parent.provider.id)
        .unwrap_or(false);
    if needs_provider {
        let pid = def.provider.as_deref().unwrap_or_default();
        let app = crate::config::AppConfig::load_or_create(&crate::config::default_config_path())
            .unwrap_or_default();
        if let Ok(p) = crate::providers::find_provider(pid, &app.providers) {
            cfg.provider = p;
            // 换了 provider 而角色未指定模型:回落新 provider 的默认大模型,
            // 避免拿父模型名打错 provider。
            if def.model.as_deref().map_or(true, |m| m.is_empty()) {
                cfg.model = cfg.provider.default_model();
            }
        }
    }
    if let Some(m) = def.model.as_deref().filter(|m| !m.is_empty()) {
        cfg.model = m.to_string();
    }
    if let Some(e) = def.reasoning_effort.as_deref().filter(|e| !e.is_empty()) {
        cfg.reasoning_effort = Some(e.to_string());
    }
    if cfg.tools && def.readonly {
        cfg.readonly_tools = true;
    }
    // 角色提示词替换 base_preamble(WithWorkspace 会拼 AGENTS.md + skills)
    cfg.base_preamble = def.preamble.clone();
    cfg.preamble = def.preamble.clone();
    cfg
}

// ---------------------------------------------------------------------------
// 进度看板(SSE subagent_update)
// ---------------------------------------------------------------------------

/// 单个子任务的实时状态(序列化为 wire 形态)。
#[derive(Clone, Debug)]
struct SubTaskState {
    task_id: String,
    agent: String,
    task: String,
    /// running | done | error | cancelled
    status: String,
    /// 最新输出预览(尾部 PREVIEW_CHARS 字符)。
    preview: String,
    tool_calls: u64,
    turns: u64,
    usage: Option<RunUsage>,
    model: String,
    provider: String,
    error: Option<String>,
}

impl SubTaskState {
    fn to_json(&self) -> Value {
        json!({
            "task_id": self.task_id,
            "agent": self.agent,
            "task": self.task,
            "status": self.status,
            "preview": self.preview,
            "tool_calls": self.tool_calls,
            "turns": self.turns,
            "model": self.model,
            "provider": self.provider,
            "error": self.error,
        })
    }
}

/// 一次工具调用的全部子任务看板(共享给各并行 future)。
struct Board {
    tasks: Vec<SubTaskState>,
    last_broadcast: Instant,
}

fn truncate_tail(s: &str, max_chars: usize) -> String {
    let chars: Vec<char> = s.chars().collect();
    if chars.len() <= max_chars {
        return s.to_string();
    }
    let start = chars.len() - max_chars;
    chars[start..].iter().collect()
}

/// 广播看板快照(双层信封,与 `todo_update` 同构);`force=false` 时按
/// 最小间隔节流(TextDelta 高频增量)。
fn broadcast_board(tx: &broadcast::Sender<Value>, session_id: &str, board: &mut Board, force: bool) {
    if !force && board.last_broadcast.elapsed() < BROADCAST_MIN_INTERVAL {
        return;
    }
    board.last_broadcast = Instant::now();
    let tasks: Vec<Value> = board.tasks.iter().map(|t| t.to_json()).collect();
    let _ = tx.send(json!({
        "type": "subagent_update",
        "payload": {
            "type": "updated",
            "payload": { "session_id": session_id, "tasks": tasks }
        }
    }));
}

/// 会话累计 API 调用次数事件(与 serve::api_calls_env 同构)。
fn api_calls_env(session_id: &str, api_calls: i64) -> Value {
    json!({
        "type": "usage",
        "payload": {
            "type": "updated",
            "payload": { "session_id": session_id, "api_calls": api_calls }
        }
    })
}

// ---------------------------------------------------------------------------
// 结果报告
// ---------------------------------------------------------------------------

/// 子任务执行终态(成功报告 / 取消 / 出错)。
struct SubTaskOutcome {
    agent: String,
    task: String,
    text: Option<String>,
    cancelled: bool,
    error: Option<String>,
    usage: Option<RunUsage>,
}

/// 把全部子任务终态拼成给主模型看的工具结果。
fn format_report(outcomes: &[SubTaskOutcome]) -> String {
    let mut sections = Vec::new();
    for o in outcomes {
        let body = if let Some(t) = o.text.as_deref().filter(|t| !t.is_empty()) {
            t.to_string()
        } else if o.cancelled {
            "子任务已被取消,未产出结果。".to_string()
        } else if let Some(e) = &o.error {
            format!("子任务失败:{e}")
        } else {
            "(子 agent 未返回内容)".to_string()
        };
        let usage = o
            .usage
            .as_ref()
            .filter(|u| u.has_values())
            .map(|u| {
                format!(
                    "\n\n(用量:输入 {} / 输出 {} tokens,{} 次调用)",
                    u.total_input, u.total_output, u.turns
                )
            })
            .unwrap_or_default();
        sections.push(format!("## [{agent}] {task}\n\n{body}{usage}", agent = o.agent, task = o.task));
    }
    sections.join("\n\n---\n\n")
}

// ---------------------------------------------------------------------------
// agent 工具
// ---------------------------------------------------------------------------

/// 构建 `agent` 工具:主 agent 据此派发子任务给子 agent(multi-agent)。
///
/// `defs` 为合并后的角色列表(`collect_defs`);`parent_cfg` 为主 run 的生效
/// 配置(子 agent 继承 provider/key/MCP/skills,替换 preamble);`cancel`
/// 共享主 run 的取消信号。
#[allow(clippy::too_many_arguments)]
pub fn agent_tool(
    session_id: String,
    defs: Vec<SubAgentDef>,
    parent_cfg: AskConfig,
    workspace_dir: Option<PathBuf>,
    ws_disabled_skills: Vec<String>,
    meta: Arc<MetaStore>,
    tx: broadcast::Sender<Value>,
    cancel: tokio::sync::watch::Receiver<bool>,
) -> DynamicTool {
    let names: Vec<Value> = defs.iter().map(|d| json!(d.name)).collect();
    let role_lines: String = defs
        .iter()
        .map(|d| format!("- {}: {}", d.name, d.description))
        .collect::<Vec<_>>()
        .join("\n");
    let description = format!(
        "派发子任务给专职子 agent(multi-agent 协作)。每个子 agent 拥有独立上下文与角色提示词,\
         适合把调研/实现/审查等子任务分派出去,避免子任务细节占用主对话上下文。可用角色:\n\
         {role_lines}\n\
         用法:传 `agent` + `task` 派发单个子任务;子任务之间互不依赖时,传 `tasks` 数组\
         (每项 {{agent, task}},最多 {MAX_PARALLEL_TASKS} 个)并行执行。\
         `task` 必须自包含(子 agent 看不到主对话历史,请写明目标、范围、期望产出)。\
         返回各子 agent 的最终报告,由你汇总并继续推进主任务。"
    );
    let schema = json!({
        "type": "object",
        "properties": {
            "agent": {
                "type": "string",
                "enum": names,
                "description": "子 agent 角色(单任务模式)"
            },
            "task": {
                "type": "string",
                "description": "子任务描述(自包含:目标、范围、期望产出)"
            },
            "tasks": {
                "type": "array",
                "maxItems": MAX_PARALLEL_TASKS,
                "description": "并行批量模式:同时派发多个互不依赖的子任务",
                "items": {
                    "type": "object",
                    "properties": {
                        "agent": { "type": "string", "description": "子 agent 角色" },
                        "task": { "type": "string", "description": "子任务描述" }
                    },
                    "required": ["agent", "task"]
                }
            }
        }
    });

    DynamicTool::new(
        "agent",
        &description,
        schema,
        move |_ctx, args| {
            let session_id = session_id.clone();
            let defs = defs.clone();
            let parent_cfg = parent_cfg.clone();
            let workspace_dir = workspace_dir.clone();
            let ws_disabled = ws_disabled_skills.clone();
            let meta = meta.clone();
            let tx = tx.clone();
            let cancel = cancel.clone();
            Box::pin(async move {
                let reqs = match parse_tool_args(&args, &defs) {
                    Ok(r) => r,
                    Err(e) => return Ok(ToolOutput::text(format!("参数错误:{e}"))),
                };

                // 预分配 task_id 与子任务一一配对(同角色同描述的重复任务也能定位),
                // 初始看板全部 running 并立即广播。
                let entries: Vec<(SubTaskReq, String)> = reqs
                    .into_iter()
                    .map(|r| {
                        let id = uuid::Uuid::new_v4().to_string();
                        (r, id)
                    })
                    .collect();
                let board = Arc::new(Mutex::new(Board {
                    tasks: entries
                        .iter()
                        .map(|(r, id)| SubTaskState {
                            task_id: id.clone(),
                            agent: r.agent.clone(),
                            task: r.task.clone(),
                            status: "running".into(),
                            preview: String::new(),
                            tool_calls: 0,
                            turns: 0,
                            usage: None,
                            model: parent_cfg.model.clone(),
                            provider: parent_cfg.provider.id.clone(),
                            error: None,
                        })
                        .collect(),
                    last_broadcast: Instant::now(),
                }));
                {
                    let mut b = board.lock().unwrap_or_else(|e| e.into_inner());
                    b.last_broadcast = Instant::now()
                        .checked_sub(BROADCAST_MIN_INTERVAL)
                        .unwrap_or_else(Instant::now);
                    broadcast_board(&tx, &session_id, &mut b, true);
                }

                let futs: Vec<_> = entries
                    .into_iter()
                    .map(|(req, task_id)| {
                        let def = defs.iter().find(|d| d.name == req.agent).cloned();
                        let board = board.clone();
                        let tx = tx.clone();
                        let session_id = session_id.clone();
                        let parent_cfg = parent_cfg.clone();
                        let workspace_dir = workspace_dir.clone();
                        let ws_disabled = ws_disabled.clone();
                        let meta = meta.clone();
                        let cancel = cancel.clone();
                        async move {
                            let Some(def) = def else {
                                return SubTaskOutcome {
                                    agent: req.agent,
                                    task: req.task,
                                    text: None,
                                    cancelled: false,
                                    error: Some("角色定义缺失".into()),
                                    usage: None,
                                };
                            };
                            // 子配置:角色 preamble/provider/model;补 AGENTS.md + skills
                            let sub_cfg = resolve_sub_cfg(&parent_cfg, &def).with_workspace(
                                workspace_dir.clone(),
                                &ws_disabled,
                            );
                            {
                                let mut b = board.lock().unwrap_or_else(|e| e.into_inner());
                                if let Some(t) =
                                    b.tasks.iter_mut().find(|t| t.task_id == task_id)
                                {
                                    t.model = sub_cfg.model.clone();
                                    t.provider = sub_cfg.provider.id.clone();
                                }
                            }

                            // 子 run:空历史(上下文隔离)+ 无交互工具(防递归/串扰)。
                            // 事件闭包只改自身条目,广播在借用结束后进行。
                            let board_ev = board.clone();
                            let tx_ev = tx.clone();
                            let sid_ev = session_id.clone();
                            let task_id_ev = task_id.clone();
                            let result = stream_run(
                                &sub_cfg,
                                &req.task,
                                &[],
                                workspace_dir,
                                cancel,
                                Vec::new(),
                                move |ev: RunEvent| {
                                    let mut b = board_ev.lock().unwrap_or_else(|e| e.into_inner());
                                    let force = {
                                        let Some(t) = b
                                            .tasks
                                            .iter_mut()
                                            .find(|t| t.task_id == task_id_ev)
                                        else {
                                            return;
                                        };
                                        match &ev {
                                            RunEvent::TextDelta(text) => {
                                                let preview = format!("{}{}", t.preview, text);
                                                t.preview = truncate_tail(&preview, PREVIEW_CHARS);
                                                false
                                            }
                                            RunEvent::ReasoningDelta(_) => false,
                                            RunEvent::ToolCall { name, input, .. } => {
                                                t.tool_calls += 1;
                                                let input_preview: String =
                                                    input.chars().take(80).collect();
                                                t.preview = format!("[{name}] {input_preview}");
                                                true
                                            }
                                            RunEvent::ToolResult { .. } => false,
                                            RunEvent::Usage(u) => {
                                                t.usage = Some(*u);
                                                false
                                            }
                                            RunEvent::Turns(n) => {
                                                t.turns = *n;
                                                false
                                            }
                                        }
                                    };
                                    broadcast_board(&tx_ev, &sid_ev, &mut b, force);
                                },
                            )
                            .await;

                            // 终态落板 + 读取用量/调用数
                            let (usage, turns) = {
                                let mut b = board.lock().unwrap_or_else(|e| e.into_inner());
                                let (status, error) = match &result {
                                    Ok(Some(_)) => ("done", None),
                                    Ok(None) => ("cancelled", None),
                                    Err(e) => ("error", Some(format!("{e:#}"))),
                                };
                                let (usage, turns) = b
                                    .tasks
                                    .iter()
                                    .find(|t| t.task_id == task_id)
                                    .map(|t| (t.usage, t.turns))
                                    .unwrap_or((None, 0));
                                if let Some(t) = b.tasks.iter_mut().find(|t| t.task_id == task_id)
                                {
                                    t.status = status.to_string();
                                    t.error = error.clone();
                                }
                                broadcast_board(&tx, &session_id, &mut b, true);
                                (usage, turns)
                            };
                            // 用量归账:token 累加进会话;API 调用次数累加并广播累计值
                            if let Some(u) = usage.filter(|u| u.has_values()) {
                                let (pin, pout) = crate::providers::get_model_pricing(
                                    &sub_cfg.provider,
                                    &sub_cfg.model,
                                );
                                let cost = (u.total_input as f64 / 1_000_000.0) * pin
                                    + (u.total_output as f64 / 1_000_000.0) * pout;
                                if let Err(e) = meta.db().add_usage(
                                    &session_id,
                                    u.total_input as i64,
                                    u.total_output as i64,
                                    cost,
                                    u.context_tokens() as i64,
                                ) {
                                    tracing::warn!(
                                        "multiagent: 子任务用量落库失败 session={session_id}: {e:#}"
                                    );
                                }
                            }
                            if turns > 0 {
                                if let Err(e) = meta.db().add_api_calls(&session_id, turns as i64)
                                {
                                    tracing::warn!(
                                        "multiagent: 子任务 API 调用数落库失败 session={session_id}: {e:#}"
                                    );
                                }
                                if let Some(total) = meta.db().get_api_calls(&session_id) {
                                    let _ = tx.send(api_calls_env(&session_id, total));
                                }
                            }

                            let (text, cancelled, error) = match result {
                                Ok(Some(t)) => (Some(t), false, None),
                                Ok(None) => (None, true, None),
                                Err(e) => (None, false, Some(format!("{e:#}"))),
                            };
                            SubTaskOutcome {
                                agent: req.agent,
                                task: req.task,
                                text,
                                cancelled,
                                error,
                                usage,
                            }
                        }
                    })
                    .collect();
                let outcomes = join_all(futs).await;
                Ok(ToolOutput::text(format_report(&outcomes)))
            })
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn defs() -> Vec<SubAgentDef> {
        builtin_defs()
    }

    #[test]
    fn collect_defs_overrides_and_appends_and_disables() {
        let mut app = crate::config::AppConfig::default();
        // 覆盖内置 researcher 的说明 + 指定模型
        app.agents.insert(
            "researcher".into(),
            crate::config::AgentRoleConfig {
                description: Some("自定义调研员".into()),
                model: Some("gpt-x".into()),
                ..Default::default()
            },
        );
        // 禁用 reviewer
        app.agents.insert(
            "reviewer".into(),
            crate::config::AgentRoleConfig {
                disabled: Some(true),
                ..Default::default()
            },
        );
        // 新增自定义角色
        app.agents.insert(
            "writer".into(),
            crate::config::AgentRoleConfig {
                description: Some("文档写手".into()),
                preamble: Some("你是文档写手".into()),
                readonly: Some(true),
                ..Default::default()
            },
        );
        let defs = collect_defs(&app);
        assert!(!defs.iter().any(|d| d.name == "reviewer"), "disabled 角色应被移除");
        let researcher = defs.iter().find(|d| d.name == "researcher").unwrap();
        assert_eq!(researcher.description, "自定义调研员");
        assert_eq!(researcher.model.as_deref(), Some("gpt-x"));
        let writer = defs.iter().find(|d| d.name == "writer").unwrap();
        assert_eq!(writer.preamble, "你是文档写手");
        assert!(writer.readonly);
    }

    #[test]
    fn parse_tool_args_single_and_batch() {
        let defs = defs();
        // 单任务
        let reqs = parse_tool_args(
            &json!({"agent": "researcher", "task": "调研依赖树"}),
            &defs,
        )
        .unwrap();
        assert_eq!(reqs.len(), 1);
        assert_eq!(reqs[0].agent, "researcher");
        // 批量
        let reqs = parse_tool_args(
            &json!({"tasks": [
                {"agent": "researcher", "task": "A"},
                {"agent": "coder", "task": "B"}
            ]}),
            &defs,
        )
        .unwrap();
        assert_eq!(reqs.len(), 2);
        // 未知角色
        assert!(parse_tool_args(&json!({"agent": "nope", "task": "x"}), &defs).is_err());
        // 空 task
        assert!(parse_tool_args(&json!({"agent": "coder", "task": "  "}), &defs).is_err());
        // 超上限
        let over = json!({"tasks": (0..6).map(|i| json!({"agent": "coder", "task": i})).collect::<Vec<_>>()});
        assert!(parse_tool_args(&over, &defs).is_err());
        // 空 tasks 数组
        assert!(parse_tool_args(&json!({"tasks": []}), &defs).is_err());
    }

    #[test]
    fn truncate_tail_keeps_latest_chars() {
        assert_eq!(truncate_tail("abcdef", 3), "def");
        assert_eq!(truncate_tail("ab", 5), "ab");
        // UTF-8 字符边界安全
        let s = "你好世界组合".repeat(10);
        let out = truncate_tail(&s, 4);
        assert!(out.chars().count() == 4);
    }

    #[test]
    fn report_contains_sections_and_usage() {
        let outcomes = vec![
            SubTaskOutcome {
                agent: "researcher".into(),
                task: "调研 A".into(),
                text: Some("结论:可行".into()),
                cancelled: false,
                error: None,
                usage: Some(RunUsage {
                    total_input: 1200,
                    total_output: 340,
                    turns: 5,
                    ..Default::default()
                }),
            },
            SubTaskOutcome {
                agent: "coder".into(),
                task: "实现 B".into(),
                text: None,
                cancelled: true,
                error: None,
                usage: None,
            },
            SubTaskOutcome {
                agent: "reviewer".into(),
                task: "审查 C".into(),
                text: None,
                cancelled: false,
                error: Some("provider 超时".into()),
                usage: None,
            },
        ];
        let report = format_report(&outcomes);
        assert!(report.contains("## [researcher] 调研 A"));
        assert!(report.contains("结论:可行"));
        assert!(report.contains("1200"));
        assert!(report.contains("已被取消"));
        assert!(report.contains("provider 超时"));
        assert!(report.contains("---"));
    }

    #[test]
    fn subagent_env_is_double_enveloped() {
        let board = Board {
            tasks: vec![SubTaskState {
                task_id: "t1".into(),
                agent: "coder".into(),
                task: "做某事".into(),
                status: "running".into(),
                preview: "[bash] echo hi".into(),
                tool_calls: 2,
                turns: 3,
                usage: None,
                model: "m".into(),
                provider: "p".into(),
                error: None,
            }],
            last_broadcast: Instant::now(),
        };
        let tasks: Vec<Value> = board.tasks.iter().map(|t| t.to_json()).collect();
        let env = json!({
            "type": "subagent_update",
            "payload": { "type": "updated", "payload": { "session_id": "s1", "tasks": tasks } }
        });
        assert_eq!(env["type"], "subagent_update");
        assert_eq!(env["payload"]["type"], "updated");
        assert_eq!(env["payload"]["payload"]["session_id"], "s1");
        assert_eq!(env["payload"]["payload"]["tasks"][0]["agent"], "coder");
        assert_eq!(env["payload"]["payload"]["tasks"][0]["status"], "running");
        assert_eq!(env["payload"]["payload"]["tasks"][0]["tool_calls"], 2);
    }

    #[test]
    fn api_calls_env_shape_matches_serve() {
        let env = api_calls_env("s1", 46);
        assert_eq!(env["type"], "usage");
        assert_eq!(env["payload"]["type"], "updated");
        assert_eq!(env["payload"]["payload"]["session_id"], "s1");
        assert_eq!(env["payload"]["payload"]["api_calls"], 46);
    }
}
