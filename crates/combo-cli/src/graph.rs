//! 项目知识图谱:扫描 workspace 源码文件,解析文件间 import/依赖关系,
//! 构建文件级依赖图 + 外部依赖统计,供前端「知识图谱」视图渲染。
//!
//! 解析采用启发式正则(不引入 tree-sitter 等重型依赖),支持
//! TS/JS/TSX/JSX、Vue/Svelte、Python、Rust、Go、C/C++ 等常见语言:
//! - TS/JS:相对路径(`./`/`../`)与常见别名(`@/`、`~/`、`@src/`)解析,
//!   裸包名(如 `react`)聚合进外部依赖;`index.ts(x)` 目录导入自动展开。
//! - Python:`from x.y import` / `import x.y`,相对导入(前导点)按层级回退。
//! - Rust:`use crate::x` 与 `mod x;` 按 crate 的 `src` 目录解析。
//! - Go:读取 `go.mod` 的 module 路径,匹配模块内目录;标准库忽略。
//! - C/C++:`#include "..."` 按相对路径解析(尖括号视为系统头文件忽略)。

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::Path as FsPath;
use std::sync::LazyLock;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::Response;
use regex::Regex;
use serde_json::{json, Value};

use crate::fs::{error, is_skip_dir, ok_json, resolve_root};
use crate::serve::AppState;

/// 图谱扫描文件数上限(超过截断并标记 truncated,防止超大仓库拖垮前端)。
const MAX_GRAPH_FILES: usize = 2500;
/// 单文件读取上限(1MB),与文件服务一致。
const MAX_FILE_BYTES: u64 = 1024 * 1024;

/// TS/JS 系文件解析 import 时依次尝试的扩展名。
const TS_EXTS: &[&str] = &["ts", "tsx", "js", "jsx", "mjs", "cjs", "vue", "svelte"];

// ---------------------------------------------------------------------------
// 语言识别
// ---------------------------------------------------------------------------

/// 根据文件名扩展识别语言;不认识的返回 None(不进图谱)。
fn lang_for(name: &str) -> Option<&'static str> {
    let ext = name
        .rsplit_once('.')
        .map(|(_, e)| e.to_ascii_lowercase())
        .unwrap_or_default();
    Some(match ext.as_str() {
        "ts" => "ts",
        "tsx" => "tsx",
        "js" | "mjs" | "cjs" => "js",
        "jsx" => "jsx",
        "py" | "pyi" => "py",
        "rs" => "rs",
        "go" => "go",
        "vue" => "vue",
        "svelte" => "svelte",
        "java" => "java",
        "kt" | "kts" => "kotlin",
        "rb" => "ruby",
        "php" => "php",
        "swift" => "swift",
        "c" | "h" => "c",
        "cpp" | "cc" | "cxx" | "hpp" => "cpp",
        _ => return None,
    })
}

fn is_ts_like(lang: &str) -> bool {
    matches!(lang, "ts" | "tsx" | "js" | "jsx" | "vue" | "svelte")
}

// ---------------------------------------------------------------------------
// 正则(进程内只编译一次)
// ---------------------------------------------------------------------------

/// TS/JS 系:import/export ... from 'x'、import 'x'、require('x')、import('x')。
static TS_IMPORT_RES: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    [
        // import/export(type)…from 'x'(允许多行命名导入,限制长度防贪婪回溯爆炸)
        r#"(?:import|export)\s+(?:type\s+)?[\s\S]{0,400}?from\s*['"]([^'"\n]+)['"]"#,
        // 副作用导入 import 'x'
        r#"(?:^|[;{}\s])import\s*['"]([^'"\n]+)['"]"#,
        // require('x') / import('x')
        r#"(?:require|import)\(\s*['"]([^'"\n]+)['"]\s*\)"#,
    ]
    .iter()
    .map(|p| Regex::new(p).expect("TS import regex"))
    .collect()
});

/// Python:from x.y import / import a, b。
static PY_IMPORT_RES: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    [
        r"(?m)^\s*from\s+([.\w]+)\s+import\b",
        r"(?m)^\s*import\s+([\w.]+(?:\s*,\s*[\w.]+)*)",
    ]
    .iter()
    .map(|p| Regex::new(p).expect("Python import regex"))
    .collect()
});

