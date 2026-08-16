//! combo 自有的 sqlite 持久化存储。
//! workspaces:项目元数据(含可重命名的项目名),替代阶段 0 的内存缓存;
//! conversations:rune session 的本地镜像,创建/删除时双写,列表直接从
//! sqlite 读取,不依赖 rune 在线。

use crate::meta::WorkspaceMeta;
use rusqlite::{params, Connection};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// 历史 workspace 的后端标识(仅用于解析存量 sqlite 数据的 backend 字段)。
/// combo 现在只有 combo-cli 一个后端,其余值均归一化到 ComboCli。
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BackendType {
    /// 自有 agent(combo-cli serve,默认)。
    ComboCli,
}

impl BackendType {
    /// 序列化为与 wire/URL 一致的字符串。
    pub fn as_str(&self) -> &'static str {
        match self {
            BackendType::ComboCli => "combo-cli",
        }
    }

    /// 解析后端字符串,未知值(含历史 "crush")回退到 ComboCli(默认 agent)。
    pub fn parse(s: &str) -> BackendType {
        match s {
            // combo-cli 及历史拼写都归一化到 ComboCli;
            // "crush" 已废弃,存量数据自动迁移到 ComboCli。
            "combo-cli" | "combo_cli" | "combocli" | "crush" => BackendType::ComboCli,
            _ => BackendType::ComboCli,
        }
    }
}

/// 默认数据库路径:`COMBO_DATA_DIR` 或统一目录 `~/.config/combo/combo.db`
/// (见 `paths::default_data_dir`)。
pub fn default_db_path() -> PathBuf {
    crate::paths::default_data_dir().join("combo.db")
}

/// conversation 元数据(rune session 的镜像)。
#[derive(Clone, Debug)]
pub struct ConversationMeta {
    pub id: String,
    pub workspace_id: String,
    pub title: String,
    pub message_count: i64,
    pub created_at: i64,
    pub updated_at: i64,
    /// 累计输入 token(provider 上报,全部 completion 调用之和)。
    pub prompt_tokens: i64,
    /// 累计输出 token(provider 上报,全部 completion 调用之和)。
    pub completion_tokens: i64,
    /// 累计花费(USD)。
    pub cost: f64,
    /// 最近一次 run 的上下文占用(最后一次 completion 的 input+output,
    /// rig 原生 usage;驱动 compact 触发判断与前端用量环)。
    pub context_tokens: i64,
}

/// 单条消息的持久化记录(parts 为 JSON 字符串)。
#[derive(Clone, Debug)]
pub struct StoredMessage {
    pub id: String,
    pub role: String,
    pub parts: String,
    pub created_at: i64,
    pub updated_at: i64,
}

/// 远程访问令牌(移动端扫码连接用)。
#[derive(Clone, Debug)]
pub struct AccessToken {
    pub token: String,
    pub label: String,
    pub created_at: i64,
    /// 过期时间(unix 秒);None 表示永不过期。
    pub expires_at: Option<i64>,
    pub last_used_at: Option<i64>,
    pub revoked: bool,
}

/// 自动化任务(定时任务)。`schedule` 为 JSON 字符串,
/// 结构见 `automation.rs::Schedule`。
#[derive(Clone, Debug)]
pub struct StoredAutomation {
    pub id: String,
    pub workspace_id: String,
    pub name: String,
    pub prompt: String,
    /// 调度配置(JSON 字符串:`{ "type": "once|interval|daily|weekly", ... }`)。
    pub schedule: String,
    pub enabled: bool,
    /// 下次触发时间(unix 秒);None 表示不再调度(一次性任务已执行)。
    pub next_run_at: Option<i64>,
    pub last_run_at: Option<i64>,
    /// 最近一次运行结果:success | error | cancelled | skipped。
    pub last_status: Option<String>,
    pub last_error: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// 自动化任务的一次运行记录。
#[derive(Clone, Debug)]
pub struct AutomationRun {
    pub id: String,
    pub automation_id: String,
    pub workspace_id: String,
    pub session_id: String,
    pub run_id: String,
    /// running | success | error | cancelled
    pub status: String,
    pub started_at: i64,
    pub finished_at: Option<i64>,
    pub error: Option<String>,
}


/// 线程安全的 sqlite 连接。所有方法都是短事务,持锁时间可忽略。
pub struct ComboDb {
    conn: Mutex<Connection>,
}

impl ComboDb {
    /// 打开(必要时创建)数据库文件。
    ///
    /// WAL + busy_timeout:桌面安装版、tauri dev、独立 serve 可能多个进程
    /// 同时打开同一个 combo.db。默认 rollback journal 下跨进程读写立刻
    /// 报 database is locked,文件被对端进程(如目录迁移)替换/截断后
    /// 连接还会退化成 readonly;WAL 允许并发读 + 单写,busy_timeout 让
    /// 写锁竞争自动等待而非立即失败。
    pub fn open(path: &Path) -> anyhow::Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let conn = Connection::open(path)?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        // journal_mode 的写形式会返回结果行,不能用 execute_batch。
        let _mode: String = conn
            .query_row("PRAGMA journal_mode=WAL", [], |row| row.get(0))
            .unwrap_or_default();
        conn.execute_batch("PRAGMA synchronous=NORMAL;")?;
        Self::init(conn)
    }

    /// 内存库,用于测试。
    pub fn in_memory() -> Self {
        let conn = Connection::open_in_memory().expect("in-memory sqlite");
        Self::init(conn).expect("init in-memory sqlite")
    }

