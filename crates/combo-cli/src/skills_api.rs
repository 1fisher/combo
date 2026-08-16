//! 技能列表服务:扫描本地技能目录(项目 `.combo/skills`、项目 `.agents/skills`、
//! combo 专属 `~/.config/combo/skills`、通用 `~/.agents/skills`),
//! 读取每个技能子目录中的 `SKILL.md` frontmatter(name + description),
//! 返回 JSON 列表供前端展示与开关。
//!
//! 项目级目录优先按 **激活 workspace 的根目录** 解析(`?workspace_id=`),
//! 而不是 serve 进程的 CWD:桌面端/浏览器模式下 serve 常驻,进程 CWD 与
//! 用户打开的项目无关,按 CWD 扫描会漏掉项目 `.agents/skills` 里的技能。
//! 未传 `workspace_id` 时回退为旧行为(相对进程 CWD),兼容 CLI 模式。

use axum::body::Body;
use axum::extract::{Query, State};
use axum::http::{header, StatusCode};
use axum::response::Response;
use serde::Deserialize;
use serde_json::json;
use std::path::{Path, PathBuf};

use crate::serve::AppState;

#[derive(Deserialize)]
pub struct SkillsQuery {
    /// 激活的 workspace id;指定时项目级目录以该 workspace 根目录解析。
    pub workspace_id: Option<String>,
}

/// 技能扫描目录:项目 `.combo/skills` + 项目 `.agents/skills` + combo 专属 + 通用
/// `~/.agents/skills`。
/// 与 `skills::default_skills_paths` 的顺序一致(同名 skill 靠前的路径优先)。
fn skills_dirs(workspace_root: Option<&Path>) -> Vec<PathBuf> {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
    let mut dirs = Vec::new();
    match workspace_root {
        // 项目级目录按激活 workspace 根目录解析(桌面/浏览器模式)。
        Some(root) => {
            dirs.push(root.join(".combo").join("skills"));
            dirs.push(root.join(".agents").join("skills"));
        }
        // 未传 workspace_id:回退相对进程 CWD(CLI 模式在项目目录下运行)。
        None => {
            dirs.push(PathBuf::from("./.combo/skills"));
            dirs.push(PathBuf::from("./.agents/skills"));
        }
    }
    // combo 专属目录(支持 COMBO_SKILLS_DIR 覆盖;默认随统一配置目录
    // `~/.config/combo/skills`,COMBO_CONFIG_DIR 同样生效)
    if let Ok(dir) = std::env::var("COMBO_SKILLS_DIR") {
        dirs.push(PathBuf::from(dir));
    } else {
        dirs.push(crate::paths::default_config_dir().join("skills"));
    }
    // 通用技能目录(所有 agent 共享)
    dirs.push(PathBuf::from(&home).join(".agents").join("skills"));
    dirs
}

/// 从 `SKILL.md` 内容中解析 YAML frontmatter 的 `name` 和 `description`。
fn parse_frontmatter(content: &str) -> (Option<String>, Option<String>) {
    let trimmed = content.trim_start();
    let Some(rest) = trimmed.strip_prefix("---\n").or_else(|| trimmed.strip_prefix("---\r\n"))
    else {
        return (None, None);
    };
    let end = rest
        .find("\n---")
        .or_else(|| rest.find("\r\n---"))
        .unwrap_or(rest.len());
    let frontmatter = &rest[..end];

    let mut name = None;
    let mut description = None;
    for line in frontmatter.lines() {
        if let Some(v) = line.strip_prefix("name:") {
            name = Some(v.trim().trim_matches('"').trim_matches('\'').to_string());
        } else if let Some(v) = line.strip_prefix("description:") {
            description = Some(
                v.trim()
                    .trim_matches('"')
                    .trim_matches('\'')
                    .to_string(),
            );
        }
    }
    (name, description)
}

fn json_response(status: StatusCode, value: serde_json::Value) -> Response {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(value.to_string()))
        .unwrap()
}