/// Rust:use crate::x(仅 crate 内);mod x;
static RS_USE_RES: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    [
        r"(?m)^\s*(?:pub(?:\([^)]*\))?\s+)?use\s+crate::([\w:]+)",
        r"(?m)^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+(\w+)\s*;",
    ]
    .iter()
    .map(|p| Regex::new(p).expect("Rust use/mod regex"))
    .collect()
});

/// Go:import 块内或单行的带引号导入路径。
static GO_IMPORT_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(?m)^\s*(?:_\s+|\w+(?:\s+\w+)?\s+)?"([^"]+)""#).expect("Go import regex"));

/// C/C++:#include "x.h"(仅引号形式;尖括号是系统头文件,忽略)。
static C_INCLUDE_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"#include\s*"([^"]+)""#).expect("C include regex"));

/// 按语言提取 import specifier 原始列表(去重)。
fn extract_imports(lang: &str, content: &str) -> Vec<String> {
    let mut specs: Vec<String> = Vec::new();
    let mut seen = HashSet::new();
    let mut push = |s: &str| {
        let s = s.trim();
        if !s.is_empty() && seen.insert(s.to_string()) {
            specs.push(s.to_string());
        }
    };

    if is_ts_like(lang) {
        for re in TS_IMPORT_RES.iter() {
            for cap in re.captures_iter(content) {
                if let Some(m) = cap.get(1) {
                    push(m.as_str());
                }
            }
        }
    } else if lang == "py" {
        for re in PY_IMPORT_RES.iter() {
            for cap in re.captures_iter(content) {
                let Some(m) = cap.get(1) else { continue };
                let s = m.as_str();
                // from 语句整段取;import a, b 按逗号拆开
                if s.contains(',') {
                    for part in s.split(',') {
                        push(part);
                    }
                } else {
                    push(s);
                }
            }
        }
    } else if lang == "rs" {
        for re in RS_USE_RES.iter() {
            for cap in re.captures_iter(content) {
                if let Some(m) = cap.get(1) {
                    push(m.as_str());
                }
            }
        }
    } else if lang == "go" {
        for cap in GO_IMPORT_RE.captures_iter(content) {
            if let Some(m) = cap.get(1) {
                push(m.as_str());
            }
        }
    } else if lang == "c" || lang == "cpp" {
        for cap in C_INCLUDE_RE.captures_iter(content) {
            if let Some(m) = cap.get(1) {
                push(m.as_str());
            }
        }
    }
    specs
}

/// 按语言统计顶层定义数(函数/类/接口等,启发式计数)。
fn count_defs(lang: &str, content: &str) -> usize {
    let patterns: &[&str] = match lang {
        "ts" => &[
            r"\bfunction\s+\w",
            r"\bclass\s+\w",
            r"\binterface\s+\w",
            r"\btype\s+\w\s*=",
            r"\bconst\s+\w+\s*=\s*(?:async\s*)?\(", // 箭头/函数表达式组件
        ],
        "tsx" | "js" | "jsx" | "vue" | "svelte" => &[r"\bfunction\s+\w", r"\bclass\s+\w"],
        "py" => &[r"(?m)^\s*(?:async\s+)?def\s+\w", r"(?m)^\s*class\s+\w"],
        "rs" => &[
            r"\bfn\s+\w",
            r"\bstruct\s+\w",
            r"\benum\s+\w",
            r"\btrait\s+\w",
            r"\bimpl\s+\w",
        ],
        "go" => &[r"(?m)^func\s"],
        "java" | "kotlin" | "swift" | "php" => &[r"\bclass\s+\w", r"\bfunc(?:tion)?\s+\w"],
        "ruby" => &[r"(?m)^\s*def\s+\w", r"(?m)^\s*class\s+\w"],
        "c" | "cpp" => &[r"\w+\s+\w+\s*\([^;]*\)\s*\{"],
        _ => &[],
    };
    patterns
        .iter()
        .filter_map(|p| Regex::new(p).ok())
        .map(|re| re.find_iter(content).count())
        .sum()
}

// ---------------------------------------------------------------------------
// specifier → 目标文件解析
// ---------------------------------------------------------------------------

/// 解析结果:Internal(解析到项目内文件)/ External(外部依赖包)/ None(无法解析,忽略)。
#[derive(Debug, Clone, PartialEq)]
enum Resolution {
    Internal(String),
    External(String),
    None,
}

/// 解析上下文:全部源文件集合 + go.mod module 信息(目录前缀 → module 路径)。
struct ResolveCtx {
    files: HashSet<String>,
    go_modules: Vec<(String, String)>, // (go.mod 所在相对目录, module 路径),按目录长度降序
}

impl ResolveCtx {
    fn has(&self, rel: &str) -> bool {
        self.files.contains(rel)
    }
}

/// 相对路径 join + 归一(`.`/`..` 消解),越出根返回 None。
fn normalize_rel(base_dir: &str, spec: &str) -> Option<String> {
    let mut parts: Vec<&str> = Vec::new();
    if !base_dir.is_empty() {
        parts.extend(base_dir.split('/'));
    }
    for seg in spec.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                if parts.pop().is_none() {
                    return None; // 越出 workspace 根
                }
            }
            s => parts.push(s),
        }
    }
    Some(parts.join("/"))
}