    fn init(conn: Connection) -> anyhow::Result<Self> {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS workspaces (
                id         TEXT PRIMARY KEY,
                path       TEXT NOT NULL,
                name       TEXT NOT NULL,
                backend    TEXT NOT NULL,
                created_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS conversations (
                id            TEXT PRIMARY KEY,
                workspace_id  TEXT NOT NULL,
                title         TEXT NOT NULL,
                message_count INTEGER NOT NULL DEFAULT 0,
                created_at    INTEGER NOT NULL,
                updated_at    INTEGER NOT NULL,
                prompt_tokens      INTEGER NOT NULL DEFAULT 0,
                completion_tokens  INTEGER NOT NULL DEFAULT 0,
                cost               REAL    NOT NULL DEFAULT 0.0,
                context_tokens     INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS idx_conv_ws ON conversations(workspace_id);
            CREATE TABLE IF NOT EXISTS messages (
                id            TEXT PRIMARY KEY,
                workspace_id  TEXT NOT NULL,
                session_id    TEXT NOT NULL,
                role          TEXT NOT NULL,
                parts         TEXT NOT NULL DEFAULT '[]',
                created_at    INTEGER NOT NULL,
                updated_at    INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_msg_session ON messages(workspace_id, session_id);
            CREATE TABLE IF NOT EXISTS access_tokens (
                token        TEXT PRIMARY KEY,
                label        TEXT NOT NULL DEFAULT '',
                created_at   INTEGER NOT NULL,
                expires_at   INTEGER,
                last_used_at INTEGER,
                revoked      INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS workspace_config (
                workspace_id    TEXT PRIMARY KEY,
                disabled_skills TEXT NOT NULL DEFAULT '[]'
            );
            CREATE TABLE IF NOT EXISTS automations (
                id            TEXT PRIMARY KEY,
                workspace_id  TEXT NOT NULL,
                name          TEXT NOT NULL,
                prompt        TEXT NOT NULL,
                schedule      TEXT NOT NULL,
                enabled       INTEGER NOT NULL DEFAULT 1,
                next_run_at   INTEGER,
                last_run_at   INTEGER,
                last_status   TEXT,
                last_error    TEXT,
                created_at    INTEGER NOT NULL,
                updated_at    INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_automation_ws ON automations(workspace_id);
            CREATE TABLE IF NOT EXISTS automation_runs (
                id            TEXT PRIMARY KEY,
                automation_id TEXT NOT NULL,
                workspace_id  TEXT NOT NULL,
                session_id    TEXT NOT NULL,
                run_id        TEXT NOT NULL,
                status        TEXT NOT NULL,
                started_at    INTEGER NOT NULL,
                finished_at   INTEGER,
                error         TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_automation_runs ON automation_runs(automation_id);",
        )?;
        // 容错迁移:旧库可能缺少新增列,逐个尝试添加(已存在则忽略)。
        let mig = [
            "ALTER TABLE conversations ADD COLUMN prompt_tokens INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE conversations ADD COLUMN completion_tokens INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE conversations ADD COLUMN cost REAL NOT NULL DEFAULT 0.0",
            "ALTER TABLE conversations ADD COLUMN context_tokens INTEGER NOT NULL DEFAULT 0",
        ];
        for sql in &mig {
            let _ = conn.execute(sql, []);
        }
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    // ---------- workspaces ----------

    pub fn upsert_workspace(&self, w: &WorkspaceMeta) -> anyhow::Result<()> {
        self.conn
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO workspaces (id, path, name, backend, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(id) DO UPDATE SET path=?2, name=?3, backend=?4",
                params![
                    w.id,
                    w.path.to_string_lossy(),
                    w.name,
                    w.backend_type.as_str(),
                    unix_secs()
                ],
            )?;
        Ok(())
    }

    pub fn get_workspace(&self, id: &str) -> anyhow::Result<Option<WorkspaceMeta>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT id, path, name, backend FROM workspaces WHERE id=?1")?;
        let mut rows = stmt.query(params![id])?;
        let row = match rows.next()? {
            Some(r) => r,
            None => return Ok(None),
        };
        Ok(Some(WorkspaceMeta {
            id: row.get(0)?,
            path: PathBuf::from(row.get::<_, String>(1)?),
            name: row.get(2)?,
            backend_type: BackendType::parse(&row.get::<_, String>(3)?),
        }))
    }

    pub fn list_workspaces(&self) -> anyhow::Result<Vec<WorkspaceMeta>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, path, name, backend FROM workspaces ORDER BY created_at ASC",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(WorkspaceMeta {
                id: r.get(0)?,
                path: PathBuf::from(r.get::<_, String>(1)?),
                name: r.get(2)?,
                backend_type: BackendType::parse(&r.get::<_, String>(3)?),
            })
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    pub fn delete_workspace(&self, id: &str) -> anyhow::Result<()> {
        self.conn
            .lock()
            .unwrap()
            .execute("DELETE FROM workspaces WHERE id=?1", params![id])?;
        Ok(())
    }

    /// 删除某个 workspace 下的所有会话镜像(删除项目时级联清理)。
    pub fn delete_conversations_by_workspace(&self, workspace_id: &str) -> anyhow::Result<()> {
        self.conn.lock().unwrap().execute(
            "DELETE FROM conversations WHERE workspace_id=?1",
            params![workspace_id],
        )?;
        Ok(())
    }

    pub fn rename_workspace(&self, id: &str, name: &str) -> anyhow::Result<()> {
        self.conn
            .lock()
            .unwrap()
            .execute(
                "UPDATE workspaces SET name=?1 WHERE id=?2",
                params![name, id],
            )?;
        Ok(())
    }

    /// 更新 workspace 的绑定目录(更换目录时使用)。
    pub fn update_workspace_path(&self, id: &str, path: &str) -> anyhow::Result<()> {
        self.conn
            .lock()
            .unwrap()
            .execute(
                "UPDATE workspaces SET path=?1 WHERE id=?2",
                params![path, id],
            )?;
        Ok(())
    }

    /// 更新 workspace 的后端类型(切换 agent 时使用)。
    pub fn update_workspace_backend(&self, id: &str, backend: &str) -> anyhow::Result<()> {
        self.conn
            .lock()
            .unwrap()
            .execute(
                "UPDATE workspaces SET backend=?1 WHERE id=?2",
                params![backend, id],
            )?;
        Ok(())
    }

    // ---------- workspace 配置(技能开关) ----------

    /// 读取 workspace 禁用的 skill 名列表(JSON 数组;未设置时为空)。
    pub fn get_disabled_skills(&self, workspace_id: &str) -> anyhow::Result<Vec<String>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt =
            conn.prepare("SELECT disabled_skills FROM workspace_config WHERE workspace_id=?1")?;
        let mut rows = stmt.query(params![workspace_id])?;
        match rows.next()? {
            Some(row) => {
                let raw: String = row.get(0)?;
                Ok(serde_json::from_str(&raw).unwrap_or_default())
            }
            None => Ok(Vec::new()),
        }
    }

    /// 保存 workspace 禁用的 skill 名列表。
    pub fn set_disabled_skills(&self, workspace_id: &str, skills: &[String]) -> anyhow::Result<()> {
        let raw = serde_json::to_string(skills)?;
        self.conn.lock().unwrap().execute(
            "INSERT INTO workspace_config (workspace_id, disabled_skills) VALUES (?1, ?2)
             ON CONFLICT(workspace_id) DO UPDATE SET disabled_skills=?2",
            params![workspace_id, raw],
        )?;
        Ok(())
    }

    // ---------- conversations ----------

    pub fn upsert_conversation(&self, c: &ConversationMeta) -> anyhow::Result<()> {
        self.conn
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO conversations (id, workspace_id, title, message_count, created_at, updated_at, prompt_tokens, completion_tokens, cost, context_tokens)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
                 ON CONFLICT(id) DO UPDATE SET
                     title=excluded.title,
                     message_count=excluded.message_count,
                     updated_at=excluded.updated_at",
                params![
                    c.id,
                    c.workspace_id,
                    c.title,
                    c.message_count,
                    c.created_at,
                    c.updated_at,
                    c.prompt_tokens,
                    c.completion_tokens,
                    c.cost,
                    c.context_tokens
                ],
            )?;
        Ok(())
    }

    pub fn list_conversations(&self, workspace_id: &str) -> anyhow::Result<Vec<ConversationMeta>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, workspace_id, title, message_count, created_at, updated_at,
                    prompt_tokens, completion_tokens, cost, context_tokens
             FROM conversations WHERE workspace_id=?1 ORDER BY updated_at DESC",
        )?;
        let rows = stmt.query_map(params![workspace_id], row_to_conv)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    /// 跨多个 workspace ID 查询会话(后端重启后同一 path 可能有多个别名 ID,
    /// 会话可能挂在任一别名下)。
    pub fn list_conversations_multi(
        &self,
        workspace_ids: &[String],
    ) -> anyhow::Result<Vec<ConversationMeta>> {
        if workspace_ids.is_empty() {
            return Ok(Vec::new());
        }
        let conn = self.conn.lock().unwrap();
        let placeholders = workspace_ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
        let sql = format!(
            "SELECT id, workspace_id, title, message_count, created_at, updated_at,
                    prompt_tokens, completion_tokens, cost, context_tokens
             FROM conversations WHERE workspace_id IN ({placeholders})
             ORDER BY updated_at DESC"
        );
        let params: Vec<&dyn rusqlite::ToSql> = workspace_ids
            .iter()
            .map(|s| s as &dyn rusqlite::ToSql)
            .collect();
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params.as_slice(), row_to_conv)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    pub fn delete_conversation(&self, id: &str) -> anyhow::Result<()> {
        self.conn
            .lock()
            .unwrap()
            .execute("DELETE FROM conversations WHERE id=?1", params![id])?;
        Ok(())
    }

