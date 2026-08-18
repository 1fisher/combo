//! 自动化(定时任务):combo 后台定时触发 agent 运行。
//!
//! 调度模型:
//! - `once`      一次性,指定 run_at(unix 秒)执行一次,执行后不再调度;
//! - `interval`  每隔 every_seconds 秒执行一次;
//! - `daily`     每天 HH:MM 执行一次;
//! - `weekly`    每周 weekday(1=周一..7=周日)的 HH:MM 执行一次;
//! - `monthly`   每月 day 日(1..31)的 HH:MM 执行一次;
//! - `quarterly` 每季度 month(1..3,季度内第几个月)的 day 日 HH:MM 执行一次;
//! - `yearly`    每年 month 月(1..12)day 日的 HH:MM 执行一次。
//!   monthly/quarterly/yearly 的 day 超过当月实际天数时取当月最后一天
//!   (如每月 31 日,2 月取 28/29 日)。
//!
//! 调度器(`AutomationScheduler`)随 serve 启动,后台每 15 秒扫描一次到期的
//! 任务,到期后在目标 workspace 新建会话并复用 `serve::start_agent_run`
//! 发起 agent 运行;运行结束(成功/取消/出错)通过完成回调把结果落库到
//! `automation_runs` 表并更新任务的最近运行状态。

use crate::serve::{self, AppState, AgentRunRequest};
use crate::store::{AutomationRun, ConversationMeta, StoredAutomation, WorkspaceModel};
use crate::config::AppConfig;
use crate::providers;
use axum::body::Body;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::Response;
use axum::Json;
use chrono::{DateTime, Datelike, Local, LocalResult, NaiveDate, TimeZone};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;
use tokio::sync::watch;

/// 调度器后台扫描间隔(秒)。调度粒度按分钟级设计,15 秒足够及时。
const TICK_SECS: u64 = 15;

// ---------- 调度模型 ----------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ScheduleType {
    Once,
    Interval,
    Daily,
    Weekly,
    Monthly,
    Quarterly,
    Yearly,
}

/// 一条自动化任务的调度配置。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Schedule {
    pub schedule_type: ScheduleType,
    /// once:触发时间(unix 秒)。
    pub run_at: Option<i64>,
    /// interval:间隔秒数(> 0)。
    pub every_seconds: Option<i64>,
    /// daily / weekly / monthly / quarterly / yearly:触发时刻 "HH:MM"(24 小时制)。
    pub time: Option<String>,
    /// weekly:星期几(1=周一 .. 7=周日)。
    pub weekday: Option<u32>,
    /// monthly / quarterly / yearly:每月几号(1..31;超过当月天数取当月最后一天)。
    pub day: Option<u32>,
    /// quarterly:季度内第几个月(1..3);yearly:几月(1..12)。
    pub month: Option<u32>,
}

impl Schedule {
    pub fn from_json(v: &Value) -> Result<Self, String> {
        let t = v.get("type").and_then(Value::as_str).unwrap_or("");
        match t {
            "once" => {
                let run_at = v
                    .get("run_at")
                    .and_then(Value::as_i64)
                    .ok_or("once 调度需要 run_at(unix 秒)")?;
                Ok(Schedule {
                    schedule_type: ScheduleType::Once,
                    run_at: Some(run_at),
                    every_seconds: None,
                    time: None,
                    weekday: None,
                    day: None,
                    month: None,
                })
            }
            "interval" => {
                let secs = v
                    .get("every_seconds")
                    .and_then(Value::as_i64)
                    .filter(|s| *s > 0)
                    .ok_or("interval 调度需要 every_seconds > 0")?;
                Ok(Schedule {
                    schedule_type: ScheduleType::Interval,
                    run_at: None,
                    every_seconds: Some(secs),
                    time: None,
                    weekday: None,
                    day: None,
                    month: None,
                })
            }
            "daily" => {
                let time = v
                    .get("time")
                    .and_then(Value::as_str)
                    .ok_or("daily 调度需要 time(HH:MM)")?
                    .to_string();
                parse_time(&time)?;
                Ok(Schedule {
                    schedule_type: ScheduleType::Daily,
                    run_at: None,
                    every_seconds: None,
                    time: Some(time),
                    weekday: None,
                    day: None,
                    month: None,
                })
            }
            "weekly" => {
                let weekday = v
                    .get("weekday")
                    .and_then(Value::as_u64)
                    .map(|w| w as u32)
                    .filter(|w| (1..=7).contains(w))
                    .ok_or("weekly 调度需要 weekday(1=周一..7=周日)")?;
                let time = v
                    .get("time")
                    .and_then(Value::as_str)
                    .ok_or("weekly 调度需要 time(HH:MM)")?
                    .to_string();
                parse_time(&time)?;
                Ok(Schedule {
                    schedule_type: ScheduleType::Weekly,
                    run_at: None,
                    every_seconds: None,
                    time: Some(time),
                    weekday: Some(weekday),
                    day: None,
                    month: None,
                })
            }
            "monthly" => {
                let day = parse_day(v)?;
                let time = required_time(v, "monthly")?;
                Ok(Schedule {
                    schedule_type: ScheduleType::Monthly,
                    run_at: None,
                    every_seconds: None,
                    time: Some(time),
                    weekday: None,
                    day: Some(day),
                    month: None,
                })
            }
            "quarterly" => {
                let month = v
                    .get("month")
                    .and_then(Value::as_u64)
                    .map(|m| m as u32)
                    .filter(|m| (1..=3).contains(m))
                    .ok_or("quarterly 调度需要 month(1..3,季度内第几个月)")?;
                let day = parse_day(v)?;
                let time = required_time(v, "quarterly")?;
                Ok(Schedule {
                    schedule_type: ScheduleType::Quarterly,
                    run_at: None,
                    every_seconds: None,
                    time: Some(time),
                    weekday: None,
                    day: Some(day),
                    month: Some(month),
                })
            }
            "yearly" => {
                let month = v
                    .get("month")
                    .and_then(Value::as_u64)
                    .map(|m| m as u32)
                    .filter(|m| (1..=12).contains(m))
                    .ok_or("yearly 调度需要 month(1..12,几月)")?;
                let day = parse_day(v)?;
                let time = required_time(v, "yearly")?;
                Ok(Schedule {
                    schedule_type: ScheduleType::Yearly,
                    run_at: None,
                    every_seconds: None,
                    time: Some(time),
                    weekday: None,
                    day: Some(day),
                    month: Some(month),
                })
            }
            other => Err(format!(
                "未知的调度类型: {other}(可选 once/interval/daily/weekly/monthly/quarterly/yearly)"
            )),
        }
    }