/// TS/JS:`@/x`、`~/x` 等别名映射到 `src/x` 起点的候选前缀(再退根目录)。
fn ts_alias_prefixes() -> &'static [&'static str] {
    &["src", ""]
}

/// TS/JS:别名(`@/x` 等)映射到 `src/x` / 根 `x`,依次尝试「原样 / 加扩展名 / 目录 index」。
fn try_ts_candidates(ctx: &ResolveCtx, path_no_ext: &str) -> Option<String> {
    for prefix in ts_alias_prefixes() {
        let Some(rel) = normalize_rel(prefix, path_no_ext) else {
            continue;
        };
        // 原样(可能自带扩展名,如 './styles.css')
        if ctx.has(&rel) {
            return Some(rel);
        }
        for ext in TS_EXTS {
            let cand = format!("{rel}.{ext}");
            if ctx.has(&cand) {
                return Some(cand);
            }
        }
        for ext in TS_EXTS {
            let cand = format!("{rel}/index.{ext}");
            if ctx.has(&cand) {
                return Some(cand);
            }
        }
    }
    None
}

/// Rust:文件所在 crate 的 `src` 目录(`.../src/foo.rs` → `.../src`);
/// 文件不在 src 下时回退到文件所在目录。
fn rust_src_dir(from: &str) -> String {
    let mut dir = from.rsplit_once('/').map(|(d, _)| d.to_string()).unwrap_or_default();
    loop {
        let base = dir.rsplit_once('/').map(|(d, _)| d.to_string()).unwrap_or_default();
        let name = dir.rsplit_once('/').map(|(_, n)| n).unwrap_or(dir.as_str());
        if name == "src" {
            return dir; // dir 形如 crates/combo-cli/src
        }
        if base.is_empty() {
            break;
        }
        dir = base;
    }
    from.rsplit_once('/').map(|(d, _)| d.to_string()).unwrap_or_default()
}

/// Rust:crate::a::b → {src}/a/b.rs 或 {src}/a/b/mod.rs。
fn try_rust_mod(ctx: &ResolveCtx, src_dir: &str, path: &str) -> Option<String> {
    let file = path.replace("::", "/");
    let base = if src_dir.is_empty() {
        file
    } else {
        format!("{src_dir}/{file}")
    };
    for cand in [format!("{base}.rs"), format!("{base}/mod.rs")] {
        if ctx.has(&cand) {
            return Some(cand);
        }
    }
    None
}

/// Rust:`mod x;` 声明按声明文件所在目录解析(x.rs / x/mod.rs;
/// 若声明文件是 mod.rs,则按父目录解析)。
fn try_rust_local_mod(ctx: &ResolveCtx, from: &str, name: &str) -> Option<String> {
    let mut dir = from.rsplit_once('/').map(|(d, _)| d.to_string()).unwrap_or_default();
    if from.ends_with("/mod.rs") {
        dir = dir.rsplit_once('/').map(|(d, _)| d.to_string()).unwrap_or_default();
    }
    for cand in [
        if dir.is_empty() {
            format!("{name}.rs")
        } else {
            format!("{dir}/{name}.rs")
        },
        if dir.is_empty() {
            format!("{name}/mod.rs")
        } else {
            format!("{dir}/{name}/mod.rs")
        },
    ] {
        if ctx.has(&cand) {
            return Some(cand);
        }
    }
    None
}