    /// 重命名会话标题(仅更新 sqlite 镜像,不影响 rune 端)。
    pub fn rename_conversation(&self, id: &str, title: &str) -> anyhow::Result<()> {
        self.conn.lock().unwrap().execute(
            "UPDATE conversations SET title=?1, updated_at=?2 WHERE id=?3",
            params![title, unix_secs(), id],
        )?;
        Ok(())
    }

    /// 累加 token 用量与花费到会话(每次 run 结束后调用)。
    ///
    /// `prompt_tokens`/`completion_tokens` 为本次 run 全部 completion 调用的
    /// 累计(rig 原生 Usage 求和);`context_tokens` 为最后一次调用的
    /// input+output,即当前上下文窗口占用(直接覆盖,不累加)。
    pub fn add_usage(
        &self,
        session_id: &str,
        prompt_tokens: i64,
        completion_tokens: i64,
        cost: f64,
        context_tokens: i64,
    ) -> anyhow::Result<()> {
        self.conn.lock().unwrap().execute(
            "UPDATE conversations SET
                prompt_tokens = prompt_tokens + ?1,
                completion_tokens = completion_tokens + ?2,
                cost = cost + ?3,
                context_tokens = ?4,
                updated_at = ?5
             WHERE id = ?6",
            params![prompt_tokens, completion_tokens, cost, context_tokens, unix_secs(), session_id],
        )?;
        Ok(())
    }

