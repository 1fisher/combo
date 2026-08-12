//! 加载项目目录下的 `AGENTS.md` 作为项目级基础规则,注入到 agent preamble。
//!
//! 约定:在项目/工作区根目录查找 `AGENTS.md`(大小写不敏感,`AGENTS.md` 优先)。
//! 找到则把正文(去掉 YAML frontmatter)包装成 preamble 段落返回;找不到则提示
//! 需要初始化项目(创建 `AGENTS.md`)。

use std::path::{Path, PathBuf};

/// 在目录下查找 `AGENTS.md`(优先大写,回退大小写不敏感扫描)。
pub fn find_agents_md(dir: &Path) -> Option<PathBuf> {
    let upper = dir.join("AGENTS.md");
    if upper.is_file() {
        return Some(upper);
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return None;
    };
    for entry in entries.flatten() {
        if entry.file_name().eq_ignore_ascii_case("agents.md") && entry.path().is_file() {
            return Some(entry.path());
        }
    }
    None
}

/// 读取 `AGENTS.md` 正文(去掉 YAML frontmatter)。文件缺失或为空返回 None。
fn read_agents_md(dir: &Path) -> Option<String> {
    let path = find_agents_md(dir)?;
    let text = std::fs::read_to_string(&path).ok()?;
    let body = strip_frontmatter(&text).trim().to_string();
    if body.is_empty() {
        None
    } else {
        Some(body)
    }
}

/// 生成注入 preamble 的 AGENTS.md 段落。
///
/// - `dir` 为 None:无项目上下文,返回空串(不提示)。
/// - `dir` 为 Some 但缺 `AGENTS.md`:提示需要初始化项目,返回空串。
/// - 找到:返回 `\n\n项目规则(AGENTS.md):\n<正文>\n`。
///
/// 「缺失」提示按目录去重(serve 每条消息都会重建 preamble,避免刷屏)。
pub fn load_preamble(dir: Option<&Path>) -> String {
    let Some(dir) = dir else {
        return String::new();
    };
    match read_agents_md(dir) {
        Some(body) => format!("\n\n项目规则(AGENTS.md):\n{body}\n"),
        None => {
            warn_missing_once(dir);
            String::new()
        }
    }
}

/// 每个目录只提示一次「缺失 AGENTS.md」。
fn warn_missing_once(dir: &Path) {
    use std::collections::HashSet;
    use std::sync::Mutex;
    static WARNED: std::sync::OnceLock<Mutex<HashSet<PathBuf>>> = std::sync::OnceLock::new();
    let set = WARNED.get_or_init(|| Mutex::new(HashSet::new()));
    let mut guard = match set.lock() {
        Ok(g) => g,
        Err(_) => return,
    };
    let canon = std::fs::canonicalize(dir).unwrap_or_else(|_| dir.to_path_buf());
    if guard.insert(canon) {
        tracing::warn!(
            "项目目录 {} 未发现 AGENTS.md,建议初始化项目(创建 AGENTS.md)以启用项目级规则",
            dir.display()
        );
    }
}

/// 同 [`load_preamble`],但不产生「缺失」提示;供需要静默加载的场景使用。
pub fn load_preamble_silent(dir: Option<&Path>) -> String {
    let Some(dir) = dir else {
        return String::new();
    };
    match read_agents_md(dir) {
        Some(body) => format!("\n\n项目规则(AGENTS.md):\n{body}\n"),
        None => String::new(),
    }
}

/// 去掉 `---` 包裹的 YAML frontmatter(若有)。
fn strip_frontmatter(text: &str) -> &str {
    let trimmed = text.trim_start_matches('\u{feff}').trim_start();
    let Some(rest) = trimmed.strip_prefix("---") else {
        return text;
    };
    let Some(end) = rest.find("\n---") else {
        return text;
    };
    let after = &rest[end + "\n---".len()..];
    after.trim_start_matches(['\r', '\n'])
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn finds_uppercase_agents_md() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("AGENTS.md"), "# 规则\n正文").unwrap();
        let found = find_agents_md(dir.path()).unwrap();
        assert_eq!(found.file_name().unwrap(), "AGENTS.md");
    }

    #[test]
    fn finds_lowercase_agents_md_case_insensitive() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("agents.md"), "# 规则\n正文").unwrap();
        assert!(find_agents_md(dir.path()).is_some());
    }

    #[test]
    fn missing_returns_none() {
        let dir = tempfile::tempdir().unwrap();
        assert!(find_agents_md(dir.path()).is_none());
    }

    #[test]
    fn load_preamble_reads_body() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("AGENTS.md"), "# 项目规则\n\n保持中文回复。").unwrap();
        let p = load_preamble_silent(Some(dir.path()));
        assert!(p.contains("项目规则(AGENTS.md)"));
        assert!(p.contains("保持中文回复。"));
    }

    #[test]
    fn load_preamble_strips_frontmatter() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(
            dir.path().join("AGENTS.md"),
            "---\nname: demo\ndescription: 测试\n---\n# 规则\n\n真实正文",
        )
        .unwrap();
        let p = load_preamble_silent(Some(dir.path()));
        assert!(!p.contains("name: demo"));
        assert!(p.contains("真实正文"));
    }

    #[test]
    fn load_preamble_none_dir_is_empty() {
        assert!(load_preamble_silent(None).is_empty());
    }

    #[test]
    fn load_preamble_empty_body_is_empty() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("AGENTS.md"), "   \n\n  ").unwrap();
        assert!(load_preamble_silent(Some(dir.path())).is_empty());
    }

    #[test]
    fn strip_frontmatter_no_frontmatter_unchanged() {
        assert_eq!(strip_frontmatter("# 标题\n正文"), "# 标题\n正文");
    }
}