    pub fn from_json_str(s: &str) -> Result<Self, String> {
        let v: Value =
            serde_json::from_str(s).map_err(|e| format!("调度配置解析失败: {e}"))?;
        Self::from_json(&v)
    }

    pub fn to_json(&self) -> Value {
        let mut v = json!({ "type": match self.schedule_type {
            ScheduleType::Once => "once",
            ScheduleType::Interval => "interval",
            ScheduleType::Daily => "daily",
            ScheduleType::Weekly => "weekly",
            ScheduleType::Monthly => "monthly",
            ScheduleType::Quarterly => "quarterly",
            ScheduleType::Yearly => "yearly",
        }});
        if let Some(t) = self.run_at {
            v["run_at"] = json!(t);
        }
        if let Some(s) = self.every_seconds {
            v["every_seconds"] = json!(s);
        }
        if let Some(t) = &self.time {
            v["time"] = json!(t);
        }
        if let Some(w) = self.weekday {
            v["weekday"] = json!(w);
        }
        if let Some(d) = self.day {
            v["day"] = json!(d);
        }
        if let Some(m) = self.month {
            v["month"] = json!(m);
        }
        v
    }

    /// 计算 `from` 时刻之后的下一次触发时间(Local 时间)。
    /// - once:run_at 在未来则返回它,已过返回 None(不再调度);
    /// - interval:from + every_seconds;
    /// - daily:当天 HH:MM(已过则次日);
    /// - weekly:最近一个匹配 weekday 的 HH:MM(当天且未过则当天);
    /// - monthly:最近一个月份的 day 日 HH:MM(已过则下月);
    /// - quarterly:最近一个季度内目标月份的 day 日 HH:MM;
    /// - yearly:今年 month 月 day 日 HH:MM(已过则明年)。
    ///   day 超过当月天数时取当月最后一天。
    pub fn next_after(&self, from: DateTime<Local>) -> Option<DateTime<Local>> {
        match self.schedule_type {
            ScheduleType::Once => {
                let dt = Local.timestamp_opt(self.run_at?, 0).single()?;
                (dt > from).then_some(dt)
            }
            ScheduleType::Interval => {
                Some(from + chrono::Duration::seconds(self.every_seconds? as i64))
            }
            ScheduleType::Daily => {
                let (h, m) = parse_time(self.time.as_deref()?).ok()?;
                let mut dt = day_at(&from.date_naive(), h, m)?;
                if dt <= from {
                    dt = day_at(&(from.date_naive() + chrono::Duration::days(1)), h, m)?;
                }
                Some(dt)
            }
            ScheduleType::Weekly => {
                let (h, m) = parse_time(self.time.as_deref()?).ok()?;
                // 输入 1=周一..7=周日 → chrono num_days_from_monday(0=周一..6=周日)
                let target = (self.weekday? - 1) % 7;
                let cur = from.weekday().num_days_from_monday();
                let mut add_days = (target + 7 - cur) % 7;
                let mut dt = day_at(&(from.date_naive() + chrono::Duration::days(add_days as i64)), h, m)?;
                if dt <= from {
                    add_days += 7;
                    dt = day_at(&(from.date_naive() + chrono::Duration::days(add_days as i64)), h, m)?;
                }
                Some(dt)
            }
            ScheduleType::Monthly => {
                let (h, m) = parse_time(self.time.as_deref()?).ok()?;
                let day = self.day?;
                let mut ym = (from.year(), from.month());
                loop {
                    if let Some(dt) = month_day_at(ym.0, ym.1, day, h, m) {
                        if dt > from {
                            return Some(dt);
                        }
                    }
                    ym = next_month(ym);
                }
            }
            ScheduleType::Quarterly => {
                let (h, m) = parse_time(self.time.as_deref()?).ok()?;
                let day = self.day?;
                // 季度内第几个月(1..3):绝对月份满足 (month - 1) % 3 == month - 1
                let target = (self.month? - 1) % 3;
                let mut ym = (from.year(), from.month());
                loop {
                    if (ym.1 - 1) % 3 == target {
                        if let Some(dt) = month_day_at(ym.0, ym.1, day, h, m) {
                            if dt > from {
                                return Some(dt);
                            }
                        }
                    }
                    ym = next_month(ym);
                }
            }
            ScheduleType::Yearly => {
                let (h, m) = parse_time(self.time.as_deref()?).ok()?;
                let day = self.day?;
                let month = self.month?;
                let mut year = from.year();
                loop {
                    if let Some(dt) = month_day_at(year, month, day, h, m) {
                        if dt > from {
                            return Some(dt);
                        }
                    }
                    year += 1;
                }
            }
        }
    }
}

