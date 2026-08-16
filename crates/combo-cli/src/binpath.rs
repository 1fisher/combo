//! 外部二进制路径解析。
//!
//! GUI(Tauri)进程继承的 PATH 通常只含系统目录(`/usr/bin:/bin:...`),
//! 通过 homebrew / cargo 等安装的 ripgrep 不在其中,导致 `Command::new("rg")`
//! 报 NotFound 而误回退内置搜索。这里在 PATH 查找失败后继续探测常见安装
//! 目录,保证 rg 可用时一定被优先使用。

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

#[cfg(windows)]
const RG_EXE: &str = "rg.exe";
#[cfg(not(windows))]
const RG_EXE: &str = "rg";

static RG_PATH: OnceLock<Option<PathBuf>> = OnceLock::new();

/// rg 常见安装目录(PATH 之外的探测候选,顺序即优先级)。
fn rg_candidate_dirs() -> Vec<PathBuf> {
    let mut dirs = vec![
        PathBuf::from("/opt/homebrew/bin"), // macOS Apple Silicon(homebrew)
        PathBuf::from("/usr/local/bin"),    // macOS Intel(homebrew)/ Linux 手动安装
        PathBuf::from("/usr/bin"),          // Linux 发行版包
        PathBuf::from("/bin"),
    ];
    if let Some(home) = dirs::home_dir() {
        dirs.push(home.join(".cargo").join("bin")); // cargo install ripgrep
        dirs.push(home.join(".local").join("bin"));
    }
    dirs
}

/// 解析 ripgrep 可执行文件路径:先按 PATH 查找,失败后依次探测常见安装目录。
/// 结果在进程内缓存;找不到返回 None,由调用方回退内置搜索。
pub fn resolve_rg() -> Option<&'static Path> {
    RG_PATH
        .get_or_init(|| {
            if let Ok(found) = which::which(RG_EXE) {
                return Some(found);
            }
            rg_candidate_dirs()
                .into_iter()
                .map(|dir| dir.join(RG_EXE))
                .find(|p| p.is_file())
        })
        .as_deref()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn candidate_dirs_cover_common_install_locations() {
        let dirs = rg_candidate_dirs();
        assert!(dirs.contains(&PathBuf::from("/opt/homebrew/bin")));
        assert!(dirs.contains(&PathBuf::from("/usr/local/bin")));
        if let Some(home) = dirs::home_dir() {
            assert!(dirs.contains(&home.join(".cargo").join("bin")));
            assert!(dirs.contains(&home.join(".local").join("bin")));
        }
    }

    #[test]
    fn resolve_rg_matches_which_when_on_path() {
        if let Ok(found) = which::which(RG_EXE) {
            assert_eq!(resolve_rg(), Some(found.as_path()));
        }
    }

    #[test]
    fn resolve_rg_result_is_existing_file() {
        // PATH 查不到时(resolve 依赖候选目录探测),结果必须是真实存在的文件。
        if let Some(p) = resolve_rg() {
            assert!(p.is_file(), "解析到的 rg 路径不存在: {p:?}");
        }
    }
}
