//! 技能列表服务:扫描本地 `~/.config/crush/skills/` 目录,
//! 读取每个技能子目录中的 `SKILL.md` frontmatter(name + description),
//! 返回 JSON 列表供前端展示与开关。

use axum::body::Body;
use axum::http::{header, StatusCode};
use axum::response::Response;
use serde_json::json;
use std::path::PathBuf;
/// crush 技能目录:`~/.config/crush/skills/`
fn skills_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("CRUSH_SKILLS_DIR") {
        return PathBuf::from(dir);
    }
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
    let config_base = std::env::var("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from(&home).join(".config"));
    config_base.join("crush").join("skills")
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

/// GET /v1/skills
/// 返回本地已安装的技能列表。
pub async fn list() -> Response {
    let dir = skills_dir();
    let rd = match std::fs::read_dir(&dir) {
        Ok(rd) => rd,
        Err(_) => return ok_json(json!([])),
    };

    let mut skills = Vec::new();
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
        skills.push(json!({
            "name": skill_name,
            "dir_name": name,
            "description": description.unwrap_or_default(),
            "path": entry.path().to_string_lossy(),
        }));
    }

    skills.sort_by(|a, b| {
        a["name"]
            .as_str()
            .unwrap_or("")
            .cmp(b["name"].as_str().unwrap_or(""))
    });
    ok_json(json!(skills))
}