/// 把 HH:MM 解析为 (hour, minute)。
fn parse_time(s: &str) -> Result<(u32, u32), String> {
    let parts: Vec<&str> = s.split(':').collect();
    if parts.len() != 2 {
        return Err(format!("time 格式应为 HH:MM,实际: {s}"));
    }
    let h: u32 = parts[0].parse().map_err(|_| format!("小时无效: {}", parts[0]))?;
    let m: u32 = parts[1].parse().map_err(|_| format!("分钟无效: {}", parts[1]))?;
    if h > 23 || m > 59 {
        return Err(format!("time 超出范围: {s}"));
    }
    Ok((h, m))
}

/// 解析调度 JSON 中的 day(每月几号,1..31)。
fn parse_day(v: &Value) -> Result<u32, String> {
    v.get("day")
        .and_then(Value::as_u64)
        .map(|d| d as u32)
        .filter(|d| (1..=31).contains(d))
        .ok_or_else(|| "调度需要 day(1..31,每月几号)".to_string())
}

/// 解析调度 JSON 中必填的 time(HH:MM),错误信息带上调度类型名。
fn required_time(v: &Value, ty: &str) -> Result<String, String> {
    let time = v
        .get("time")
        .and_then(Value::as_str)
        .ok_or_else(|| format!("{ty} 调度需要 time(HH:MM)"))?;
    let time = time.to_string();
    parse_time(&time)?;
    Ok(time)
}

/// (年, 月) 推进到下一个月。
fn next_month(ym: (i32, u32)) -> (i32, u32) {
    if ym.1 == 12 {
        (ym.0 + 1, 1)
    } else {
        (ym.0, ym.1 + 1)
    }
}

/// 在某年某月构造 day 日 HH:MM 的 Local 时刻;day 超过当月天数时取当月
/// 最后一天(如每月 31 日,2 月取 28/29 日)。DST 歧义时取首个。
fn month_day_at(year: i32, month: u32, day: u32, h: u32, m: u32) -> Option<DateTime<Local>> {
    // 下月 1 号的前一天即当月最后一天
    let first_of_next = if month == 12 {
        NaiveDate::from_ymd_opt(year + 1, 1, 1)?
    } else {
        NaiveDate::from_ymd_opt(year, month + 1, 1)?
    };
    let day = day.min(first_of_next.pred_opt()?.day());
    let date = NaiveDate::from_ymd_opt(year, month, day)?;
    day_at(&date, h, m)
}

/// 在某天构造 HH:MM 的 Local 时刻;DST 导致时间不存在/重复时取首个(尽力而为)。
fn day_at(date: &NaiveDate, h: u32, m: u32) -> Option<DateTime<Local>> {
    let dt = date.and_hms_opt(h, m, 0)?;
    match dt.and_local_timezone(Local) {
        LocalResult::Single(t) | LocalResult::Ambiguous(t, _) => Some(t),
        LocalResult::None => None,
    }
}

// ---------- 调度器 ----------

/// 自动化调度器:后台任务定期扫描 sqlite 中到期的任务并触发运行。
/// 与 serve 生命周期绑定(serve_listener 启动时 start,进程退出即停止)。
pub struct AutomationScheduler {
    handle: Mutex<Option<tokio::task::JoinHandle<()>>>,
    shutdown: watch::Sender<bool>,
}

impl AutomationScheduler {
    pub fn new() -> Self {
        let (shutdown, _) = watch::channel(false);
        Self {
            handle: Mutex::new(None),
            shutdown,
        }
    }

    /// 启动后台扫描任务(幂等:已启动则忽略)。
    pub fn start(&self, state: AppState) {
        let mut handle = self.handle.lock().unwrap();
        if handle.is_some() {
            return;
        }
        let mut rx = self.shutdown.subscribe();
        *handle = Some(tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(TICK_SECS));
            // 消费首个立即 tick,避免启动瞬间处理重启期间到期的任务
            interval.tick().await;
            loop {
                tokio::select! {
                    _ = rx.changed() => break,
                    _ = interval.tick() => tick(&state).await,
                }
            }
        }));
    }

    /// 停止后台扫描(主要用于测试;进程退出时随运行时一并结束)。
    pub fn stop(&self) {
        let _ = self.shutdown.send(true);
    }
}

impl Default for AutomationScheduler {
    fn default() -> Self {
        Self::new()
    }
}

/// 一轮扫描:列出到期的任务并逐个触发。
async fn tick(state: &AppState) {
    let now = Local::now().timestamp();
    let due = match state.meta.db().list_due_automations(now) {
        Ok(v) => v,
        Err(e) => {
            tracing::warn!("读取到期自动化任务失败: {e}");
            return;
        }
    };
    for a in due {
        if let Err(e) = trigger(state, &a, true).await {
            tracing::warn!("自动化任务 {} ({}) 触发失败: {e}", a.id, a.name);
        }
    }
}

