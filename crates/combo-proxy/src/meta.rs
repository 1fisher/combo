//! combo 自有的 workspace 元数据存储。
//! 阶段 0 为内存缓存;后续阶段将拦截 workspace 创建来主动填充,
//! 使 combo 成为 workspace 元数据的唯一来源。

use crate::backend::BackendType;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

/// combo 拥有的 workspace 元数据。
#[derive(Clone, Debug)]
pub struct WorkspaceMeta {
    pub id: String,
    pub path: PathBuf,
    pub backend_type: BackendType,
}

/// 内存中的 workspace 元数据存储。
#[derive(Default)]
pub struct MetaStore {
    workspaces: Mutex<HashMap<String, WorkspaceMeta>>,
}

impl MetaStore {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn insert(&self, meta: WorkspaceMeta) {
        self.workspaces.lock().unwrap().insert(meta.id.clone(), meta);
    }

    pub fn get(&self, id: &str) -> Option<WorkspaceMeta> {
        self.workspaces.lock().unwrap().get(id).cloned()
    }

    pub fn remove(&self, id: &str) {
        self.workspaces.lock().unwrap().remove(id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn insert_and_get() {
        let store = MetaStore::new();
        store.insert(WorkspaceMeta {
            id: "w1".into(),
            path: "/tmp/ws1".into(),
            backend_type: BackendType::Crush,
        });
        let meta = store.get("w1").unwrap();
        assert_eq!(meta.id, "w1");
        assert_eq!(meta.path, PathBuf::from("/tmp/ws1"));
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
        store.insert(WorkspaceMeta {
            id: "w1".into(),
            path: "/tmp".into(),
            backend_type: BackendType::Crush,
        });
        store.remove("w1");
        assert!(store.get("w1").is_none());
    }
}