/// 单个 specifier 解析入口。
fn resolve_spec(lang: &str, from: &str, spec: &str, ctx: &ResolveCtx) -> Resolution {
    let from_dir = from.rsplit_once('/').map(|(d, _)| d).unwrap_or("");

    if is_ts_like(lang) {
        if spec.starts_with("./") || spec.starts_with("../") {
            // 相对导入:基于 from 所在目录
            if let Some(rel) = normalize_rel(from_dir, spec) {
                if ctx.has(&rel) {
                    return Resolution::Internal(rel);
                }
                for ext in TS_EXTS {
                    let cand = format!("{rel}.{ext}");
                    if ctx.has(&cand) {
                        return Resolution::Internal(cand);
                    }
                }
                for ext in TS_EXTS {
                    let cand = format!("{rel}/index.{ext}");
                    if ctx.has(&cand) {
                        return Resolution::Internal(cand);
                    }
                }
            }
            return Resolution::None;
        }
        // 常见别名:@/x、~/x、@src/x → src/x(再退根)
        if let Some(rest) = spec
            .strip_prefix("@/")
            .or_else(|| spec.strip_prefix("~/"))
            .or_else(|| spec.strip_prefix("@src/"))
        {
            if let Some(rel) = try_ts_candidates(ctx, rest) {
                return Resolution::Internal(rel);
            }
            return Resolution::None;
        }
        // 裸包名 → 外部依赖(@scope/pkg 取两段,否则一段)
        let pkg = if spec.starts_with('@') {
            spec.splitn(3, '/').take(2).collect::<Vec<_>>().join("/")
        } else {
            spec.split('/').next().unwrap_or("").to_string()
        };
        return if pkg.is_empty() {
            Resolution::None
        } else {
            Resolution::External(pkg)
        };
    }

    if lang == "py" {
        // 相对导入:from .x / from ..x import(点数 = 上跳层数 + 1)
        if spec.starts_with('.') {
            let dots = spec.chars().take_while(|c| *c == '.').count();
            let rest = &spec[dots..];
            let mut dir = from_dir.to_string();
            for _ in 1..dots {
                // 逐级上跳;已到根(空串)则停住,越界部分忽略
                dir = match dir.rsplit_once('/').map(|(d, _)| d.to_string()) {
                    Some(d) => d,
                    None => String::new(),
                };
            }
            let base = if rest.is_empty() {
                dir.clone()
            } else if dir.is_empty() {
                rest.to_string()
            } else {
                format!("{dir}/{rest}")
            };
            for cand in [format!("{base}.py"), format!("{base}/__init__.py")] {
                if ctx.has(&cand) {
                    return Resolution::Internal(cand);
                }
            }
            return Resolution::None;
        }
        // 绝对模块:根目录(或 src/)下 a/b.py、a/b/__init__.py
        let path = spec.replace('.', "/");
        for prefix in ["", "src/"] {
            let base = format!("{prefix}{path}");
            for cand in [format!("{base}.py"), format!("{base}/__init__.py")] {
                if ctx.has(&cand) {
                    return Resolution::Internal(cand);
                }
            }
        }
        return Resolution::External(spec.split('.').next().unwrap_or("").to_string());
    }

    if lang == "rs" {
        let src_dir = rust_src_dir(from);
        // use crate::a::b → src/a/b.rs
        if let Some(rel) = try_rust_mod(ctx, &src_dir, spec) {
            return Resolution::Internal(rel);
        }
        // mod x;(无 :: 视为本地模块声明)
        if !spec.contains(':') {
            if let Some(rel) = try_rust_local_mod(ctx, from, spec) {
                return Resolution::Internal(rel);
            }
        }
        return Resolution::None;
    }

    if lang == "go" {
        // 最近祖先 go.mod 的 module 前缀(modules 已按目录长度降序,首个命中即最近)
        for (mod_dir, module) in &ctx.go_modules {
            let module_prefix = format!("{module}/");
            if let Some(rest) = spec.strip_prefix(&module_prefix) {
                // rest 指向包目录:取该目录下字典序最小的 .go 文件作为代表节点
                let target_dir = if mod_dir.is_empty() {
                    rest.to_string()
                } else {
                    format!("{mod_dir}/{rest}")
                };
                if let Some(f) = go_dir_file(ctx, &target_dir) {
                    return Resolution::Internal(f);
                }
                return Resolution::None;
            }
        }
        // 无域名前缀 → 标准库;有域名 → 外部依赖
        let first = spec.split('/').next().unwrap_or("");
        return if first.contains('.') {
            Resolution::External(first.to_string())
        } else {
            Resolution::None
        };
    }

    if lang == "c" || lang == "cpp" {
        if let Some(rel) = normalize_rel(from_dir, spec) {
            if ctx.has(&rel) {
                return Resolution::Internal(rel);
            }
            for cand in [format!("{rel}.h"), format!("{rel}.hpp")] {
                if ctx.has(&cand) {
                    return Resolution::Internal(cand);
                }
            }
        }
        return Resolution::None;
    }

    Resolution::None
}