/// 触发一次自动化任务:校验项目 → 推进调度 → 新建会话 → 发起 agent 运行。
///
/// `advance_next`:定时触发时推进 next_run_at 并落库(先推进再运行,避免
/// 调度器重复触发同一轮);手动触发传 false 保留原排期。
pub(crate) async fn trigger(
    state: &AppState,
    a: &StoredAutomation,
    advance_next: bool,
) -> anyhow::Result<()> {
    // 1. 校验 workspace 仍存在(可能已被删除)
    if state.meta.get(&a.workspace_id).is_none() {
        mark_skipped(state, a, "项目已删除,任务已停用");
        return Ok(());
    }
    let now_secs = unix_secs();

    // 2. 推进调度:计算下一次触发时间并立即落库(先于运行,防止重复触发)
    if advance_next {
        let next = Schedule::from_json_str(&a.schedule)
            .ok()
            .and_then(|s| s.next_after(Local::now()))
            .map(|t| t.timestamp());
        let mut upd = a.clone();
        upd.next_run_at = next;
        upd.updated_at = now_secs;
        if let Err(e) = state.meta.db().upsert_automation(&upd) {
            tracing::warn!("更新自动化任务 {} 下次触发时间失败: {e}", a.id);
        }
    }

    // 3. 每次运行新建一个独立会话(标题带任务名,便于在会话列表里辨认)
    let conv = ConversationMeta {
        id: crate::workspace::uuid_like(),
        workspace_id: a.workspace_id.clone(),
        title: format!("⏰ {}", a.name),
        message_count: 0,
        created_at: now_secs,
        updated_at: now_secs,
        prompt_tokens: 0,
        completion_tokens: 0,
        cost: 0.0,
        context_tokens: 0,
        context_window: 0,
    };
    state.meta.db().upsert_conversation(&conv)?;
    let session_id = conv.id;

    // 4. 写入运行记录(先记 running,run 结束由回调收尾)
    let run_id = uuid::Uuid::new_v4().to_string();
    let rec = AutomationRun {
        id: crate::workspace::uuid_like(),
        automation_id: a.id.clone(),
        workspace_id: a.workspace_id.clone(),
        session_id: session_id.clone(),
        run_id: run_id.clone(),
        status: "running".into(),
        started_at: now_secs,
        finished_at: None,
        error: None,
    };
    state.meta.db().insert_automation_run(&rec)?;

    // 5. 发起 agent 运行(事件经 workspace 的 SSE 广播,前端可实时看到)
    let req = AgentRunRequest {
        session_id,
        run_id,
        prompt: a.prompt.clone(),
        history: None,
        workspace_dir: None,
        model: model_from_stored(&a.model),
    };
    let state2 = state.clone();
    let auto_id = a.id.clone();
    let rec_id = rec.id.clone();
    let auto_id_cb = auto_id.clone();
    let rec_id_cb = rec_id.clone();
    match serve::start_agent_run(
        state,
        &a.workspace_id,
        req,
        Some(Box::new(move |reason, error| {
            finish_run(&state2, &auto_id_cb, &rec_id_cb, reason, error);
        })),
    )
    .await
    {
        Ok(()) => Ok(()),
        Err((_code, msg)) => {
            // 启动即失败(如该会话 busy、数据库错误):直接落 error 状态
            let _ = state
                .meta
                .db()
                .update_automation_run(&rec_id, "error", unix_secs(), Some(&msg));
            if let Ok(Some(mut a2)) = state.meta.db().get_automation(&auto_id) {
                a2.last_run_at = Some(now_secs);
                a2.last_status = Some("error".into());
                a2.last_error = Some(msg.clone());
                a2.updated_at = unix_secs();
                let _ = state.meta.db().upsert_automation(&a2);
            }
            Err(anyhow::anyhow!(msg))
        }
    }
}

/// run 结束回调:把结果落库到运行记录,并更新任务的最近运行状态。
fn finish_run(state: &AppState, auto_id: &str, rec_id: &str, reason: &str, error: Option<String>) {
    let status = match reason {
        "end_turn" => "success",
        "cancelled" => "cancelled",
        _ => "error",
    };
    let now = unix_secs();
    let _ = state
        .meta
        .db()
        .update_automation_run(rec_id, status, now, error.as_deref());
    if let Ok(Some(mut a)) = state.meta.db().get_automation(auto_id) {
        a.last_run_at = Some(now);
        a.last_status = Some(status.to_string());
        a.last_error = error.clone();
        a.updated_at = now;
        let _ = state.meta.db().upsert_automation(&a);
    }
}

/// 任务无法继续执行(如项目被删)时:停用并标记 skipped。
fn mark_skipped(state: &AppState, a: &StoredAutomation, reason: &str) {
    let now = unix_secs();
    let mut upd = a.clone();
    upd.enabled = false;
    upd.next_run_at = None;
    upd.last_run_at = Some(now);
    upd.last_status = Some("skipped".into());
    upd.last_error = Some(reason.to_string());
    upd.updated_at = now;
    let _ = state.meta.db().upsert_automation(&upd);
}

// ---------- HTTP handlers ----------

