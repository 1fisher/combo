//! combo 统一目录解析(macOS 与 Linux 一致):
//! 配置与数据都放在 `~/.config/combo/`,不再使用 `~/.local/share/combo`。
//!
//! - `default_config_dir`:`COMBO_CONFIG_DIR` > `~/.config/combo`
//!   (与旧版一致,不走 XDG_CONFIG_HOME);
//! - `default_data_dir`:`COMBO_DATA_DIR` > `default_config_dir()`,
//!   即数据文件(combo.db / combo-cli.db / providers.json / logs 等)
//!   默认与配置文件同住 `~/.config/combo/`;
//! - `migrate_legacy_data_dir`:启动时把旧版 `~/.local/share/combo`
//!   (或 `$XDG_DATA_HOME/combo`)下的数据一次性搬进新目录。
//!   旧目录不存在时为 no-op;同名冲突保留 mtime 较新的一份。

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// 统一配置目录:`COMBO_CONFIG_DIR` 环境变量 > `~/.config/combo`。
pub fn default_config_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("COMBO_CONFIG_DIR") {
        return PathBuf::from(dir);
    }
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
    PathBuf::from(home).join(".config").join("combo")
}

/// 统一数据目录:`COMBO_DATA_DIR` > 配置目录(`COMBO_CONFIG_DIR` > `~/.config/combo`)。
/// 设置 `COMBO_CONFIG_DIR` 时数据随配置走,保证单变量即可整体重定向。
pub fn default_data_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("COMBO_DATA_DIR") {
        return PathBuf::from(dir);
    }
    default_config_dir()
}

/// 旧版(数据目录拆分时期)的数据目录:`$XDG_DATA_HOME/combo` 或
/// `~/.local/share/combo`,与旧代码的解析规则保持一致。
fn legacy_data_dir() -> PathBuf {
    let base = std::env::var("XDG_DATA_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
            PathBuf::from(home).join(".local/share")
        });
    base.join("combo")
}

/// 把旧数据目录的内容搬进 `default_data_dir()`。
///
/// - `COMBO_DATA_DIR` 显式设置时新旧代码都指向同一目录,无需迁移;
/// - 旧目录不存在 / 与新目录相同 → no-op;
/// - 逐项搬移(文件冲突时保留 mtime 较新者,目录递归合并);
/// - 全部搬完后删除旧目录;部分失败则保留剩余内容,下次启动重试。
pub fn migrate_legacy_data_dir() {
    // 显式重定向数据目录时路径未变化,直接跳过。
    if std::env::var_os("COMBO_DATA_DIR").is_some() {
        return;
    }
    let legacy = legacy_data_dir();
    let target = default_data_dir();
    migrate_data_dir(&legacy, &target);
}

/// `migrate_legacy_data_dir` 的核心实现(显式传路径,便于测试)。
pub fn migrate_data_dir(legacy: &Path, target: &Path) {
    if !legacy.is_dir() {
        return;
    }
    if same_path(legacy, target) {
        return;
    }
    let Ok(entries) = std::fs::read_dir(legacy) else {
        return;
    };
    let mut all_ok = true;
    for entry in entries.flatten() {
        let src = entry.path();
        let dst = target.join(entry.file_name());
        if move_entry(&src, &dst).is_err() {
            all_ok = false;
        }
    }
    if all_ok {
        // 目录已搬空:整体移除;若仍有残留(理论不可达)则忽略失败。
        let _ = std::fs::remove_dir_all(legacy);
    }
}

/// 两个路径是否指向同一位置(尽量 canonicalize 比较)。
fn same_path(a: &Path, b: &Path) -> bool {
    let ca = std::fs::canonicalize(a).unwrap_or_else(|_| a.to_path_buf());
    let cb = std::fs::canonicalize(b).unwrap_or_else(|_| b.to_path_buf());
    ca == cb
}

/// 把 `src`(文件或目录)搬移到 `dst`。
///
/// - `dst` 不存在:rename(跨设备失败时回退 copy + 删除);
/// - 双方都是目录:递归合并子项;
/// - 双方都是文件:mtime 较新者胜,败者删除;
/// - 其他错位冲突(文件 vs 目录):保留 `dst`,删除 `src`。
fn move_entry(src: &Path, dst: &Path) -> std::io::Result<()> {
    let src_is_dir = src.is_dir();
    if dst.symlink_metadata().is_ok() {
        if src_is_dir && dst.is_dir() {
            let entries = std::fs::read_dir(src)?;
            for entry in entries.flatten() {
                move_entry(&entry.path(), &dst.join(entry.file_name()))?;
            }
            std::fs::remove_dir(src)
        } else if src_is_dir {
            std::fs::remove_dir_all(src)
        } else if dst.is_dir() {
            std::fs::remove_file(src)
        } else {
            let src_newer = mtime_of(src) > mtime_of(dst);
            if src_newer {
                std::fs::copy(src, dst)?;
            }
            std::fs::remove_file(src)
        }
    } else {
        if let Some(parent) = dst.parent() {
            std::fs::create_dir_all(parent)?;
        }
        if src_is_dir {
            std::fs::create_dir_all(dst)?;
            let entries = std::fs::read_dir(src)?;
            for entry in entries.flatten() {
                move_entry(&entry.path(), &dst.join(entry.file_name()))?;
            }
            std::fs::remove_dir(src)?;
        } else if std::fs::rename(src, dst).is_err() {
            // 跨设备 rename 失败:回退为 copy + 删除。
            std::fs::copy(src, dst)?;
            std::fs::remove_file(src)?;
        }
        Ok(())
    }
}