/// Go:在已扫描文件集合中找 `dir/` 目录下字典序最小的 .go 文件。
/// (files 是 HashSet,最坏遍历一次;为控制开销只扫一遍并取最小值。)
fn go_dir_file(ctx: &ResolveCtx, dir: &str) -> Option<String> {
    if dir.is_empty() {
        return None;
    }
    let prefix = format!("{dir}/");
    ctx.files
        .iter()
        .filter(|f| f.starts_with(&prefix) && f.ends_with(".go"))
        .min()
        .cloned()
}

// ---------------------------------------------------------------------------
// 图谱构建
// ---------------------------------------------------------------------------

struct SourceFile {
    rel: String,
    lang: &'static str,
    content: String,
}

/// 扫描 workspace 内全部可识别源文件(跳过 node_modules/target 等目录与隐藏目录)。
fn scan_files(root: &FsPath) -> anyhow::Result<(Vec<SourceFile>, Vec<(String, String)>, bool)> {
    let mut files = Vec::new();
    let mut go_modules = Vec::new();
    let mut truncated = false;

    for entry in walkdir::WalkDir::new(root)
        .into_iter()
        .filter_entry(|e| {
            if e.depth() == 0 {
                return true;
            }
            let name = e.file_name().to_string_lossy();
            if e.file_type().is_dir() {
                return !is_skip_dir(&name);
            }
            true
        })
        .filter_map(|e| e.ok())
    {
        if !entry.file_type().is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        // go.mod:记录 module 路径供 Go import 解析
        if name == "go.mod" {
            if let Some((dir, module)) = read_go_mod(root, entry.path()) {
                go_modules.push((dir, module));
            }
            continue;
        }
        let Some(lang) = lang_for(&name) else {
            continue;
        };
        if files.len() >= MAX_GRAPH_FILES {
            truncated = true;
            break;
        }
        if entry.metadata().map(|m| m.len() > MAX_FILE_BYTES).unwrap_or(true) {
            continue;
        }
        let rel = entry
            .path()
            .strip_prefix(root)
            .unwrap_or(entry.path())
            .to_string_lossy()
            .replace('\\', "/");
        let Ok(content) = std::fs::read_to_string(entry.path()) else {
            continue;
        };
        files.push(SourceFile { rel, lang, content });
    }

    // 目录越深越具体,前缀匹配时优先
    go_modules.sort_by(|a, b| b.0.len().cmp(&a.0.len()));
    Ok((files, go_modules, truncated))
}

/// 解析 go.mod 首个 `module xxx` 行;返回(go.mod 所在相对目录, module 路径)。
fn read_go_mod(root: &FsPath, path: &FsPath) -> Option<(String, String)> {
    let content = std::fs::read_to_string(path).ok();
    let module = content
        .and_then(|c| {
            c.lines().find_map(|l| {
                let l = l.trim();
                l.strip_prefix("module ").map(|m| m.trim().to_string())
            })
        })
        .filter(|m| !m.is_empty())?;
    let dir = path
        .parent()
        .and_then(|p| p.strip_prefix(root).ok())
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_default();
    Some((dir, module))
}