/// 解析请求体里的 `model` 字段(可选)。
/// - 缺省(字段不存在)→ Ok(None):沿用已有值;
/// - `null` → Ok(Some(None)):显式清除,跟随项目默认;
/// - `{ provider, model, reasoning_effort? }` → Ok(Some(Some(m))):单独指定,
///   provider 必须存在(与 `config_model` 口径一致,避免保存后运行静默回退)。
fn parse_model_field(v: &Value) -> Result<Option<Option<WorkspaceModel>>, String> {
    let Some(raw) = v.get("model") else {
        return Ok(None);
    };
    if raw.is_null() {
        return Ok(Some(None));
    }
    let m: WorkspaceModel = serde_json::from_value(raw.clone())
        .map_err(|e| format!("model 格式无效(需要 provider/model 字段): {e}"))?;
    if m.provider.is_empty() || m.model.is_empty() {
        return Err("model 需要 provider 与 model 字段".into());
    }
    let config_path =
        AppConfig::load_or_create(&crate::config::default_config_path()).unwrap_or_default();
    if let Err(e) = providers::find_provider(&m.provider, &config_path.providers) {
        return Err(format!("未知 provider `{}`: {e}", m.provider));
    }
    Ok(Some(Some(m)))
}

/// 把任务落库用的 model 字段转成 JSON(空串 = 未单独设置)。
fn model_to_json(raw: &str) -> Value {
    if raw.is_empty() {
        Value::Null
    } else {
        serde_json::from_str::<WorkspaceModel>(raw)
            .map(|m| serde_json::to_value(&m).unwrap_or(Value::Null))
            .unwrap_or(Value::Null)
    }
}

/// 把任务落库用的 model 字段解析为运行时的模型选择(空串 = None)。
fn model_from_stored(raw: &str) -> Option<WorkspaceModel> {
    if raw.is_empty() {
        None
    } else {
        serde_json::from_str(raw).ok()
    }
}

/// GET /v1/automations?workspace_id=xxx — 列出自动化任务(可选按项目过滤)。
pub async fn list(
    State(state): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    let filter = q.get("workspace_id").map(String::as_str);
    let all = state.meta.db().list_automations().unwrap_or_default();
    let arr: Vec<Value> = all
        .iter()
        .filter(|a| filter.map_or(true, |f| a.workspace_id == f))
        .map(|a| automation_json(a, &state))
        .collect();
    json_ok(&json!(arr))
}

/// GET /v1/automations/:id — 单个任务。
pub async fn get(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    match state.meta.db().get_automation(&id) {
        Ok(Some(a)) => json_ok(&automation_json(&a, &state)),
        Ok(None) => json_err(StatusCode::NOT_FOUND, "任务不存在"),
        Err(e) => json_err(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("读取任务失败: {e}"),
        ),
    }
}

/// POST /v1/automations — 创建任务。
/// 请求体:`{ workspace_id, name, prompt, schedule, enabled? }`。
pub async fn create(State(state): State<AppState>, Json(body): Json<Value>) -> Response {
    let workspace_id = body
        .get("workspace_id")
        .and_then(Value::as_str)
        .unwrap_or("");
    if workspace_id.is_empty() || state.meta.get(workspace_id).is_none() {
        return json_err(StatusCode::BAD_REQUEST, "workspace 不存在");
    }
    let name = body
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    if name.is_empty() {
        return json_err(StatusCode::BAD_REQUEST, "任务名称不能为空");
    }
    let prompt = body
        .get("prompt")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    if prompt.is_empty() {
        return json_err(StatusCode::BAD_REQUEST, "任务提示词不能为空");
    }
    let schedule_val = body.get("schedule").unwrap_or(&Value::Null);
    let schedule = match Schedule::from_json(schedule_val) {
        Ok(s) => s,
        Err(e) => return json_err(StatusCode::BAD_REQUEST, &e),
    };
    // 一次性任务必须排在未来
    if schedule.schedule_type == ScheduleType::Once
        && schedule.run_at.map_or(true, |t| t <= unix_secs())
    {
        return json_err(StatusCode::BAD_REQUEST, "一次性任务的 run_at 必须晚于当前时间");
    }
    let enabled = body.get("enabled").and_then(Value::as_bool).unwrap_or(true);
    // 单独指定的模型(缺省 = 跟随项目默认)
    let model = match parse_model_field(&body) {
        Ok(Some(Some(m))) => serde_json::to_string(&m).unwrap_or_default(),
        Ok(_) => String::new(),
        Err(e) => return json_err(StatusCode::BAD_REQUEST, &e),
    };
    let now = unix_secs();
    let next = schedule.next_after(Local::now()).map(|t| t.timestamp());
    let a = StoredAutomation {
        id: crate::workspace::uuid_like(),
        workspace_id: workspace_id.to_string(),
        name,
        prompt,
        schedule: schedule.to_json().to_string(),
        model,
        enabled,
        next_run_at: next,
        last_run_at: None,
        last_status: None,
        last_error: None,
        created_at: now,
        updated_at: now,
    };
    match state.meta.db().upsert_automation(&a) {
        Ok(()) => json_ok(&automation_json(&a, &state)),
        Err(e) => json_err(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("创建任务失败: {e}"),
        ),
    }
}