/// 文件 mtime(SystemTime,不存在取 EPOCH)。
fn mtime_of(p: &Path) -> std::time::SystemTime {
    std::fs::metadata(p)
        .and_then(|m| m.modified())
        .unwrap_or(std::time::SystemTime::UNIX_EPOCH)
}

// =========================== GUI 进程 PATH 补全 ===========================

/// PATH 是否包含 `$HOME` 下的目录(终端启动的进程会继承 .zshrc 配置的
/// `~/.cargo/bin` 等;GUI/launchd 启动的进程只有系统目录)。
fn path_has_home_entry(path: &str) -> bool {
    let home = std::env::var("HOME").unwrap_or_default();
    if home.is_empty() {
        return true; // 拿不到 HOME 时不做任何猜测,视为完整
    }
    path.split([':', ';'])
        .any(|dir| dir.starts_with(&format!("{home}/")) || dir == home)
}

/// 合并两份 PATH:`shell` 在前(用户 shell 的排序即优先级,如 homebrew
/// 优先于系统目录),`current` 中 `shell` 没有的目录追加尾部(不丢进程
/// 自有目录)。空目录条目跳过。
fn merge_path_missing(current: &str, shell: &str) -> String {
    let mut dirs: Vec<&str> = Vec::new();
    for dir in shell.split([':', ';']).chain(current.split([':', ';'])) {
        let dir = dir.trim();
        if dir.is_empty() || dirs.contains(&dir) {
            continue;
        }
        dirs.push(dir);
    }
    dirs.join(":")
}

/// 从登录 shell 输出中解析带标记的 PATH 行。
/// zsh 交互模式(-i)可能在 stdout 打印提示符/杂音,只认
/// `__COMBO_PATH__=` 开头的行,并去掉行尾 CR。
fn parse_shell_path_marker(out: &str) -> Option<String> {
    out.lines()
        .map(str::trim_end)
        .find_map(|l| l.strip_prefix("__COMBO_PATH__="))
        .filter(|p| !p.is_empty())
        .map(String::from)
}

/// 从登录 shell 解析用户完整 PATH:`$SHELL -ilc`(读 .zprofile/.zshrc)
/// 优先,zsh 无 tty 拒绝 `-i` 等场景回落 `-lc`。echo 用单引号包住标记,
/// 让 `$PATH` 由 shell 展开后输出;只认 `__COMBO_PATH__=` 标记行。
/// 解析失败返回 None(调用方静默放弃)。
fn query_login_shell_path() -> Option<String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| {
        if cfg!(target_os = "macos") {
            "/bin/zsh".into()
        } else {
            "/bin/bash".into()
        }
    });
    query_login_shell_path_from(&shell)
}

/// `query_login_shell_path` 的实现,shell 路径显式注入(测试用,避免改写
/// 进程 `SHELL` 环境变量与并行测试竞态——bash 工具等也读 `$SHELL`)。
fn query_login_shell_path_from(shell: &str) -> Option<String> {
    let probe = "echo '__COMBO_PATH__=$PATH'";
    let run = |interactive: bool| {
        let mut cmd = std::process::Command::new(shell);
        if interactive {
            cmd.arg("-ilc");
        } else {
            cmd.arg("-lc");
        }
        cmd.arg(probe).output()
    };
    // 先交互式(覆盖 .zshrc);zsh 无 tty 拒绝 -i 等场景回落 -l
    let out = match run(true) {
        Ok(o) if o.status.success() => Some(String::from_utf8_lossy(&o.stdout).into_owned()),
        _ => None,
    }
    .or_else(|| match run(false) {
        Ok(o) if o.status.success() => Some(String::from_utf8_lossy(&o.stdout).into_owned()),
        _ => None,
    })?;
    parse_shell_path_marker(&out)
}

