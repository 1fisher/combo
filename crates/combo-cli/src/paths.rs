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