/// 构建知识图谱 JSON(nodes/edges/stats)。纯同步函数,便于单元测试。
pub fn build_graph(root: &FsPath) -> anyhow::Result<Value> {
    let root = std::fs::canonicalize(root)?;
    let (files, go_modules, truncated) = scan_files(&root)?;

    let mut files_set: HashSet<String> = HashSet::new();
    let mut loc_map: HashMap<String, usize> = HashMap::new();
    let mut defs_map: HashMap<String, usize> = HashMap::new();
    let mut imports_map: HashMap<String, Vec<String>> = HashMap::new();
    let mut lang_map: HashMap<String, &'static str> = HashMap::new();
    for f in &files {
        files_set.insert(f.rel.clone());
        lang_map.insert(f.rel.clone(), f.lang);
        loc_map.insert(f.rel.clone(), f.content.lines().count());
        defs_map.insert(f.rel.clone(), count_defs(f.lang, &f.content));
        imports_map.insert(f.rel.clone(), extract_imports(f.lang, &f.content));
    }

    let ctx = ResolveCtx {
        files: files_set,
        go_modules,
    };

    let mut edge_set: HashSet<(String, String)> = HashSet::new();
    let mut edges: Vec<(String, String)> = Vec::new();
    let mut external: BTreeMap<String, usize> = BTreeMap::new();
    let mut ext_per_file: HashMap<String, Vec<String>> = HashMap::new();

    for f in &files {
        let specs = imports_map.get(&f.rel).cloned().unwrap_or_default();
        for spec in specs {
            match resolve_spec(f.lang, &f.rel, &spec, &ctx) {
                Resolution::Internal(target) => {
                    if target != f.rel && edge_set.insert((f.rel.clone(), target.clone())) {
                        edges.push((f.rel.clone(), target));
                    }
                }
                Resolution::External(pkg) => {
                    *external.entry(pkg.clone()).or_insert(0) += 1;
                    ext_per_file
                        .entry(f.rel.clone())
                        .or_default()
                        .push(pkg);
                }
                Resolution::None => {}
            }
        }
    }

    // 入度/出度统计(仅内部边)
    let mut out_deg: HashMap<&str, usize> = HashMap::new();
    let mut in_deg: HashMap<&str, usize> = HashMap::new();
    for (s, t) in &edges {
        *out_deg.entry(s.as_str()).or_insert(0) += 1;
        *in_deg.entry(t.as_str()).or_insert(0) += 1;
    }

    let nodes: Vec<Value> = files
        .iter()
        .map(|f| {
            let (dir, name) = f
                .rel
                .rsplit_once('/')
                .map(|(d, n)| (d.to_string(), n.to_string()))
                .unwrap_or_else(|| (".".to_string(), f.rel.clone()));
            json!({
                "id": f.rel,
                "name": name,
                "dir": dir,
                "lang": f.lang,
                "defs": defs_map.get(&f.rel).copied().unwrap_or(0),
                "loc": loc_map.get(&f.rel).copied().unwrap_or(0),
                "out": out_deg.get(f.rel.as_str()).copied().unwrap_or(0),
                "in": in_deg.get(f.rel.as_str()).copied().unwrap_or(0),
                "external": ext_per_file.get(&f.rel).cloned().unwrap_or_default(),
            })
        })
        .collect();

    let mut langs: BTreeMap<&str, usize> = BTreeMap::new();
    let mut total_loc = 0usize;
    for f in &files {
        *langs.entry(f.lang).or_insert(0) += 1;
        total_loc += loc_map.get(&f.rel).copied().unwrap_or(0);
    }

    let mut external_list: Vec<(String, usize)> = external.into_iter().collect();
    external_list.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    let external_list: Vec<Value> = external_list
        .into_iter()
        .take(100)
        .map(|(name, count)| json!({ "name": name, "count": count }))
        .collect();

    let edge_json: Vec<Value> = edges
        .iter()
        .map(|(s, t)| json!({ "source": s, "target": t }))
        .collect();

    Ok(json!({
        "nodes": nodes,
        "edges": edge_json,
        "stats": {
            "files": nodes.len(),
            "edges": edge_json.len(),
            "total_loc": total_loc,
            "langs": langs,
            "external": external_list,
            "truncated": truncated,
        },
        "generated_at": chrono::Utc::now().timestamp(),
    }))
}