    /// 读取会话最近一次 run 的上下文占用(token;无会话或未上报时返回 None)。
    pub fn get_context_tokens(&self, session_id: &str) -> Option<i64> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT context_tokens FROM conversations WHERE id=?1")
            .ok()?;
        let mut rows = stmt.query(params![session_id]).ok()?;
        let row = rows.next().ok()??;
        let v: i64 = row.get(0).ok()?;
        (v > 0).then_some(v)
    }

    /// 直接设置会话的上下文占用(自动压缩完成后重置,避免旧值反复触发压缩)。
    pub fn set_context_tokens(&self, session_id: &str, tokens: i64) -> anyhow::Result<()> {
        self.conn.lock().unwrap().execute(
            "UPDATE conversations SET context_tokens=?2 WHERE id=?1",
            params![session_id, tokens],
        )?;
        Ok(())
    }

    // ---------- messages ----------

    /// 写入或更新单条消息(INSERT OR REPLACE)。
    pub fn upsert_message(
        &self,
        workspace_id: &str,
        session_id: &str,
        id: &str,
        role: &str,
        parts_json: &str,
        created_at: i64,
        updated_at: i64,
    ) -> anyhow::Result<()> {
        self.conn.lock().unwrap().execute(
            "INSERT INTO messages (id, workspace_id, session_id, role, parts, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(id) DO UPDATE SET
                 role=excluded.role,
                 parts=excluded.parts,
                 updated_at=excluded.updated_at",
            params![id, workspace_id, session_id, role, parts_json, created_at, updated_at],
        )?;
        Ok(())
    }

    /// 列出某个会话下的全部消息,按 created_at 升序;
    /// 同一秒内的多条消息(streaming 场景常见)再按插入顺序(rowid)排,
    /// 保证与 SSE 事件到达顺序一致,避免 assistant 与 user 同秒时错位。
    /// 仅按 session_id 过滤:session ID 是全局唯一的 UUID,
    /// 后端重启后 workspace ID 会变,按 workspace_id 过滤会导致历史丢失。
    pub fn list_messages(
        &self,
        _workspace_id: &str,
        session_id: &str,
    ) -> anyhow::Result<Vec<StoredMessage>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, role, parts, created_at, updated_at
             FROM messages WHERE session_id=?1
             ORDER BY created_at ASC, rowid ASC",
        )?;
        let rows = stmt.query_map(params![session_id], |r| {
            Ok(StoredMessage {
                id: r.get(0)?,
                role: r.get(1)?,
                parts: r.get(2)?,
                created_at: r.get(3)?,
                updated_at: r.get(4)?,
            })
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    /// 删除某个会话下的所有消息。仅按 session_id 过滤(同 list_messages 理由)。
    pub fn delete_messages_by_session(
        &self,
        _workspace_id: &str,
        session_id: &str,
    ) -> anyhow::Result<()> {
        self.conn.lock().unwrap().execute(
            "DELETE FROM messages WHERE session_id=?1",
            params![session_id],
        )?;
        Ok(())
    }

    /// 删除单条消息(按消息 ID)。
    pub fn delete_message(&self, id: &str) -> anyhow::Result<()> {
        self.conn
            .lock()
            .unwrap()
            .execute("DELETE FROM messages WHERE id=?1", params![id])?;
        Ok(())
    }

    /// 删除某个 workspace 下的所有消息(删除项目时级联清理)。
    pub fn delete_messages_by_workspace(&self, workspace_id: &str) -> anyhow::Result<()> {
        self.conn
            .lock()
            .unwrap()
            .execute("DELETE FROM messages WHERE workspace_id=?1", params![workspace_id])?;
        Ok(())
    }

    // ---------- access_tokens ----------

    /// 写入一个新令牌。
    pub fn insert_token(
        &self,
        token: &str,
        label: &str,
        expires_at: Option<i64>,
    ) -> anyhow::Result<()> {
        self.conn.lock().unwrap().execute(
            "INSERT INTO access_tokens (token, label, created_at, expires_at, last_used_at, revoked)
             VALUES (?1, ?2, ?3, ?4, NULL, 0)",
            params![token, label, unix_secs(), expires_at],
        )?;
        Ok(())
    }

    /// 按 token 明文查询单条令牌(不论是否已撤销)。
    pub fn get_token(&self, token: &str) -> anyhow::Result<Option<AccessToken>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT token, label, created_at, expires_at, last_used_at, revoked
             FROM access_tokens WHERE token=?1",
        )?;
        let mut rows = stmt.query(params![token])?;
        let row = match rows.next()? {
            Some(r) => r,
            None => return Ok(None),
        };
        Ok(Some(row_to_token(row)?))
    }

    /// 列出全部令牌(按创建时间倒序)。
    pub fn list_tokens(&self) -> anyhow::Result<Vec<AccessToken>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT token, label, created_at, expires_at, last_used_at, revoked
             FROM access_tokens ORDER BY created_at DESC",
        )?;
        let rows = stmt.query_map([], row_to_token)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    /// 更新令牌的最后使用时间。
    pub fn touch_token(&self, token: &str) -> anyhow::Result<()> {
        self.conn.lock().unwrap().execute(
            "UPDATE access_tokens SET last_used_at=?1 WHERE token=?2",
            params![unix_secs(), token],
        )?;
        Ok(())
    }

    /// 撤销指定令牌(软删除,保留记录)。
    pub fn revoke_token(&self, token: &str) -> anyhow::Result<bool> {
        let n = self.conn.lock().unwrap().execute(
            "UPDATE access_tokens SET revoked=1 WHERE token=?1",
            params![token],
        )?;
        Ok(n > 0)
    }

    /// 撤销所有令牌。
    pub fn revoke_all_tokens(&self) -> anyhow::Result<()> {
        self.conn
            .lock()
            .unwrap()
            .execute("UPDATE access_tokens SET revoked=1", [])?;
        Ok(())
    }

    // ---------- automations ----------

    /// 写入(插入或按 id 覆盖)一条自动化任务。
    pub fn upsert_automation(&self, a: &StoredAutomation) -> anyhow::Result<()> {
        self.conn.lock().unwrap().execute(
            "INSERT INTO automations (id, workspace_id, name, prompt, schedule, enabled,
                                      next_run_at, last_run_at, last_status, last_error,
                                      created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
             ON CONFLICT(id) DO UPDATE SET
                 workspace_id=excluded.workspace_id,
                 name=excluded.name,
                 prompt=excluded.prompt,
                 schedule=excluded.schedule,
                 enabled=excluded.enabled,
                 next_run_at=excluded.next_run_at,
                 last_run_at=excluded.last_run_at,
                 last_status=excluded.last_status,
                 last_error=excluded.last_error,
                 updated_at=excluded.updated_at",
            params![
                a.id,
                a.workspace_id,
                a.name,
                a.prompt,
                a.schedule,
                a.enabled as i64,
                a.next_run_at,
                a.last_run_at,
                a.last_status,
                a.last_error,
                a.created_at,
                a.updated_at,
            ],
        )?;
        Ok(())
    }

    pub fn get_automation(&self, id: &str) -> anyhow::Result<Option<StoredAutomation>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, workspace_id, name, prompt, schedule, enabled, next_run_at,
                    last_run_at, last_status, last_error, created_at, updated_at
             FROM automations WHERE id=?1",
        )?;
        let mut rows = stmt.query(params![id])?;
        let row = match rows.next()? {
            Some(r) => r,
            None => return Ok(None),
        };
        Ok(Some(row_to_automation(row)?))
    }

    /// 列出全部自动化任务(按创建时间倒序)。
    pub fn list_automations(&self) -> anyhow::Result<Vec<StoredAutomation>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, workspace_id, name, prompt, schedule, enabled, next_run_at,
                    last_run_at, last_status, last_error, created_at, updated_at
             FROM automations ORDER BY created_at DESC",
        )?;
        let rows = stmt.query_map([], row_to_automation)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    /// 列出某个 workspace 下的全部自动化任务(按创建时间倒序)。
    pub fn list_automations_by_workspace(
        &self,
        workspace_id: &str,
    ) -> anyhow::Result<Vec<StoredAutomation>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, workspace_id, name, prompt, schedule, enabled, next_run_at,
                    last_run_at, last_status, last_error, created_at, updated_at
             FROM automations WHERE workspace_id=?1 ORDER BY created_at DESC",
        )?;
        let rows = stmt.query_map(params![workspace_id], row_to_automation)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    /// 列出到期待触发的任务(enabled 且 next_run_at 非空且 <= now)。
    pub fn list_due_automations(&self, now: i64) -> anyhow::Result<Vec<StoredAutomation>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, workspace_id, name, prompt, schedule, enabled, next_run_at,
                    last_run_at, last_status, last_error, created_at, updated_at
             FROM automations WHERE enabled=1 AND next_run_at IS NOT NULL AND next_run_at <= ?1
             ORDER BY next_run_at ASC",
        )?;
        let rows = stmt.query_map(params![now], row_to_automation)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    pub fn delete_automation(&self, id: &str) -> anyhow::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM automations WHERE id=?1", params![id])?;
        conn.execute("DELETE FROM automation_runs WHERE automation_id=?1", params![id])?;
        Ok(())
    }

    /// 删除某个 workspace 下的所有自动化任务(删除项目时级联清理)。
    pub fn delete_automations_by_workspace(&self, workspace_id: &str) -> anyhow::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM automations WHERE workspace_id=?1",
            params![workspace_id],
        )?;
        conn.execute(
            "DELETE FROM automation_runs WHERE workspace_id=?1",
            params![workspace_id],
        )?;
        Ok(())
    }

    // ---------- automation_runs ----------

    pub fn insert_automation_run(&self, r: &AutomationRun) -> anyhow::Result<()> {
        self.conn.lock().unwrap().execute(
            "INSERT INTO automation_runs (id, automation_id, workspace_id, session_id, run_id,
                                          status, started_at, finished_at, error)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                r.id,
                r.automation_id,
                r.workspace_id,
                r.session_id,
                r.run_id,
                r.status,
                r.started_at,
                r.finished_at,
                r.error,
            ],
        )?;
        Ok(())
    }

    /// 更新一条运行记录的状态/结束时间/错误(按 id 匹配)。
    pub fn update_automation_run(
        &self,
        id: &str,
        status: &str,
        finished_at: i64,
        error: Option<&str>,
    ) -> anyhow::Result<bool> {
        let n = self.conn.lock().unwrap().execute(
            "UPDATE automation_runs SET status=?1, finished_at=?2, error=?3 WHERE id=?4",
            params![status, finished_at, error, id],
        )?;
        Ok(n > 0)
    }

    /// 列出某自动化任务的运行历史(按开始时间倒序,最多 100 条)。
    pub fn list_automation_runs(&self, automation_id: &str) -> anyhow::Result<Vec<AutomationRun>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, automation_id, workspace_id, session_id, run_id, status,
                    started_at, finished_at, error
             FROM automation_runs WHERE automation_id=?1 ORDER BY started_at DESC LIMIT 100",
        )?;
        let rows = stmt.query_map(params![automation_id], row_to_automation_run)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }
}

