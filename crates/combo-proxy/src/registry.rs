//! 多后端注册表:按 workspace 元数据中的 backend_type 选择后端。

use crate::backend::{Backend, BackendType};
use crate::meta::MetaStore;
use std::sync::Arc;

/// 持有所有可用后端,按 workspace 查 MetaStore 决定使用哪个。
pub struct BackendRegistry {
    /// combo-cli serve(自有 agent,默认)。
    combo_cli: Option<Arc<dyn Backend>>,
    crush: Arc<dyn Backend>,
    opencode: Option<Arc<dyn Backend>>,
    claude_code: Option<Arc<dyn Backend>>,
    codex: Option<Arc<dyn Backend>>,
}

impl BackendRegistry {
    pub fn new(crush: Arc<dyn Backend>) -> Self {
        Self {
            combo_cli: None,
            crush,
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
            BackendType::Crush => Some(&self.crush),
            BackendType::OpenCode => self.opencode.as_ref(),
            BackendType::ClaudeCode => self.claude_code.as_ref(),
            BackendType::Codex => self.codex.as_ref(),
        }
    }

    /// 按 workspace_id 查 MetaStore 确定后端。
    /// 当前只支持 combo-cli(自有 agent);其他后端类型一律回退到 combo-cli。
    pub fn for_workspace(&self, _ws_id: &str, _meta: &MetaStore) -> &Arc<dyn Backend> {
        self.combo_cli.as_ref().unwrap_or(&self.crush)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{ComboCliBackend, CrushBackend, Upstream};

    fn dummy_crush() -> Arc<dyn Backend> {
        Arc::new(CrushBackend::new(Upstream::Tcp(
            "127.0.0.1:1".parse().unwrap(),
        )))
    }

    #[test]
    fn defaults_to_combo_cli_for_unknown_workspace() {
        let mut reg = BackendRegistry::new(dummy_crush());
        reg.set_combo_cli(Arc::new(ComboCliBackend::new(Upstream::Tcp(
            "127.0.0.1:1".parse().unwrap(),
        ))));
        let meta = MetaStore::new();
        let backend = reg.for_workspace("unknown", &meta);
        assert_eq!(backend.backend_type(), BackendType::ComboCli);
    }

    #[test]
    fn always_routes_to_combo_cli_regardless_of_backend_type() {
        let mut reg = BackendRegistry::new(dummy_crush());
        reg.set_combo_cli(Arc::new(ComboCliBackend::new(Upstream::Tcp(
            "127.0.0.1:1".parse().unwrap(),
        ))));
        let meta = MetaStore::new();
        meta.insert(crate::WorkspaceMeta {
            id: "ws1".into(),
            path: "/tmp".into(),
            name: "ws1".into(),
            backend_type: BackendType::Crush,
        });
        meta.insert(crate::WorkspaceMeta {
            id: "ws2".into(),
            path: "/tmp".into(),
            name: "ws2".into(),
            backend_type: BackendType::ClaudeCode,
        });
        assert_eq!(
            reg.for_workspace("ws1", &meta).backend_type(),
            BackendType::ComboCli
        );
        assert_eq!(
            reg.for_workspace("ws2", &meta).backend_type(),
            BackendType::ComboCli
        );
    }

    #[test]
    fn falls_back_to_crush_when_combo_cli_not_set() {
        let reg = BackendRegistry::new(dummy_crush());
        let meta = MetaStore::new();
        meta.insert(crate::WorkspaceMeta {
            id: "ws4".into(),
            path: "/tmp".into(),
            name: "ws4".into(),
            backend_type: BackendType::ComboCli,
        });
        let backend = reg.for_workspace("ws4", &meta);
        assert_eq!(backend.backend_type(), BackendType::Crush);
    }
}
