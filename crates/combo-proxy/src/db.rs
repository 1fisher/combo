//! combo 自有的 sqlite 持久化存储。
//! workspaces:项目元数据(含可重命名的项目名),替代阶段 0 的内存缓存;
//! conversations:rune session 的本地镜像,创建/删除时双写,列表直接从
//! sqlite 读取,不依赖 rune 在线。

use crate::backend::BackendType;
use crate::meta::WorkspaceMeta;
use rusqlite::{params, Connection};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// 默认数据库路径:`COMBO_DATA_DIR` 或 `XDG_DATA_HOME/combo/combo.db`。
pub fn default_db_path() -> PathBuf {
    if let Ok(dir) = std::env::var("COMBO_DATA_DIR") {
        return PathBuf::from(dir).join("combo.db");
    }
    let base = std::env::var("XDG_DATA_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
            PathBuf::from(home).join(".local/share")
        });
    base.join("combo").join("combo.db")
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
}

/// 线程安全的 sqlite 连接。所有方法都是短事务,持锁时间可忽略。
pub struct ComboDb {
    conn: Mutex<Connection>,
}

impl ComboDb {
    /// 打开(必要时创建)数据库文件。
    pub fn open(path: &Path) -> anyhow::Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let conn = Connection::open(path)?;
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
                updated_at    INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_conv_ws ON conversations(workspace_id);",
        )?;
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

    // ---------- conversations ----------

    pub fn upsert_conversation(&self, c: &ConversationMeta) -> anyhow::Result<()> {
        self.conn
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO conversations (id, workspace_id, title, message_count, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)
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
                    c.updated_at
                ],
            )?;
        Ok(())
    }

    pub fn list_conversations(&self, workspace_id: &str) -> anyhow::Result<Vec<ConversationMeta>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, workspace_id, title, message_count, created_at, updated_at
             FROM conversations WHERE workspace_id=?1 ORDER BY updated_at DESC",
        )?;
        let rows = stmt.query_map(params![workspace_id], |r| {
            Ok(ConversationMeta {
                id: r.get(0)?,
                workspace_id: r.get(1)?,
                title: r.get(2)?,
                message_count: r.get(3)?,
                created_at: r.get(4)?,
                updated_at: r.get(5)?,
            })
        })?;
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

    /// workspace 重建后 id 变化时,把旧 id 下的会话镜像迁移到新 id。
    pub fn move_conversations(&self, from_ws: &str, to_ws: &str) -> anyhow::Result<()> {
        self.conn.lock().unwrap().execute(
            "UPDATE conversations SET workspace_id=?1 WHERE workspace_id=?2",
            params![to_ws, from_ws],
        )?;
        Ok(())
    }
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
            backend_type: BackendType::Crush,
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
}
