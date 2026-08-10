//! combo-cli 的 sqlite 持久化:本地会话(conversations)与消息(messages)。
//! 沿用 serve 的存储约定(`COMBO_DATA_DIR` 或 `XDG_DATA_HOME/combo`),
//! 但表名加 `cli_` 前缀,与 serve 的 ComboDb 表隔离。

use rusqlite::{Connection, params};
use std::path::PathBuf;
use std::sync::Mutex;

/// 数据库路径:`COMBO_DATA_DIR` 或 `XDG_DATA_HOME/combo/combo-cli.db`。
pub fn default_db_path() -> PathBuf {
    if let Ok(dir) = std::env::var("COMBO_DATA_DIR") {
        return PathBuf::from(dir).join("combo-cli.db");
    }
    let base = std::env::var("XDG_DATA_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
            PathBuf::from(home).join(".local/share")
        });
    base.join("combo").join("combo-cli.db")
}

/// 会话元数据。
#[derive(Clone, Debug)]
pub struct CliConversation {
    pub id: String,
    pub title: String,
    pub provider: String,
    pub model: String,
    pub created_at: i64,
    pub updated_at: i64,
}

/// 一条消息。
#[derive(Clone, Debug)]
pub struct CliMessage {
    pub role: String,
    pub content: String,
    pub created_at: i64,
}

/// 线程安全的 sqlite 连接。
pub struct CliDb {
    conn: Mutex<Connection>,
}