/// 登录 shell PATH 的进程内缓存查询,供 spawn 外部命令时「加载 shell 环境」
/// (见 `lsp::spawn_path_for`)。进程 PATH 已含 `$HOME` 下目录(终端启动,
/// 或 `ensure_gui_path` 启动时已合并)时视为完整,直接跳过查询、避免每次
/// spawn 都拉起 shell;查询失败返回 None,由其余来源(进程 PATH + 兜底
/// 目录)兜住。
pub fn login_shell_path_cached() -> Option<String> {
    static CACHED: OnceLock<Option<String>> = OnceLock::new();
    CACHED
        .get_or_init(|| {
            let current = std::env::var("PATH").unwrap_or_default();
            if path_has_home_entry(&current) {
                return None;
            }
            query_login_shell_path()
        })
        .clone()
}

/// GUI(Finder/Dock/launchd)启动的进程 PATH 只有系统目录,不继承用户
/// shell 的 .zshrc/.zprofile——`~/.cargo/bin`、`/opt/homebrew/bin` 等都
/// 不在,导致 LSP 检测「未找到」、npm/rustup 等命令无法 spawn。
///
/// 这里参考 VS Code(shell-env)的做法:PATH 中没有 `$HOME` 下目录时,
/// 从登录 shell(`$SHELL -ilc`)解析用户完整 PATH 并合并(shell 顺序
/// 优先,进程独有目录追加尾部)。终端启动时 PATH 已完整,检测即跳过、
/// 零开销。**必须在启动早期(单线程阶段)调用**——内部修改进程环境
/// 变量。解析失败静默放弃,由 `lsp::find_executable` 的目录兜底兜住;
/// spawn 外部命令时的按需补全走 `login_shell_path_cached()`。
pub fn ensure_gui_path() -> bool {
    #[cfg(windows)]
    {
        // Windows GUI PATH 问题需经注册表/PowerShell profile 解析,暂不处理
        return false;
    }
    #[cfg(not(windows))]
    {
        let current = std::env::var("PATH").unwrap_or_default();
        if path_has_home_entry(&current) {
            return false;
        }
        let Some(shell_path) = query_login_shell_path() else {
            return false;
        };
        if !path_has_home_entry(&shell_path) {
            return false;
        }
        let merged = merge_path_missing(&current, &shell_path);
        if merged == current {
            return false;
        }
        // 仅启动早期(单线程)调用是安全惯例
        std::env::set_var("PATH", &merged);
        true
    }
}

