//! 多后端注册表:按 workspace 元数据中的 backend_type 选择后端。

use crate::backend::{Backend, BackendType};
use crate::meta::MetaStore;
use std::sync::Arc;

/// 持有所有可用后端,按 workspace 查 MetaStore 决定使用哪个。
pub struct BackendRegistry {
    crush: Arc<dyn Backend>,
    opencode: Option<Arc<dyn Backend>>,
}

impl BackendRegistry {
    pub fn new(crush: Arc<dyn Backend>) -> Self {
        Self {
            crush,
            opencode: None,
        }
    }

    pub fn set_opencode(&mut self, backend: Arc<dyn Backend>) {
        self.opencode = Some(backend);
    }

    /// 按 backend_type 直接获取。
    pub fn by_type(&self, bt: BackendType) -> Option<&Arc<dyn Backend>> {
        match bt {
            BackendType::Crush => Some(&self.crush),
            BackendType::OpenCode => self.opencode.as_ref(),
        }
    }

    /// 按 workspace_id 查 MetaStore 确定后端。找不到时默认 crush。
    pub fn for_workspace(&self, ws_id: &str, meta: &MetaStore) -> &Arc<dyn Backend> {
        match meta.get(ws_id) {
            Some(m) => match m.backend_type {
                BackendType::OpenCode => self.opencode.as_ref().unwrap_or(&self.crush),
                BackendType::Crush => &self.crush,
            },
            None => &self.crush,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{CrushBackend, Upstream};

    fn dummy_crush() -> Arc<dyn Backend> {
        Arc::new(CrushBackend::new(Upstream::Tcp(
            "127.0.0.1:1".parse().unwrap(),
        )))
    }

    #[test]
    fn defaults_to_crush_for_unknown_workspace() {
        let reg = BackendRegistry::new(dummy_crush());
        let meta = MetaStore::new();
        let backend = reg.for_workspace("unknown", &meta);
        assert_eq!(backend.backend_type(), BackendType::Crush);
    }

    #[test]
    fn routes_crush_workspace_to_crush() {
        let reg = BackendRegistry::new(dummy_crush());
        let meta = MetaStore::new();
        meta.insert(crate::WorkspaceMeta {
            id: "ws1".into(),
            path: "/tmp".into(),
            backend_type: BackendType::Crush,
        });
        let backend = reg.for_workspace("ws1", &meta);
        assert_eq!(backend.backend_type(), BackendType::Crush);
    }

    #[test]
    fn opencode_workspace_falls_back_to_crush_when_not_set() {
        let reg = BackendRegistry::new(dummy_crush());
        let meta = MetaStore::new();
        meta.insert(crate::WorkspaceMeta {
            id: "ws3".into(),
            path: "/tmp".into(),
            backend_type: BackendType::OpenCode,
        });
        let backend = reg.for_workspace("ws3", &meta);
        assert_eq!(backend.backend_type(), BackendType::Crush);
    }
}
