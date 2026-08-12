//! skills 支持:扫描配置的 skills 目录,解析 SKILL.md 的 frontmatter,
//! 把可用 skill 注入到 agent 的 preamble,并提供 `skills list` 子命令。
//!
//! 目录约定:每个 skill 一个目录,内含 `SKILL.md`,
//! frontmatter 含 `name`/`description`。

use crate::config::ResolvedConfig;
use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// 一个已发现的 skill。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Skill {
    pub name: String,
    pub description: String,
    pub path: PathBuf,
}

/// 解析 SKILL.md 的 frontmatter(name/description)。
#[derive(Debug, Default, Deserialize)]
struct Frontmatter {
    #[allow(dead_code)]
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[allow(dead_code)]
    #[serde(default)]
    hidden: Option<bool>,
}

/// 默认 skills 搜索路径:combo 专属目录 > 项目 `.combo/skills` > 通用 `~/.agents/skills`。
/// 同名 skill 靠前的路径优先。
pub fn default_skills_paths() -> Vec<String> {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
    vec![
        format!("{home}/.config/combo/skills"),
        "./.combo/skills".to_string(),
        format!("{home}/.agents/skills"),
    ]
}

/// 展开 `~` 前缀。
fn expand_home(p: &str) -> PathBuf {
    if let Some(rest) = p.strip_prefix("~/") {
        let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
        PathBuf::from(home).join(rest)
    } else {
        PathBuf::from(p)
    }
}

/// 扫描配置的 skills 路径,返回按名称去重后的 skill 列表。
pub fn discover(cfg: &ResolvedConfig) -> Result<Vec<Skill>> {
    discover_with(&cfg.skills_paths, &cfg.disabled_skills)
}

/// 用显式路径与禁用列表扫描(供运行时按 workspace 过滤后重建)。
pub fn discover_with(skills_paths: &[String], disabled_skills: &[String]) -> Result<Vec<Skill>> {
    let paths: Vec<PathBuf> = if skills_paths.is_empty() {
        default_skills_paths().iter().map(|s| expand_home(s)).collect()
    } else {
        skills_paths.iter().map(|s| expand_home(s)).collect()
    };
    let disabled: Vec<&str> = disabled_skills.iter().map(|s| s.as_str()).collect();

    let mut found: Vec<Skill> = Vec::new();
    for dir in &paths {
        let Ok(entries) = std::fs::read_dir(dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let skill_md = path.join("SKILL.md");
            if !skill_md.exists() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            if disabled.contains(&name.as_str()) {
                continue;
            }
            let description = parse_skill_md(&skill_md)?.unwrap_or_default();
            found.push(Skill {
                name,
                description,
                path,
            });
        }
    }
    // 按名称去重(靠前的路径优先)
    let mut seen = std::collections::HashSet::new();
    found.retain(|s| seen.insert(s.name.clone()));
    found.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(found)
}

/// 解析 SKILL.md,返回 description(frontmatter 缺失则用首段)。
fn parse_skill_md(path: &Path) -> Result<Option<String>> {
    let text = std::fs::read_to_string(path)?;
    if let Some(fm) = extract_frontmatter(&text) {
        if let Ok(f) = serde_yaml::from_str::<Frontmatter>(fm) {
            return Ok(f.description);
        }
    }
    Ok(None)
}

/// 提取 `---` 包裹的 frontmatter。
fn extract_frontmatter(text: &str) -> Option<&str> {
    let trimmed = text.trim_start();
    let rest = trimmed.strip_prefix("---")?;
    let end = rest.find("\n---")?;
    Some(&rest[..end])
}

/// 生成注入 preamble 的 skills 摘要文本。
pub fn skills_preamble(cfg: &ResolvedConfig) -> String {
    skills_preamble_with(&cfg.skills_paths, &cfg.disabled_skills)
}