fn row_to_conv(r: &rusqlite::Row<'_>) -> rusqlite::Result<ConversationMeta> {
    Ok(ConversationMeta {
        id: r.get(0)?,
        workspace_id: r.get(1)?,
        title: r.get(2)?,
        message_count: r.get(3)?,
        created_at: r.get(4)?,
        updated_at: r.get(5)?,
        prompt_tokens: r.get::<_, Option<i64>>(6)?.unwrap_or(0),
        completion_tokens: r.get::<_, Option<i64>>(7)?.unwrap_or(0),
        cost: r.get::<_, Option<f64>>(8)?.unwrap_or(0.0),
        context_tokens: r.get::<_, Option<i64>>(9)?.unwrap_or(0),
    })
}

fn row_to_token(r: &rusqlite::Row<'_>) -> rusqlite::Result<AccessToken> {
    Ok(AccessToken {
        token: r.get(0)?,
        label: r.get(1)?,
        created_at: r.get(2)?,
        expires_at: r.get(3)?,
        last_used_at: r.get(4)?,
        revoked: r.get::<_, i64>(5)? != 0,
    })
}

fn row_to_automation(r: &rusqlite::Row<'_>) -> rusqlite::Result<StoredAutomation> {
    Ok(StoredAutomation {
        id: r.get(0)?,
        workspace_id: r.get(1)?,
        name: r.get(2)?,
        prompt: r.get(3)?,
        schedule: r.get(4)?,
        enabled: r.get::<_, i64>(5)? != 0,
        next_run_at: r.get(6)?,
        last_run_at: r.get(7)?,
        last_status: r.get(8)?,
        last_error: r.get(9)?,
        created_at: r.get(10)?,
        updated_at: r.get(11)?,
    })
}

