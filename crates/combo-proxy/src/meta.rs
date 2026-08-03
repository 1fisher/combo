//! combo 自有的 workspace 元数据存储(sqlite 落盘)。
//! 项目名可重命名,跨重启保留;conversations 镜像见 `db.rs`。

use crate::backend::BackendType;
use crate::db::{default_db_path, ComboDb};
use std::path::{Path, PathBuf};

/// combo 拥有的 workspace 元数据。
#[derive(Clone, Debug)]
pub struct WorkspaceMeta {
    pub id: String,
    pub path: PathBuf,
    pub name: String,
    pub backend_type: BackendType,
}

/// sqlite-backed 的 workspace 元数据存储。
pub struct MetaStore {
    db: ComboDb,
}

impl MetaStore {
    /// 内存库(测试用)。
    pub fn new() -> Self {
        Self {
            db: ComboDb::in_memory(),
        }
    }

    /// 打开(必要时创建)默认数据库文件。
    pub fn open_default() -> anyhow::Result<Self> {
        Self::open(&default_db_path())
    }

    /// 打开指定路径的数据库。
    pub fn open(path: &Path) -> anyhow::Result<Self> {
        Ok(Self {
            db: ComboDb::open(path)?,
        })
    }

    /// 暴露底层 sqlite,供 session 镜像读写 conversations。
    pub fn db(&self) -> &ComboDb {
        &self.db
    }

    pub fn insert(&self, meta: WorkspaceMeta) {
        let _ = self.db.upsert_workspace(&meta);
    }

    pub fn get(&self, id: &str) -> Option<WorkspaceMeta> {
        self.db.get_workspace(id).ok().flatten()
    }

    pub fn remove(&self, id: &str) {
        let _ = self.db.delete_workspace(id);
    }

    pub fn list(&self) -> Vec<WorkspaceMeta> {
        self.db.list_workspaces().unwrap_or_default()
    }

    /// 重命名项目,返回是否找到。
    pub fn rename(&self, id: &str, name: &str) -> anyhow::Result<bool> {
        let before = self.db.get_workspace(id)?;
        if before.is_none() {
            return Ok(false);
        }
        self.db.rename_workspace(id, name)?;
        Ok(true)
    }
}

impl Default for MetaStore {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ws(id: &str) -> WorkspaceMeta {
        WorkspaceMeta {
            id: id.into(),
            path: PathBuf::from(format!("/tmp/{id}")),
            name: format!("项目 {id}"),
            backend_type: BackendType::Crush,
        }
    }

    #[test]
    fn insert_and_get() {
        let store = MetaStore::new();
        store.insert(ws("w1"));
        let meta = store.get("w1").unwrap();
        assert_eq!(meta.id, "w1");
        assert_eq!(meta.path, PathBuf::from("/tmp/w1"));
        assert_eq!(meta.name, "项目 w1");
        assert_eq!(meta.backend_type, BackendType::Crush);
    }

    #[test]
    fn get_missing_returns_none() {
        let store = MetaStore::new();
        assert!(store.get("nope").is_none());
    }

    #[test]
    fn remove_deletes_entry() {
        let store = MetaStore::new();
        store.insert(ws("w1"));
        store.remove("w1");
        assert!(store.get("w1").is_none());
    }

    #[test]
    fn rename_updates_name() {
        let store = MetaStore::new();
        store.insert(ws("w1"));
        assert!(store.rename("w1", "新名字").unwrap());
        assert_eq!(store.get("w1").unwrap().name, "新名字");
        assert!(!store.rename("missing", "x").unwrap());
    }
}
