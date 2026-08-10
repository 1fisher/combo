//! 多后端注册表:按 workspace 元数据中的 backend_type 选择后端。

use crate::backend::{Backend, BackendType};
use crate::meta::MetaStore;
use std::sync::Arc;

/// 持有所有可用后端,按 workspace 查 MetaStore 决定使用哪个。
pub struct BackendRegistry {
    /// combo-cli serve(自有 agent,默认)。
    combo_cli: Option<Arc<dyn Backend>>,
    opencode: Option<Arc<dyn Backend>>,
    claude_code: Option<Arc<dyn Backend>>,
    codex: Option<Arc<dyn Backend>>,
}

impl BackendRegistry {
    pub fn new() -> Self {
        Self {
            combo_cli: None,
            opencode: None,
            claude_code: None,
            codex: None,
        }
    }

    pub fn set_combo_cli(&mut self, backend: Arc<dyn Backend>) {
        self.combo_cli = Some(backend);
    }

    pub fn set_opencode(&mut self, backend: Arc<dyn Backend>) {
        self.opencode = Some(backend);
    }

    pub fn set_claude_code(&mut self, backend: Arc<dyn Backend>) {
        self.claude_code = Some(backend);
    }

    pub fn set_codex(&mut self, backend: Arc<dyn Backend>) {
        self.codex = Some(backend);
    }

    /// 按 backend_type 直接获取。
    pub fn by_type(&self, bt: BackendType) -> Option<&Arc<dyn Backend>> {
        match bt {
            BackendType::ComboCli => self.combo_cli.as_ref(),
            BackendType::OpenCode => self.opencode.as_ref(),
            BackendType::ClaudeCode => self.claude_code.as_ref(),
            BackendType::Codex => self.codex.as_ref(),
        }
    }

    /// 按 workspace_id 查 MetaStore 确定后端类型,再路由到对应后端。
    /// 未知 workspace 或后端未注册时回退到 combo-cli(默认 agent)。
    /// combo-cli 也未注册时返回 None(调用方应处理此情况)。
    pub fn for_workspace(&self, ws_id: &str, meta: &MetaStore) -> Option<&Arc<dyn Backend>> {
        let bt = meta.get(ws_id).map(|m| m.backend_type);
        match bt {
            Some(BackendType::OpenCode) if self.opencode.is_some() => self.opencode.as_ref(),
            Some(BackendType::ClaudeCode) if self.claude_code.is_some() => self.claude_code.as_ref(),
            Some(BackendType::Codex) if self.codex.is_some() => self.codex.as_ref(),
            _ => self.combo_cli.as_ref(),
        }
    }
}

impl Default for BackendRegistry {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ComboCliBackend;
    use crate::Upstream;

    fn dummy_cli() -> Arc<dyn Backend> {
        Arc::new(ComboCliBackend::new(Upstream::Tcp(
            "127.0.0.1:1".parse().unwrap(),
        )))
    }

    #[test]
    fn defaults_to_combo_cli_for_unknown_workspace() {
        let mut reg = BackendRegistry::new();
        reg.set_combo_cli(dummy_cli());
        let meta = MetaStore::new();
        let backend = reg.for_workspace("unknown", &meta).unwrap();
        assert_eq!(backend.backend_type(), BackendType::ComboCli);
    }

    #[test]
    fn routes_by_workspace_backend_type() {
        let mut reg = BackendRegistry::new();
        reg.set_combo_cli(dummy_cli());
        let meta = MetaStore::new();
        meta.insert(crate::WorkspaceMeta {
            id: "ws1".into(),
            path: "/tmp".into(),
            name: "ws1".into(),
            backend_type: BackendType::ComboCli,
        });
        meta.insert(crate::WorkspaceMeta {
            id: "ws2".into(),
            path: "/tmp".into(),
            name: "ws2".into(),
            backend_type: BackendType::ClaudeCode,
        });
        assert_eq!(
            reg.for_workspace("ws1", &meta).unwrap().backend_type(),
            BackendType::ComboCli
        );
        // claude_code not registered → falls back to combo-cli
        assert_eq!(
            reg.for_workspace("ws2", &meta).unwrap().backend_type(),
            BackendType::ComboCli
        );
    }

    #[test]
    fn returns_none_when_no_backend_registered() {
        let reg = BackendRegistry::new();
        let meta = MetaStore::new();
        assert!(reg.for_workspace("ws", &meta).is_none());
    }
}