/// PATCH /v1/automations/:id — 更新任务(部分字段)。
pub async fn update(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> Response {
    let Some(mut a) = state.meta.db().get_automation(&id).unwrap_or(None) else {
        return json_err(StatusCode::NOT_FOUND, "任务不存在");
    };
    if let Some(v) = body.get("name").and_then(Value::as_str) {
        if v.trim().is_empty() {
            return json_err(StatusCode::BAD_REQUEST, "任务名称不能为空");
        }
        a.name = v.trim().to_string();
    }
    if let Some(v) = body.get("prompt").and_then(Value::as_str) {
        if v.trim().is_empty() {
            return json_err(StatusCode::BAD_REQUEST, "任务提示词不能为空");
        }
        a.prompt = v.trim().to_string();
    }
    if let Some(v) = body.get("workspace_id").and_then(Value::as_str) {
        if state.meta.get(v).is_none() {
            return json_err(StatusCode::BAD_REQUEST, "workspace 不存在");
        }
        a.workspace_id = v.to_string();
    }
    if let Some(v) = body.get("enabled").and_then(Value::as_bool) {
        a.enabled = v;
    }
    // 单独指定的模型:缺省沿用;null 清除(跟随项目默认);对象则校验后保存
    match parse_model_field(&body) {
        Ok(Some(Some(m))) => a.model = serde_json::to_string(&m).unwrap_or_default(),
        Ok(Some(None)) => a.model = String::new(),
        Ok(None) => {}
        Err(e) => return json_err(StatusCode::BAD_REQUEST, &e),
    }
    let mut schedule_changed = false;
    if let Some(v) = body.get("schedule") {
        match Schedule::from_json(v) {
            Ok(s) => {
                if s.schedule_type == ScheduleType::Once
                    && s.run_at.map_or(true, |t| t <= unix_secs())
                {
                    return json_err(
                        StatusCode::BAD_REQUEST,
                        "一次性任务的 run_at 必须晚于当前时间",
                    );
                }
                a.schedule = s.to_json().to_string();
                schedule_changed = true;
            }
            Err(e) => return json_err(StatusCode::BAD_REQUEST, &e),
        }
    }
    // 重算 next_run_at:调度变更,或重新启用且当前无未来排期(过期/已完成)
    if schedule_changed || (a.enabled && a.next_run_at.map_or(true, |t| t <= unix_secs())) {
        a.next_run_at = Schedule::from_json_str(&a.schedule)
            .ok()
            .and_then(|s| s.next_after(Local::now()))
            .map(|t| t.timestamp());
    }
    a.updated_at = unix_secs();
    match state.meta.db().upsert_automation(&a) {
        Ok(()) => json_ok(&automation_json(&a, &state)),
        Err(e) => json_err(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("更新任务失败: {e}"),
        ),
    }
}

/// DELETE /v1/automations/:id — 删除任务(含运行历史)。
pub async fn remove(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    match state.meta.db().delete_automation(&id) {
        Ok(()) => json_ok(&json!({ "deleted": true })),
        Err(e) => json_err(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("删除任务失败: {e}"),
        ),
    }
}

/// POST /v1/automations/:id/run — 手动立即触发一次(不推进原排期)。
pub async fn run_now(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    let Some(a) = state.meta.db().get_automation(&id).unwrap_or(None) else {
        return json_err(StatusCode::NOT_FOUND, "任务不存在");
    };
    match trigger(&state, &a, false).await {
        Ok(()) => json_ok(&json!({ "ok": true, "started": true })),
        Err(e) => json_err(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("触发失败: {e}"),
        ),
    }
}

/// GET /v1/automations/:id/runs — 任务的运行历史(按开始时间倒序)。
pub async fn runs(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    match state.meta.db().list_automation_runs(&id) {
        Ok(runs) => {
            let arr: Vec<Value> = runs
                .iter()
                .map(|r| {
                    json!({
                        "id": r.id,
                        "automation_id": r.automation_id,
                        "workspace_id": r.workspace_id,
                        "session_id": r.session_id,
                        "run_id": r.run_id,
                        "status": r.status,
                        "started_at": r.started_at,
                        "finished_at": r.finished_at,
                        "error": r.error,
                    })
                })
                .collect();
            json_ok(&json!(arr))
        }
        Err(e) => json_err(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("读取运行历史失败: {e}"),
        ),
    }
}

fn automation_json(a: &StoredAutomation, state: &AppState) -> Value {
    let schedule = Schedule::from_json_str(&a.schedule)
        .map(|s| s.to_json())
        .unwrap_or(Value::Null);
    let ws_name = state
        .meta
        .get(&a.workspace_id)
        .map(|w| w.name)
        .unwrap_or_default();
    json!({
        "id": a.id,
        "workspace_id": a.workspace_id,
        "workspace_name": ws_name,
        "name": a.name,
        "prompt": a.prompt,
        "schedule": schedule,
        "model": model_to_json(&a.model),
        "enabled": a.enabled,
        "next_run_at": a.next_run_at,
        "last_run_at": a.last_run_at,
        "last_status": a.last_status,
        "last_error": a.last_error,
        "created_at": a.created_at,
        "updated_at": a.updated_at,
    })
}

fn json_ok(v: &Value) -> Response {
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "application/json")
        .body(Body::from(v.to_string()))
        .unwrap()
}

fn json_err(status: StatusCode, msg: &str) -> Response {
    Response::builder()
        .status(status)
        .header("content-type", "application/json")
        .body(Body::from(json!({ "message": msg }).to_string()))
        .unwrap()
}