/// 按显式路径与禁用列表生成 skills 摘要(供运行时按 workspace 过滤)。
pub fn skills_preamble_with(skills_paths: &[String], disabled_skills: &[String]) -> String {
    let Ok(skills) = discover_with(skills_paths, disabled_skills) else {
        return String::new();
    };
    if skills.is_empty() {
        return String::new();
    }
    let mut out = String::from("\n\n可用 skills(按需在回答中提及即可):\n");
    for s in &skills {
        let desc = s.description.trim();
        if desc.is_empty() {
            out.push_str(&format!("- {}\n", s.name));
        } else {
            let first_line = desc.lines().next().unwrap_or("").trim();
            out.push_str(&format!("- {}:{}\n", s.name, first_line));
        }
    }
    out
}

/// 打印 skill 列表(供 `skills list` 使用)。
pub fn list(cfg: &ResolvedConfig) -> Result<()> {
    let skills = discover(cfg)?;
    if skills.is_empty() {
        println!("未发现 skills(可配置 skills_paths)");
        return Ok(());
    }
    println!("共 {} 个 skills:", skills.len());
    for s in &skills {
        let desc = s.description.trim().replace('\n', " ");
        let desc = if desc.len() > 100 {
            format!("{}…", &desc[..100])
        } else {
            desc
        };
        println!("  {}  {}", s.name, desc);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_frontmatter_description() {
        let md = "---\nname: foo\ndescription: 做某事的 skill\n---\n\n# Foo\n正文";
        let fm = extract_frontmatter(md).unwrap();
        let f: Frontmatter = serde_yaml::from_str(fm).unwrap();
        assert_eq!(f.name.as_deref(), Some("foo"));
        assert_eq!(f.description.as_deref(), Some("做某事的 skill"));
    }

    #[test]
    fn default_paths_include_all_dirs() {
        let paths = default_skills_paths();
        assert_eq!(paths.len(), 3);
        assert!(paths[0].ends_with(".config/combo/skills"));
        assert!(paths[1].ends_with(".combo/skills"));
        assert!(paths[2].ends_with(".agents/skills"));
    }

    #[test]
    fn discover_with_filters_disabled() {
        let dir = tempfile::tempdir().unwrap();
        for name in ["skill-a", "skill-b"] {
            std::fs::create_dir_all(dir.path().join(name)).unwrap();
            std::fs::write(
                dir.path().join(format!("{name}/SKILL.md")),
                format!("---\nname: {name}\ndescription: {name}\n---\n# {name}"),
            )
            .unwrap();
        }
        let paths = vec![dir.path().to_string_lossy().to_string()];
        let skills = discover_with(&paths, &["skill-a".into()]).unwrap();
        assert_eq!(skills.len(), 1);
        assert_eq!(skills[0].name, "skill-b");
    }

    #[test]
    fn discover_scans_skill_dirs() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("skill-a")).unwrap();
        std::fs::create_dir_all(dir.path().join("skill-b")).unwrap();
        std::fs::write(
            dir.path().join("skill-a/SKILL.md"),
            "---\nname: skill-a\ndescription: Skill A\n---\n# A",
        )
        .unwrap();
        std::fs::write(dir.path().join("skill-b/SKILL.md"), "# B 无 frontmatter").unwrap();
        // 无 SKILL.md 的目录应被跳过
        std::fs::create_dir_all(dir.path().join("not-a-skill")).unwrap();

        let cfg = ResolvedConfig {
            provider: "openai".into(),
            model: None,
            preamble: String::new(),
            tools: true,
            mcp_command: None,
            mcp_url: None,
            api_key: None,
            base_url: None,
            providers: Default::default(),
            models: Default::default(),
            mcp: Default::default(),
            lsp: Default::default(),
            skills_paths: vec![dir.path().to_string_lossy().to_string()],
            disabled_skills: vec![],
            reasoning_effort: None,
        };
        let skills = discover(&cfg).unwrap();
        assert_eq!(skills.len(), 2);
        let a = skills.iter().find(|s| s.name == "skill-a").unwrap();
        assert_eq!(a.description, "Skill A");
    }
}