fn ok_json(value: serde_json::Value) -> Response {
    json_response(StatusCode::OK, value)
}

/// GET /v1/skills?workspace_id=<id>
/// 返回本地已安装的技能列表(合并所有扫描目录,同名 skill 靠前的目录优先)。
/// 传 `workspace_id` 时项目级技能按该 workspace 根目录扫描,保证桌面端
/// composer 的 `$` 技能候选能命中项目 `.agents/skills` 下的技能。
pub async fn list(
    State(state): State<AppState>,
    Query(query): Query<SkillsQuery>,
) -> Response {
    // 解析激活 workspace 的根目录(sqlite 元数据),取不到则回退 CWD 行为。
    let workspace_root = query
        .workspace_id
        .as_deref()
        .and_then(|id| state.meta.get(id))
        .map(|m| m.path);

    let mut skills = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for dir in skills_dirs(workspace_root.as_deref()) {
        let Ok(rd) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in rd.flatten() {
            let ft = match entry.file_type() {
                Ok(ft) => ft,
                Err(_) => continue,
            };
            // 技能是子目录(含符号链接到实际技能仓库)
            if !ft.is_dir() && !ft.is_symlink() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') {
                continue;
            }
            let skill_md = entry.path().join("SKILL.md");
            let (skill_name, description) = match std::fs::read_to_string(&skill_md) {
                Ok(content) => {
                    let (n, d) = parse_frontmatter(&content);
                    (n.unwrap_or_else(|| name.clone()), d)
                }
                Err(_) => (name.clone(), None),
            };
            if !seen.insert(skill_name.clone()) {
                continue;
            }
            skills.push(json!({
                "name": skill_name,
                "dir_name": name,
                "description": description.unwrap_or_default(),
                "path": entry.path().to_string_lossy(),
            }));
        }
    }

    skills.sort_by(|a, b| {
        a["name"]
            .as_str()
            .unwrap_or("")
            .cmp(b["name"].as_str().unwrap_or(""))
    });
    ok_json(json!(skills))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn write_skill(root: &Path, name: &str, frontmatter_name: &str) {
        let dir = root.join(name);
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("SKILL.md"),
            format!("---\nname: {frontmatter_name}\ndescription: test skill\n---\n"),
        )
        .unwrap();
    }

    #[test]
    fn dirs_prepend_workspace_root_when_given() {
        let root = TempDir::new().unwrap();
        let dirs = skills_dirs(Some(root.path()));
        // 前两项必须是 workspace 根目录下的项目级目录
        assert_eq!(
            dirs[0],
            root.path().join(".combo").join("skills")
        );
        assert_eq!(
            dirs[1],
            root.path().join(".agents").join("skills")
        );
        // 项目级目录用绝对路径,不再依赖进程 CWD
        assert!(dirs[0].is_absolute());
    }

    #[test]
    fn dirs_fallback_to_cwd_relative_without_workspace() {
        let dirs = skills_dirs(None);
        assert_eq!(dirs[0], PathBuf::from("./.combo/skills"));
        assert_eq!(dirs[1], PathBuf::from("./.agents/skills"));
    }

    #[test]
    fn workspace_scan_finds_project_skills() {
        // 模拟一个项目的 .agents/skills,扫描顺序保证项目级技能出现在结果里
        let root = TempDir::new().unwrap();
        let agents = root.path().join(".agents").join("skills");
        write_skill(&agents, "odoo-19", "odoo-19");
        write_skill(&agents, "robot-framework", "robot-framework");

        // 直接走内部目录构建(不依赖网络/state),验证目录可读
        let dirs = skills_dirs(Some(root.path()));
        let mut found = Vec::new();
        for dir in dirs {
            let Ok(rd) = std::fs::read_dir(&dir) else {
                continue;
            };
            for entry in rd.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                if name.starts_with('.') {
                    continue;
                }
                if entry.path().join("SKILL.md").exists() {
                    found.push(name);
                }
            }
        }
        assert!(found.contains(&"odoo-19".to_string()));
    }
}