fn row_to_automation_run(r: &rusqlite::Row<'_>) -> rusqlite::Result<AutomationRun> {
    Ok(AutomationRun {
        id: r.get(0)?,
        automation_id: r.get(1)?,
        workspace_id: r.get(2)?,
        session_id: r.get(3)?,
        run_id: r.get(4)?,
        status: r.get(5)?,
        started_at: r.get(6)?,
        finished_at: r.get(7)?,
        error: r.get(8)?,
    })
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

    fn ws(id: &str, name: &str) -> WorkspaceMeta {
        WorkspaceMeta {
            id: id.into(),
            path: PathBuf::from(format!("/tmp/{id}")),
            name: name.into(),
            backend_type: BackendType::ComboCli,
        }
    }

    fn conv(id: &str, ws: &str) -> ConversationMeta {
        ConversationMeta {
            id: id.into(),
            workspace_id: ws.into(),
            title: "会话".into(),
            message_count: 0,
            created_at: 1,
            updated_at: 2,
            prompt_tokens: 0,
            completion_tokens: 0,
            cost: 0.0,
            context_tokens: 0,
        }
    }

    #[test]
    fn workspace_roundtrip() {
        let db = ComboDb::in_memory();
        db.upsert_workspace(&ws("w1", "项目一")).unwrap();
        let got = db.get_workspace("w1").unwrap().unwrap();
        assert_eq!(got.id, "w1");
        assert_eq!(got.name, "项目一");
        assert_eq!(db.list_workspaces().unwrap().len(), 1);
    }

    #[test]
    fn rename_workspace() {
        let db = ComboDb::in_memory();
        db.upsert_workspace(&ws("w1", "旧名")).unwrap();
        db.rename_workspace("w1", "新名").unwrap();
        assert_eq!(db.get_workspace("w1").unwrap().unwrap().name, "新名");
    }

    #[test]
    fn update_workspace_path_changes_path() {
        let db = ComboDb::in_memory();
        db.upsert_workspace(&ws("w1", "项目一")).unwrap();
        assert_eq!(
            db.get_workspace("w1").unwrap().unwrap().path,
            PathBuf::from("/tmp/w1")
        );
        db.update_workspace_path("w1", "/new/path").unwrap();
        assert_eq!(
            db.get_workspace("w1").unwrap().unwrap().path,
            PathBuf::from("/new/path")
        );
        // name 不受影响
        assert_eq!(db.get_workspace("w1").unwrap().unwrap().name, "项目一");
    }

    #[test]
    fn conversation_roundtrip_and_delete() {
        let db = ComboDb::in_memory();
        db.upsert_conversation(&conv("c1", "w1")).unwrap();
        db.upsert_conversation(&conv("c2", "w1")).unwrap();
        db.upsert_conversation(&conv("c3", "w2")).unwrap();
        assert_eq!(db.list_conversations("w1").unwrap().len(), 2);
        db.delete_conversation("c1").unwrap();
        assert_eq!(db.list_conversations("w1").unwrap().len(), 1);
        assert_eq!(db.list_conversations("w2").unwrap().len(), 1);
    }

    #[test]
    fn rename_conversation_updates_title() {
        let db = ComboDb::in_memory();
        db.upsert_conversation(&conv("c1", "w1")).unwrap();
        db.rename_conversation("c1", "新标题").unwrap();
        let convs = db.list_conversations("w1").unwrap();
        assert_eq!(convs[0].title, "新标题");
    }

    #[test]
    fn add_usage_accumulates_and_sets_context_tokens() {
        let db = ComboDb::in_memory();
        db.upsert_conversation(&conv("c1", "w1")).unwrap();
        // 两次 run:累计 prompt/completion 消耗,context_tokens 覆盖为最后一次
        db.add_usage("c1", 1000, 200, 0.01, 1200).unwrap();
        db.add_usage("c1", 3000, 400, 0.02, 3400).unwrap();
        let convs = db.list_conversations("w1").unwrap();
        assert_eq!(convs[0].prompt_tokens, 4000);
        assert_eq!(convs[0].completion_tokens, 600);
        assert!((convs[0].cost - 0.03).abs() < 1e-9);
        assert_eq!(convs[0].context_tokens, 3400);
        // get_context_tokens:>0 时返回 Some
        assert_eq!(db.get_context_tokens("c1"), Some(3400));
        // 压缩后重置
        db.set_context_tokens("c1", 500).unwrap();
        assert_eq!(db.get_context_tokens("c1"), Some(500));
        // 不存在的会话 / 未上报(0)→ None
        assert_eq!(db.get_context_tokens("nope"), None);
        db.upsert_conversation(&conv("c2", "w1")).unwrap();
        assert_eq!(db.get_context_tokens("c2"), None);
    }

    #[test]
    fn message_upsert_list_delete() {
        let db = ComboDb::in_memory();
        db.upsert_message("w1", "s1", "m1", "user", r#"[{"type":"text"}]"#, 100, 100)
            .unwrap();
        db.upsert_message("w1", "s1", "m2", "assistant", r#"[{"type":"text"}]"#, 200, 200)
            .unwrap();
        db.upsert_message("w1", "s2", "m3", "user", r#"[]"#, 300, 300)
            .unwrap();

        let msgs = db.list_messages("w1", "s1").unwrap();
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0].id, "m1");
        assert_eq!(msgs[1].id, "m2");

        // upsert 同 id → 更新
        db.upsert_message("w1", "s1", "m1", "user", r#"[{"type":"text","updated":true}]"#, 100, 150)
            .unwrap();
        let msgs = db.list_messages("w1", "s1").unwrap();
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0].updated_at, 150);

        db.delete_messages_by_session("w1", "s1").unwrap();
        assert_eq!(db.list_messages("w1", "s1").unwrap().len(), 0);
        assert_eq!(db.list_messages("w1", "s2").unwrap().len(), 1);

        db.delete_messages_by_workspace("w1").unwrap();
        assert_eq!(db.list_messages("w1", "s2").unwrap().len(), 0);
    }

    #[test]
    fn list_messages_ignores_workspace_id_mismatch() {
        // 后端重启后 workspace ID 会变,但 session ID 不变。
        // list_messages 按 session_id 查询,忽略 workspace_id 差异。
        let db = ComboDb::in_memory();
        db.upsert_message("old-ws", "s1", "m1", "user", r#"[{"type":"text"}]"#, 100, 100)
            .unwrap();
        // 用新 workspace_id 查询,仍应找到消息
        let msgs = db.list_messages("new-ws", "s1").unwrap();
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0].id, "m1");

        // 按 session_id 删除,不依赖 workspace_id
        db.delete_messages_by_session("new-ws", "s1").unwrap();
        assert_eq!(db.list_messages("old-ws", "s1").unwrap().len(), 0);
    }

    #[test]
    fn list_conversations_multi_finds_across_alias_ids() {
        // 后端重启后同一 path 产生多个 workspace ID,
        // 会话可能挂在任一别名下,list_conversations_multi 应全部找到。
        let db = ComboDb::in_memory();
        db.upsert_conversation(&conv("c1", "ws-old")).unwrap();
        db.upsert_conversation(&conv("c2", "ws-old")).unwrap();
        db.upsert_conversation(&conv("c3", "ws-new")).unwrap();

        let ids = vec!["ws-new".to_string(), "ws-old".to_string()];
        let convs = db.list_conversations_multi(&ids).unwrap();
        assert_eq!(convs.len(), 3);
    }

    #[test]
    fn token_insert_get_list_revoke() {
        let db = ComboDb::in_memory();
        db.insert_token("tok-1", "手机A", Some(999)).unwrap();
        db.insert_token("tok-2", "手机B", None).unwrap();

        let got = db.get_token("tok-1").unwrap().unwrap();
        assert_eq!(got.label, "手机A");
        assert_eq!(got.expires_at, Some(999));
        assert!(!got.revoked);

        let all = db.list_tokens().unwrap();
        assert_eq!(all.len(), 2);

        // 撤销单个
        assert!(db.revoke_token("tok-1").unwrap());
        let got = db.get_token("tok-1").unwrap().unwrap();
        assert!(got.revoked);
        assert!(!db.revoke_token("missing").unwrap());

        // touch 更新最后使用时间
        db.touch_token("tok-2").unwrap();
        let got = db.get_token("tok-2").unwrap().unwrap();
        assert!(got.last_used_at.is_some());

        // 撤销全部
        db.revoke_all_tokens().unwrap();
        for t in db.list_tokens().unwrap() {
            assert!(t.revoked);
        }
    }

    #[test]
    fn disabled_skills_default_empty_then_set_get() {
        let db = ComboDb::in_memory();
        // 未设置时返回空列表
        assert!(db.get_disabled_skills("ws-1").unwrap().is_empty());

        db.set_disabled_skills("ws-1", &["foo".into(), "bar".into()]).unwrap();
        let got = db.get_disabled_skills("ws-1").unwrap();
        assert_eq!(got, vec!["foo", "bar"]);

        // 覆盖更新
        db.set_disabled_skills("ws-1", &["baz".into()]).unwrap();
        assert_eq!(db.get_disabled_skills("ws-1").unwrap(), vec!["baz"]);

        // 不同 workspace 互不影响
        assert!(db.get_disabled_skills("ws-2").unwrap().is_empty());
    }

    fn auto(id: &str, ws: &str, next: Option<i64>) -> StoredAutomation {
        StoredAutomation {
            id: id.into(),
            workspace_id: ws.into(),
            name: format!("任务 {id}"),
            prompt: "帮我整理周报".into(),
            schedule: r#"{"type":"daily","time":"09:00"}"#.into(),
            enabled: true,
            next_run_at: next,
            last_run_at: None,
            last_status: None,
            last_error: None,
            created_at: 1,
            updated_at: 1,
        }
    }

    fn run_rec(id: &str, auto: &str, ws: &str) -> AutomationRun {
        AutomationRun {
            id: id.into(),
            automation_id: auto.into(),
            workspace_id: ws.into(),
            session_id: "s1".into(),
            run_id: "r1".into(),
            status: "running".into(),
            started_at: 10,
            finished_at: None,
            error: None,
        }
    }

    #[test]
    fn automation_crud() {
        let db = ComboDb::in_memory();
        db.upsert_automation(&auto("a1", "w1", Some(100))).unwrap();
        db.upsert_automation(&auto("a2", "w1", Some(200))).unwrap();
        db.upsert_automation(&auto("a3", "w2", Some(150))).unwrap();

        assert_eq!(db.list_automations().unwrap().len(), 3);
        assert_eq!(db.list_automations_by_workspace("w1").unwrap().len(), 2);

        // 到期查询
        let due = db.list_due_automations(150).unwrap();
        assert!(due.iter().any(|a| a.id == "a1")); // 100 <= 150
        assert!(due.iter().any(|a| a.id == "a3")); // 150 <= 150
        assert!(!due.iter().any(|a| a.id == "a2")); // 200 > 150

        // 禁用后不再到期
        let mut a2 = auto("a2", "w1", Some(200));
        a2.enabled = false;
        db.upsert_automation(&a2).unwrap();
        let due = db.list_due_automations(999).unwrap();
        assert!(!due.iter().any(|a| a.id == "a2"));

        // next_run_at 为空(一次性已完成)→ 不再调度
        let a3 = auto("a3", "w2", None);
        db.upsert_automation(&a3).unwrap();
        let due = db.list_due_automations(999).unwrap();
        assert!(!due.iter().any(|a| a.id == "a3"));

        // 更新与获取
        let got = db.get_automation("a1").unwrap().unwrap();
        assert_eq!(got.name, "任务 a1");
        assert!(got.enabled);
        let mut a1 = got.clone();
        a1.name = "新名称".into();
        a1.enabled = false;
        db.upsert_automation(&a1).unwrap();
        assert_eq!(db.get_automation("a1").unwrap().unwrap().name, "新名称");
        assert!(!db.get_automation("a1").unwrap().unwrap().enabled);

        // 删除单个(级联运行记录)
        db.insert_automation_run(&run_rec("r1", "a1", "w1")).unwrap();
        db.delete_automation("a1").unwrap();
        assert!(db.get_automation("a1").unwrap().is_none());
        assert!(db.list_automation_runs("a1").unwrap().is_empty());
    }

    #[test]
    fn automation_runs_roundtrip_and_workspace_delete() {
        let db = ComboDb::in_memory();
        db.upsert_automation(&auto("a1", "w1", Some(100))).unwrap();
        db.insert_automation_run(&run_rec("r1", "a1", "w1")).unwrap();
        db.insert_automation_run(&run_rec("r2", "a1", "w1")).unwrap();

        assert_eq!(db.list_automation_runs("a1").unwrap().len(), 2);

        // 结束一条:更新状态/结束时间/错误
        assert!(db.update_automation_run("r1", "success", 20, None).unwrap());
        let runs = db.list_automation_runs("a1").unwrap();
        let r1 = runs.iter().find(|r| r.id == "r1").unwrap();
        assert_eq!(r1.status, "success");
        assert_eq!(r1.finished_at, Some(20));
        assert!(r1.error.is_none());

        // 不存在的记录返回 false
        assert!(!db.update_automation_run("nope", "success", 20, None).unwrap());

        // 删除 workspace 级联清理任务与运行记录
        db.delete_automations_by_workspace("w1").unwrap();
        assert!(db.list_automations_by_workspace("w1").unwrap().is_empty());
        assert!(db.list_automation_runs("a1").unwrap().is_empty());
    }
}