#[allow(dead_code)]
impl CliDb {
    pub fn open(path: &PathBuf) -> anyhow::Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let conn = Connection::open(path)?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS cli_conversations (
                id         TEXT PRIMARY KEY,
                title      TEXT NOT NULL,
                provider   TEXT NOT NULL,
                model      TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS cli_messages (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                conversation_id TEXT NOT NULL,
                role          TEXT NOT NULL,
                content       TEXT NOT NULL,
                created_at    INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_cli_msg_conv ON cli_messages(conversation_id);",
        )?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    pub fn in_memory() -> Self {
        let conn = Connection::open_in_memory().expect("in-memory sqlite");
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS cli_conversations (
                id         TEXT PRIMARY KEY,
                title      TEXT NOT NULL,
                provider   TEXT NOT NULL,
                model      TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS cli_messages (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                conversation_id TEXT NOT NULL,
                role          TEXT NOT NULL,
                content       TEXT NOT NULL,
                created_at    INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_cli_msg_conv ON cli_messages(conversation_id);",
        )
        .expect("init in-memory sqlite");
        Self {
            conn: Mutex::new(conn),
        }
    }

    /// 创建会话,返回 id。
    pub fn create_conversation(
        &self,
        id: &str,
        title: &str,
        provider: &str,
        model: &str,
    ) -> anyhow::Result<()> {
        let now = chrono::Utc::now().timestamp();
        let conn = self.conn.lock().expect("db lock");
        conn.execute(
            "INSERT INTO cli_conversations (id, title, provider, model, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
            params![id, title, provider, model, now],
        )?;
        Ok(())
    }

    /// 追加一条消息并更新时间戳。
    pub fn append_message(
        &self,
        conversation_id: &str,
        role: &str,
        content: &str,
    ) -> anyhow::Result<()> {
        let now = chrono::Utc::now().timestamp();
        let conn = self.conn.lock().expect("db lock");
        conn.execute(
            "INSERT INTO cli_messages (conversation_id, role, content, created_at)
             VALUES (?1, ?2, ?3, ?4)",
            params![conversation_id, role, content, now],
        )?;
        conn.execute(
            "UPDATE cli_conversations SET updated_at = ?1 WHERE id = ?2",
            params![now, conversation_id],
        )?;
        Ok(())
    }

    /// 列出全部会话,按更新时间倒序。
    pub fn list_conversations(&self) -> anyhow::Result<Vec<CliConversation>> {
        let conn = self.conn.lock().expect("db lock");
        let mut stmt = conn.prepare(
            "SELECT id, title, provider, model, created_at, updated_at
             FROM cli_conversations ORDER BY updated_at DESC",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(CliConversation {
                id: r.get(0)?,
                title: r.get(1)?,
                provider: r.get(2)?,
                model: r.get(3)?,
                created_at: r.get(4)?,
                updated_at: r.get(5)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(Into::into)
    }

    /// 读取会话消息,按时间正序。
    pub fn messages(&self, conversation_id: &str) -> anyhow::Result<Vec<CliMessage>> {
        let conn = self.conn.lock().expect("db lock");
        let mut stmt = conn.prepare(
            "SELECT role, content, created_at FROM cli_messages
             WHERE conversation_id = ?1 ORDER BY created_at ASC, id ASC",
        )?;
        let rows = stmt.query_map(params![conversation_id], |r| {
            Ok(CliMessage {
                role: r.get(0)?,
                content: r.get(1)?,
                created_at: r.get(2)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(Into::into)
    }

    /// 删除会话及其消息。
    pub fn delete_conversation(&self, conversation_id: &str) -> anyhow::Result<()> {
        let conn = self.conn.lock().expect("db lock");
        conn.execute(
            "DELETE FROM cli_messages WHERE conversation_id = ?1",
            params![conversation_id],
        )?;
        conn.execute(
            "DELETE FROM cli_conversations WHERE id = ?1",
            params![conversation_id],
        )?;
        Ok(())
    }
}

/// 打开默认库的便捷函数。
pub fn open_default() -> anyhow::Result<CliDb> {
    CliDb::open(&default_db_path())
}

/// 打印会话列表(供 `sessions list` 使用)。
pub fn list_sessions() -> anyhow::Result<()> {
    let db = open_default()?;
    let convs = db.list_conversations()?;
    if convs.is_empty() {
        println!("暂无会话");
        return Ok(());
    }
    for c in convs {
        let time = chrono::DateTime::from_timestamp(c.updated_at, 0)
            .map(|t| t.format("%Y-%m-%d %H:%M").to_string())
            .unwrap_or_else(|| "-".into());
        println!("{}  {}  [{}]  {}", c.id, time, c.provider, c.title);
    }
    Ok(())
}

/// 打印会话消息(供 `sessions show` 使用)。
pub fn show_session(id: &str) -> anyhow::Result<()> {
    let db = open_default()?;
    let convs = db.list_conversations()?;
    if let Some(c) = convs.iter().find(|c| c.id == id) {
        let time = chrono::DateTime::from_timestamp(c.created_at, 0)
            .map(|t| t.format("%Y-%m-%d %H:%M").to_string())
            .unwrap_or_else(|| "-".into());
        println!("会话 {}\n提供商:{}  模型:{}\n创建时间:{}\n---", c.id, c.provider, c.model, time);
    }
    let msgs = db.messages(id)?;
    if msgs.is_empty() {
        println!("(无消息)");
        return Ok(());
    }
    for m in msgs {
        let who = if m.role == "user" { "用户" } else { "助手" };
        let time = chrono::DateTime::from_timestamp(m.created_at, 0)
            .map(|t| t.format("%H:%M").to_string())
            .unwrap_or_default();
        println!("[{who} {time}] {}", m.content);
        println!("---");
    }
    Ok(())
}

/// 删除会话(供 `sessions rm` 使用)。
pub fn rm_session(id: &str) -> anyhow::Result<()> {
    let db = open_default()?;
    db.delete_conversation(id)?;
    println!("已删除会话:{id}");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn conversation_crud() {
        let db = CliDb::in_memory();
        db.create_conversation("s1", "测试会话", "openai", "gpt-4o")
            .unwrap();
        db.append_message("s1", "user", "你好").unwrap();
        db.append_message("s1", "assistant", "嗨").unwrap();

        let convs = db.list_conversations().unwrap();
        assert_eq!(convs.len(), 1);
        assert_eq!(convs[0].title, "测试会话");
        assert_eq!(convs[0].provider, "openai");

        let msgs = db.messages("s1").unwrap();
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0].role, "user");
        assert_eq!(msgs[1].content, "嗨");

        db.delete_conversation("s1").unwrap();
        assert!(db.list_conversations().unwrap().is_empty());
        assert!(db.messages("s1").unwrap().is_empty());
    }

    #[test]
    fn unknown_session_is_empty() {
        let db = CliDb::in_memory();
        assert!(db.messages("nope").unwrap().is_empty());
    }
}