/// 测试专用:COMBO_DATA_DIR / COMBO_CONFIG_DIR 相关测试的串行锁。
/// 这些环境变量决定默认路径,并行测试互相改写会产生竞态。
#[cfg(test)]
pub(crate) static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn touch(p: &Path, content: &str) {
        fs::write(p, content).unwrap();
    }

    #[test]
    fn merge_path_missing_keeps_shell_order_and_appends_current_only() {
        let shell = "/opt/homebrew/bin:/usr/bin:/bin";
        let current = "/usr/bin:/bin:/usr/sbin";
        assert_eq!(
            merge_path_missing(current, shell),
            "/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin",
            "shell 顺序在前,进程独有目录追加尾部,重复去重"
        );
        // 空条目跳过;两侧完全一致时结果不变
        assert_eq!(
            merge_path_missing("/a::/b", "/a:/b"),
            "/a:/b",
            "空目录条目应被跳过"
        );
        assert_eq!(merge_path_missing("/a:/b", "/a:/b"), "/a:/b");
    }

    #[test]
    fn parse_shell_path_marker_ignores_zsh_noise() {
        // zsh -i 在无 tty 时可能打印提示符/欢迎语;只认标记行,且去 CR
        let noisy = "last login: today\n➜  ~ echo '__COMBO_PATH__=/Users/x/.cargo/bin:/usr/bin\r\n__COMBO_PATH__=/Users/x/.cargo/bin:/usr/bin\r\n";
        assert_eq!(
            parse_shell_path_marker(noisy).as_deref(),
            Some("/Users/x/.cargo/bin:/usr/bin"),
            "应跳过杂音行命中最后一个标记行"
        );
        assert!(parse_shell_path_marker("no marker here").is_none());
        assert!(parse_shell_path_marker("__COMBO_PATH__=\r\n").is_none(), "空 PATH 不算");
    }

    /// 登录 shell PATH 查询:shell 输出标记行时能正确解析(spawn 时按需
    /// 「加载 shell 环境」的探测基础)。shell 路径直接注入,不改写进程
    /// SHELL 环境变量(bash 工具测试并行读 $SHELL,改写会互相污染)。
    #[cfg(unix)]
    #[test]
    fn query_login_shell_path_parses_marker_from_fake_shell() {
        let dir = tempfile::tempdir().unwrap();
        let fake = dir.path().join("fakesh");
        fs::write(
            &fake,
            "#!/bin/sh\necho __COMBO_PATH__=/opt/homebrew/bin:/usr/bin:/bin\n",
        )
        .unwrap();
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let got = query_login_shell_path_from(&fake.to_string_lossy());
        assert_eq!(got.as_deref(), Some("/opt/homebrew/bin:/usr/bin:/bin"));
    }

    #[test]
    fn path_has_home_entry_detects_gui_path() {
        let home = std::env::var("HOME").unwrap_or_default();
        if home.is_empty() {
            return; // 无 HOME 的环境里该函数恒 true,跳过断言
        }
        assert!(
            path_has_home_entry(&format!("{home}/.cargo/bin:/usr/bin:/bin")),
            "含 HOME 目录 → 视为已继承 shell 环境"
        );
        assert!(
            !path_has_home_entry("/usr/bin:/bin:/usr/sbin:/sbin"),
            "纯系统目录(launchd/GUI)→ 需要补全"
        );
    }

    #[test]
    fn migrate_moves_all_entries_and_removes_legacy() {
        let base = tempfile::tempdir().unwrap();
        let legacy = base.path().join("legacy");
        let target = base.path().join("target");
        fs::create_dir_all(legacy.join("logs")).unwrap();
        touch(&legacy.join("combo.db"), "db");
        touch(&legacy.join("providers.json"), "{}");
        touch(&legacy.join("logs").join("agent-2026-01-01.log"), "[]");

        migrate_data_dir(&legacy, &target);

        assert!(!legacy.exists());
        assert_eq!(fs::read_to_string(target.join("combo.db")).unwrap(), "db");
        assert_eq!(fs::read_to_string(target.join("providers.json")).unwrap(), "{}");
        assert!(target.join("logs/agent-2026-01-01.log").is_file());
    }

    #[test]
    fn migrate_keeps_newer_file_on_conflict() {
        let base = tempfile::tempdir().unwrap();
        let legacy = base.path().join("legacy");
        let target = base.path().join("target");
        fs::create_dir_all(&legacy).unwrap();
        fs::create_dir_all(&target).unwrap();
        touch(&legacy.join("combo.db"), "old");
        touch(&target.join("combo.db"), "new");
        // 旧文件 mtime 更早:保留新目录里的版本
        let old_time = std::time::SystemTime::now() - std::time::Duration::from_secs(3600);
        let f = fs::File::options()
            .append(true)
            .open(legacy.join("combo.db"))
            .unwrap();
        f.set_modified(old_time).unwrap();

        migrate_data_dir(&legacy, &target);

        assert_eq!(fs::read_to_string(target.join("combo.db")).unwrap(), "new");
        assert!(!legacy.exists());
    }

    #[test]
    fn migrate_noop_when_legacy_missing_or_same() {
        let base = tempfile::tempdir().unwrap();
        migrate_data_dir(&base.path().join("missing"), &base.path().join("target"));
        assert!(!base.path().join("target").exists());

        let dir = base.path().join("same");
        fs::create_dir_all(&dir).unwrap();
        touch(&dir.join("combo.db"), "db");
        migrate_data_dir(&dir, &dir);
        assert!(dir.join("combo.db").is_file());
    }

    #[test]
    fn migrate_merges_logs_directory() {
        let base = tempfile::tempdir().unwrap();
        let legacy = base.path().join("legacy");
        let target = base.path().join("target");
        fs::create_dir_all(legacy.join("logs")).unwrap();
        fs::create_dir_all(target.join("logs")).unwrap();
        touch(&legacy.join("logs").join("a.log"), "a");
        touch(&target.join("logs").join("b.log"), "b");

        migrate_data_dir(&legacy, &target);

        assert!(target.join("logs/a.log").is_file());
        assert!(target.join("logs/b.log").is_file());
        assert!(!legacy.exists());
    }

    #[test]
    fn default_dirs_priority() {
        let _env = ENV_LOCK.lock().unwrap();
        std::env::set_var("COMBO_DATA_DIR", "/tmp/combo-paths-data");
        std::env::set_var("COMBO_CONFIG_DIR", "/tmp/combo-paths-config");
        assert_eq!(default_data_dir(), PathBuf::from("/tmp/combo-paths-data"));
        assert_eq!(default_config_dir(), PathBuf::from("/tmp/combo-paths-config"));

        std::env::remove_var("COMBO_DATA_DIR");
        // 数据目录回落到配置目录
        assert_eq!(default_data_dir(), PathBuf::from("/tmp/combo-paths-config"));

        std::env::remove_var("COMBO_CONFIG_DIR");
        assert!(default_data_dir().ends_with(".config/combo"));
        assert!(default_config_dir().ends_with(".config/combo"));
    }
}