fn unix_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{Datelike, Duration as ChronoDuration, Local, Timelike};

    fn schedule_json(v: Value) -> Schedule {
        Schedule::from_json(&v).unwrap()
    }

    #[test]
    fn schedule_json_roundtrip() {
        for v in [
            json!({ "type": "once", "run_at": 1_700_000_000 }),
            json!({ "type": "interval", "every_seconds": 3600 }),
            json!({ "type": "daily", "time": "09:30" }),
            json!({ "type": "weekly", "weekday": 5, "time": "18:00" }),
            json!({ "type": "monthly", "day": 15, "time": "09:30" }),
            json!({ "type": "quarterly", "month": 2, "day": 1, "time": "10:00" }),
            json!({ "type": "yearly", "month": 12, "day": 31, "time": "23:59" }),
        ] {
            let s = schedule_json(v.clone());
            let back = Schedule::from_json(&s.to_json()).unwrap();
            assert_eq!(s, back);
            assert_eq!(s.to_json(), v);
        }
    }

    #[test]
    fn schedule_parse_rejects_bad_input() {
        assert!(Schedule::from_json(&json!({})).is_err());
        assert!(Schedule::from_json(&json!({ "type": "hourly" })).is_err());
        assert!(Schedule::from_json(&json!({ "type": "interval", "every_seconds": 0 })).is_err());
        assert!(Schedule::from_json(&json!({ "type": "daily", "time": "25:00" })).is_err());
        assert!(Schedule::from_json(&json!({ "type": "daily", "time": "9" })).is_err());
        assert!(Schedule::from_json(&json!({ "type": "weekly", "weekday": 8, "time": "09:00" })).is_err());
        assert!(Schedule::from_json(&json!({ "type": "weekly", "weekday": 0, "time": "09:00" })).is_err());
        assert!(Schedule::from_json(&json!({ "type": "once" })).is_err());
        assert!(Schedule::from_json(&json!({ "type": "monthly", "day": 0, "time": "09:00" })).is_err());
        assert!(Schedule::from_json(&json!({ "type": "monthly", "day": 32, "time": "09:00" })).is_err());
        assert!(Schedule::from_json(&json!({ "type": "monthly", "day": 15 })).is_err());
        assert!(Schedule::from_json(&json!({ "type": "quarterly", "month": 0, "day": 1, "time": "09:00" })).is_err());
        assert!(Schedule::from_json(&json!({ "type": "quarterly", "month": 4, "day": 1, "time": "09:00" })).is_err());
        assert!(Schedule::from_json(&json!({ "type": "yearly", "month": 0, "day": 1, "time": "09:00" })).is_err());
        assert!(Schedule::from_json(&json!({ "type": "yearly", "month": 13, "day": 1, "time": "09:00" })).is_err());
    }

    #[test]
    fn interval_next_is_from_plus_seconds() {
        let s = schedule_json(json!({ "type": "interval", "every_seconds": 900 }));
        let from = Local::now();
        let next = s.next_after(from).unwrap();
        assert!((next - from).num_seconds() == 900);
    }

    #[test]
    fn once_next_after_past_returns_none() {
        let past = Local::now() - ChronoDuration::hours(1);
        let s = Schedule::from_json(&json!({ "type": "once", "run_at": past.timestamp() })).unwrap();
        assert!(s.next_after(Local::now()).is_none());

        let future = Local::now() + ChronoDuration::hours(1);
        let s = Schedule::from_json(&json!({ "type": "once", "run_at": future.timestamp() })).unwrap();
        let next = s.next_after(Local::now()).unwrap();
        assert!((next - Local::now()).num_seconds().abs() <= 3600 + 5);
    }

    #[test]
    fn daily_next_is_today_or_tomorrow_at_time() {
        let s = schedule_json(json!({ "type": "daily", "time": "09:00" }));
        let from = Local::now();
        let next = s.next_after(from).unwrap();
        assert_eq!(next.hour(), 9);
        assert_eq!(next.minute(), 0);
        let diff_days = (next.date_naive() - from.date_naive()).num_days();
        assert!(diff_days == 0 || diff_days == 1);
        assert!(next > from);
    }

    #[test]
    fn weekly_next_matches_weekday_and_time() {
        // 周五 18:00
        let s = schedule_json(json!({ "type": "weekly", "weekday": 5, "time": "18:00" }));
        let from = Local::now();
        let next = s.next_after(from).unwrap();
        assert_eq!(next.hour(), 18);
        assert_eq!(next.minute(), 0);
        // 输入 5=周五 → num_days_from_monday = 4
        assert_eq!(next.weekday().num_days_from_monday(), 4);
        assert!(next > from);
        // 距下一次周五不超过 7 天
        assert!((next - from).num_days() <= 7);
    }

    #[test]
    fn weekly_wraps_from_sunday_to_monday() {
        // 周一 08:00
        let s = schedule_json(json!({ "type": "weekly", "weekday": 1, "time": "08:00" }));
        let from = Local::now();
        let next = s.next_after(from).unwrap();
        assert_eq!(next.weekday().num_days_from_monday(), 0);
        assert!(next > from);
        assert!((next - from).num_days() <= 7);
    }

    #[test]
    fn monthly_next_is_day_and_time_this_or_next_month() {
        let s = schedule_json(json!({ "type": "monthly", "day": 15, "time": "09:00" }));
        let from = Local::now();
        let next = s.next_after(from).unwrap();
        assert_eq!(next.hour(), 9);
        assert_eq!(next.minute(), 0);
        assert_eq!(next.day(), 15);
        assert!(next > from);
        let diff_days = (next.date_naive() - from.date_naive()).num_days();
        assert!((0..=31).contains(&diff_days));
    }

    #[test]
    fn month_day_at_clamps_day_to_month_length() {
        // 2024 闰年 2 月 29 天、2023 平年 28 天:day=31 取月末
        let dt = month_day_at(2024, 2, 31, 9, 0).unwrap();
        assert_eq!((dt.month(), dt.day()), (2, 29));
        let dt = month_day_at(2023, 2, 31, 9, 0).unwrap();
        assert_eq!((dt.month(), dt.day()), (2, 28));
        // 长月份不受影响
        let dt = month_day_at(2024, 1, 31, 9, 0).unwrap();
        assert_eq!((dt.month(), dt.day()), (1, 31));
        // 12 月跨年取下年 1 月 1 号的前一天
        let dt = month_day_at(2024, 12, 31, 9, 0).unwrap();
        assert_eq!((dt.month(), dt.day()), (12, 31));
    }

    #[test]
    fn quarterly_next_matches_quarter_month() {
        // 季度内第 1 个月 → 1/4/7/10 月的 1 号 09:00
        let s = schedule_json(json!({ "type": "quarterly", "month": 1, "day": 1, "time": "09:00" }));
        let from = Local::now();
        let next = s.next_after(from).unwrap();
        assert!([1, 4, 7, 10].contains(&next.month()));
        assert_eq!(next.day(), 1);
        assert!(next > from);
        assert!((next - from).num_days() <= 93);
    }

    #[test]
    fn quarterly_month_2_targets_feb_may_aug_nov() {
        let s = schedule_json(json!({ "type": "quarterly", "month": 2, "day": 10, "time": "09:00" }));
        let from = Local::now();
        let next = s.next_after(from).unwrap();
        assert!([2, 5, 8, 11].contains(&next.month()));
        assert_eq!(next.day(), 10);
        assert!(next > from);
    }

    #[test]
    fn yearly_next_is_target_month_day() {
        let s = schedule_json(json!({ "type": "yearly", "month": 12, "day": 31, "time": "23:59" }));
        let from = Local::now();
        let next = s.next_after(from).unwrap();
        assert_eq!(next.month(), 12);
        assert_eq!(next.day(), 31);
        assert!(next > from);
        assert!((next - from).num_days() <= 366);
    }

    #[test]
    fn model_field_parsing_roundtrip() {
        // 合法对象(provider 取内置定义,find_provider 可解析)
        let v = json!({
            "model": { "provider": "deepseek", "model": "deepseek-chat", "reasoning_effort": "high" }
        });
        let parsed = parse_model_field(&v).unwrap().unwrap().unwrap();
        assert_eq!(parsed.provider, "deepseek");
        assert_eq!(parsed.model, "deepseek-chat");
        assert_eq!(parsed.reasoning_effort.as_deref(), Some("high"));

        // 落库字符串 → JSON 输出 → 运行时解析 的完整往返
        let stored = serde_json::to_string(&parsed).unwrap();
        assert_eq!(model_to_json(&stored)["model"], "deepseek-chat");
        let back = model_from_stored(&stored).unwrap();
        assert_eq!(back.provider, parsed.provider);
        assert_eq!(back.model, parsed.model);

        // 未设置 / 空串 / null 均为 None
        assert!(parse_model_field(&json!({})).unwrap().is_none());
        assert!(parse_model_field(&json!({ "model": null })).unwrap().is_some());
        assert!(model_from_stored("").is_none());
        assert_eq!(model_to_json(""), Value::Null);

        // 缺字段 / 未知 provider 报错
        assert!(parse_model_field(&json!({ "model": { "model": "x" } })).is_err());
        assert!(parse_model_field(&json!({ "model": { "provider": "nope", "model": "x" } })).is_err());
    }

    #[test]
    fn trigger_creates_session_and_run_record_but_skips_missing_workspace() {
        // 用测试态:workspace 缺失 → mark_skipped
        let state = AppState::test_state(std::sync::Arc::new(crate::meta::MetaStore::new()), None);
        let a = StoredAutomation {
            id: "a1".into(),
            workspace_id: "nope".into(),
            name: "测试".into(),
            prompt: "你好".into(),
            schedule: r#"{"type":"daily","time":"09:00"}"#.into(),
            model: String::new(),
            enabled: true,
            next_run_at: Some(1),
            last_run_at: None,
            last_status: None,
            last_error: None,
            created_at: 1,
            updated_at: 1,
        };
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async { trigger(&state, &a, true).await.unwrap() });
        let got = state.meta.db().get_automation("a1").unwrap().unwrap();
        assert!(!got.enabled);
        assert_eq!(got.last_status.as_deref(), Some("skipped"));
        assert!(got.next_run_at.is_none());
        // 没有创建会话/运行记录
        assert!(state.meta.db().list_conversations("nope").unwrap().is_empty());
        assert!(state.meta.db().list_automation_runs("a1").unwrap().is_empty());
    }
}