// ---------------------------------------------------------------------------
// HTTP handler
// ---------------------------------------------------------------------------

/// GET /v1/workspaces/{id}/graph
/// 扫描项目源码构建知识图谱(文件依赖图 + 外部依赖统计)。
pub async fn graph(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    let root = match resolve_root(&state, &id) {
        Ok(r) => r,
        Err(resp) => return resp,
    };
    match tokio::task::spawn_blocking(move || build_graph(&root)).await {
        Ok(Ok(v)) => ok_json(v),
        Ok(Err(e)) => error(StatusCode::INTERNAL_SERVER_ERROR, &format!("构建知识图谱失败: {e}")),
        Err(e) => error(StatusCode::INTERNAL_SERVER_ERROR, &format!("图谱扫描任务异常: {e}")),
    }
}

// ---------------------------------------------------------------------------
// 单元测试
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// 在临时目录里写入一批文件,构建图谱并断言节点/边。
    fn graph_of(files: &[(&str, &str)]) -> Value {
        let dir = tempfile::tempdir().unwrap();
        for (rel, content) in files {
            let p = dir.path().join(rel);
            if let Some(parent) = p.parent() {
                std::fs::create_dir_all(parent).unwrap();
            }
            std::fs::write(p, content).unwrap();
        }
        build_graph(dir.path()).unwrap()
    }

    fn edges_of(v: &Value) -> Vec<(String, String)> {
        v["edges"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| {
                (
                    e["source"].as_str().unwrap().to_string(),
                    e["target"].as_str().unwrap().to_string(),
                )
            })
            .collect()
    }

    fn nodes_of(v: &Value) -> Vec<String> {
        v["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|n| n["id"].as_str().unwrap().to_string())
            .collect()
    }

    #[test]
    fn ts_relative_and_index_and_alias() {
        let g = graph_of(&[
            (
                "src/a.ts",
                "import { b } from './b';\nimport { c } from './sub/c';\nimport { d } from '@/d';\nimport React from 'react';\nexport function fa() {}",
            ),
            ("src/b.ts", "export const b = 1;"),
            ("src/sub/c.ts", "export const c = 1;"),
            ("src/d.ts", "export const d = 1;"),
        ]);
        let edges = edges_of(&g);
        assert!(edges.contains(&("src/a.ts".into(), "src/b.ts".into())));
        assert!(edges.contains(&("src/a.ts".into(), "src/sub/c.ts".into())));
        assert!(edges.contains(&("src/a.ts".into(), "src/d.ts".into())), "别名 @/ 应解析到 src/ 下: {edges:?}");
        // react 是外部依赖,不产生内部边
        assert_eq!(edges.iter().filter(|(s, _)| s == "src/a.ts").count(), 3);
        // 外部依赖统计
        let ext: Vec<&str> = g["stats"]["external"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| e["name"].as_str().unwrap())
            .collect();
        assert!(ext.contains(&"react"));
        // defs 计数:export function fa → 1
        let a = g["nodes"].as_array().unwrap().iter().find(|n| n["id"] == "src/a.ts").unwrap();
        assert_eq!(a["defs"].as_u64().unwrap(), 1);
    }

    #[test]
    fn ts_index_resolution() {
        let g = graph_of(&[
            ("src/app.tsx", "import { x } from './lib';"),
            ("src/lib/index.ts", "export const x = 1;"),
        ]);
        assert!(edges_of(&g).contains(&("src/app.tsx".into(), "src/lib/index.ts".into())));
    }

    #[test]
    fn python_absolute_and_relative() {
        let g = graph_of(&[
            (
                "main.py",
                "import pkg.core\nfrom pkg.util import helper\nimport numpy\n",
            ),
            ("pkg/core.py", "def run(): pass\n"),
            ("pkg/util.py", "def helper(): pass\n"),
            (
                "pkg/other.py",
                "from .util import helper\nfrom ..main import thing\n",
            ),
        ]);
        let edges = edges_of(&g);
        assert!(edges.contains(&("main.py".into(), "pkg/core.py".into())));
        assert!(edges.contains(&("main.py".into(), "pkg/util.py".into())));
        assert!(edges.contains(&("pkg/other.py".into(), "pkg/util.py".into())), "相对导入 .util: {edges:?}");
        assert!(edges.contains(&("pkg/other.py".into(), "main.py".into())), "相对导入 ..main: {edges:?}");
        let ext: Vec<&str> = g["stats"]["external"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| e["name"].as_str().unwrap())
            .collect();
        assert!(ext.contains(&"numpy"));
    }

    #[test]
    fn rust_use_crate_and_mod() {
        let g = graph_of(&[
            (
                "src/main.rs",
                "mod foo;\nuse crate::bar;\nuse serde_json::Value;\nfn main() {}\n",
            ),
            ("src/foo.rs", "pub fn f() {}\n"),
            ("src/bar.rs", "pub struct Bar;\n"),
        ]);
        let edges = edges_of(&g);
        assert!(edges.contains(&("src/main.rs".into(), "src/foo.rs".into())), "mod foo; 应解析到 src/foo.rs: {edges:?}");
        assert!(edges.contains(&("src/main.rs".into(), "src/bar.rs".into())), "use crate::bar: {edges:?}");
        // serde_json 是外部 crate,不产生内部边
        assert_eq!(edges.len(), 2);
    }

    #[test]
    fn go_module_internal() {
        let g = graph_of(&[
            ("go.mod", "module example.com/demo\n\ngo 1.22\n"),
            (
                "main.go",
                "package main\n\nimport (\n\t\"fmt\"\n\t\"example.com/demo/util\"\n)\n\nfunc main() { fmt.Println(1) }\n",
            ),
            ("util/helper.go", "package util\n\nfunc Help() {}\n"),
            (
                "other/deep.go",
                "package other\n\nimport \"golang.org/x/sync/errgroup\"\n",
            ),
        ]);
        let edges = edges_of(&g);
        assert!(
            edges.contains(&("main.go".into(), "util/helper.go".into())),
            "module 内 import 应指向目录内 go 文件: {edges:?}"
        );
        // golang.org/x/sync 是外部依赖;fmt 是标准库
        let ext: Vec<&str> = g["stats"]["external"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| e["name"].as_str().unwrap())
            .collect();
        assert!(ext.contains(&"golang.org"));
        assert!(!ext.contains(&"fmt"));
    }

    #[test]
    fn c_include_relative() {
        let g = graph_of(&[
            ("src/main.c", "#include <stdio.h>\n#include \"util.h\"\n"),
            ("src/util.h", "#define X 1\n"),
        ]);
        assert!(edges_of(&g).contains(&("src/main.c".into(), "src/util.h".into())));
    }

    #[test]
    fn skips_vendored_dirs_and_hidden() {
        let g = graph_of(&[
            ("src/a.ts", "import { x } from './b';"),
            ("node_modules/b/index.js", "export const x = 1;"),
            (".hidden/c.ts", "export const c = 1;"),
            ("src/b.ts", "export const x = 1;"),
        ]);
        let nodes = nodes_of(&g);
        assert!(!nodes.iter().any(|n| n.starts_with("node_modules/")));
        assert!(!nodes.iter().any(|n| n.starts_with(".hidden/")));
        assert!(nodes.contains(&"src/a.ts".to_string()));
        // node_modules 被跳过后 ./b 只能解析到 src/b.ts
        assert!(edges_of(&g).contains(&("src/a.ts".into(), "src/b.ts".into())));
    }

    #[test]
    fn empty_dir_gives_empty_graph() {
        let dir = tempfile::tempdir().unwrap();
        let g = build_graph(dir.path()).unwrap();
        assert_eq!(g["nodes"].as_array().unwrap().len(), 0);
        assert_eq!(g["stats"]["edges"].as_u64().unwrap(), 0);
    }
}
