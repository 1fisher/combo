//! 内置工具:read / write / search / bash / web_search + current_time / current_date。
//!
//! read/write/search/bash 需要 workspace 根目录(由 `builtin_tools` 传入);
//! web_search 支持多搜索引擎(bing/ddg,默认 bing),无需 API key。

use regex::Regex;
use rig::tool::{DynamicTool, ToolOutput};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use tokio::io::AsyncReadExt;
use tokio::process::Command;

use crate::config::LspServerConfig;
use crate::lsp::LspManager;

/// 返回内置工具列表。
/// `lsp` 配置了任意 server 时,额外注册 LSP 工具(diagnostics/definition/references/hover)。
pub fn builtin_tools(
    workspace_dir: Option<PathBuf>,
    lsp: BTreeMap<String, LspServerConfig>,
) -> Vec<DynamicTool> {
    let ws = workspace_dir.unwrap_or_else(|| PathBuf::from("."));
    let mut tools: Vec<DynamicTool> = vec![
        read_tool(ws.clone()),
        write_tool(ws.clone()),
        replace_tool(ws.clone()),
        search_tool(ws.clone()),
        grep_tool(ws.clone()),
        bash_tool(ws.clone()),
        web_search_tool(),
        current_datetime_tool(),
    ];
    // 配置了 LSP server 时注册代码导航工具,共享同一 LspManager(lazy 启动)。
    let manager = Arc::new(LspManager::new(ws.clone(), lsp));
    if manager.has_servers() {
        tools.push(lsp_diagnostics_tool(ws.clone(), manager.clone()));
        tools.push(lsp_definition_tool(ws.clone(), manager.clone()));
        tools.push(lsp_references_tool(ws.clone(), manager.clone()));
        tools.push(lsp_hover_tool(ws.clone(), manager));
    }
    tools
}

/// 返回只读内置工具集(multi-agent 只读角色用):read / search / grep /
/// web_search / current_time + LSP 工具,不含 write / replace / bash——
/// 调研/审查类子 agent 不应产生任何写副作用。
pub fn builtin_tools_readonly(
    workspace_dir: Option<PathBuf>,
    lsp: BTreeMap<String, LspServerConfig>,
) -> Vec<DynamicTool> {
    let ws = workspace_dir.unwrap_or_else(|| PathBuf::from("."));
    let mut tools: Vec<DynamicTool> = vec![
        read_tool(ws.clone()),
        search_tool(ws.clone()),
        grep_tool(ws.clone()),
        web_search_tool(),
        current_datetime_tool(),
    ];
    let manager = Arc::new(LspManager::new(ws.clone(), lsp));
    if manager.has_servers() {
        tools.push(lsp_diagnostics_tool(ws.clone(), manager.clone()));
        tools.push(lsp_definition_tool(ws.clone(), manager.clone()));
        tools.push(lsp_references_tool(ws.clone(), manager.clone()));
        tools.push(lsp_hover_tool(ws.clone(), manager));
    }
    tools
}

// ============================= read =============================

/// `read`:分页读取文件内容(带行号)。
fn read_tool(ws: PathBuf) -> DynamicTool {
    DynamicTool::new(
        "read",
        "分页读取文件内容(显示行号)。参数:path(相对 workspace 的路径),offset(起始行号,0-based,默认0),limit(最多读取行数,默认200)。返回带行号的文件内容及总行数,可用 offset 翻页。",
        json!({
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "要读取的文件路径(workspace 内相对路径)" },
                "offset": { "type": "integer", "description": "起始行号(0-based),默认 0" },
                "limit": { "type": "integer", "description": "读取的最大行数,默认 200" }
            },
            "required": ["path"]
        }),
        move |_ctx, args| {
            let ws = ws.clone();
            Box::pin(async move {
                let path = args.get("path").and_then(Value::as_str).unwrap_or("");
                let offset = args.get("offset").and_then(Value::as_u64).unwrap_or(0) as usize;
                let limit = args.get("limit").and_then(Value::as_u64).unwrap_or(200) as usize;

                if path.is_empty() {
                    return Ok(ToolOutput::text("错误: path 不能为空"));
                }

                let full = match safe_join(&ws, path) {
                    Ok(p) => p,
                    Err(e) => return Ok(ToolOutput::text(format!("路径错误: {e}"))),
                };

                if !full.exists() {
                    return Ok(ToolOutput::text(format!("文件不存在: {path}")));
                }
                if full.is_dir() {
                    return Ok(ToolOutput::text(format!("路径是目录,不是文件: {path}")));
                }

                let content = match std::fs::read(&full) {
                    Ok(c) => c,
                    Err(e) => return Ok(ToolOutput::text(format!("读取失败: {e}"))),
                };

                // 尝试 UTF-8 解码;失败则报二进制
                let text = match std::str::from_utf8(&content) {
                    Ok(s) => s,
                    Err(_) => {
                        let size = content.len();
                        return Ok(ToolOutput::text(format!(
                            "文件 {path} 是二进制文件({size} 字节),无法以文本方式读取"
                        )));
                    }
                };

                let lines: Vec<&str> = text.lines().collect();
                let total = lines.len();
                let start = offset.min(total);
                let end = (start + limit).min(total);
                let slice = &lines[start..end];

                let mut out = String::new();
                out.push_str(&format!("文件: {path}({total} 行)\n"));
                out.push_str(&format!("显示第 {}-{} 行:\n", start + 1, end));
                for (i, line) in slice.iter().enumerate() {
                    out.push_str(&format!("{:>5} │ {}\n", start + i + 1, line));
                }

                if end < total {
                    out.push_str(&format!(
                        "\n(共 {total} 行,使用 offset={end} 继续读取)"
                    ));
                }

                Ok(ToolOutput::text(out))
            })
        },
    )
}

// ============================= write =============================

/// `write`:写入文件(创建或覆盖),自动创建父目录。
fn write_tool(ws: PathBuf) -> DynamicTool {
    DynamicTool::new(
        "write",
        "写入文件(创建或覆盖已有文件)。参数:path(相对 workspace 的路径),content(完整文件内容)。自动创建父目录。",
        json!({
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "要写入的文件路径(workspace 内相对路径)" },
                "content": { "type": "string", "description": "文件完整内容" }
            },
            "required": ["path", "content"]
        }),
        move |_ctx, args| {
            let ws = ws.clone();
            Box::pin(async move {
                let path = args.get("path").and_then(Value::as_str).unwrap_or("");
                let content = args.get("content").and_then(Value::as_str).unwrap_or("");

                if path.is_empty() {
                    return Ok(ToolOutput::text("错误: path 不能为空"));
                }

                let full = match safe_join(&ws, path) {
                    Ok(p) => p,
                    Err(e) => return Ok(ToolOutput::text(format!("路径错误: {e}"))),
                };

                if let Some(parent) = full.parent() {
                    if let Err(e) = std::fs::create_dir_all(parent) {
                        return Ok(ToolOutput::text(format!("创建目录失败: {e}")));
                    }
                }

                let bytes = content.len();
                match std::fs::write(&full, content) {
                    Ok(_) => Ok(ToolOutput::text(format!(
                        "已写入 {path}({bytes} 字节)"
                    ))),
                    Err(e) => Ok(ToolOutput::text(format!("写入失败: {e}"))),
                }
            })
        },
    )
}

// ============================= replace =============================

/// `replace`:精确查找并替换文件中的文本片段(非全量写入)。
/// - 默认仅替换第一处匹配,且要求 `old_string` 在文件中唯一(多处匹配时报错)。
/// - `replace_all=true` 时替换所有匹配。
/// - `old_string` 与文件内容完全相等时报错(无需替换)。
fn replace_tool(ws: PathBuf) -> DynamicTool {
    DynamicTool::new(
        "replace",
        "精确查找并替换文件中的文本片段(不重写整个文件)。参数:path(相对 workspace 的路径),old_string(要被替换的精确文本,含空白和换行),new_string(替换后的文本),replace_all(是否替换所有匹配,默认 false)。默认仅替换唯一匹配——若 old_string 在文件中出现多次且未设 replace_all,会报错以防止误改。",
        json!({
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "要修改的文件路径(workspace 内相对路径)" },
                "old_string": { "type": "string", "description": "要被替换的精确文本(必须与文件中的内容完全一致,包括空白和换行)" },
                "new_string": { "type": "string", "description": "替换后的新文本" },
                "replace_all": { "type": "boolean", "description": "是否替换所有匹配处,默认 false(仅替换唯一匹配)" }
            },
            "required": ["path", "old_string", "new_string"]
        }),
        move |_ctx, args| {
            let ws = ws.clone();
            Box::pin(async move {
                let path = args.get("path").and_then(Value::as_str).unwrap_or("");
                let old_string = args.get("old_string").and_then(Value::as_str).unwrap_or("");
                let new_string = args.get("new_string").and_then(Value::as_str).unwrap_or("");
                let replace_all = args.get("replace_all").and_then(Value::as_bool).unwrap_or(false);

                if path.is_empty() {
                    return Ok(ToolOutput::text("错误: path 不能为空"));
                }
                if old_string.is_empty() {
                    return Ok(ToolOutput::text("错误: old_string 不能为空"));
                }

                let full = match safe_join(&ws, path) {
                    Ok(p) => p,
                    Err(e) => return Ok(ToolOutput::text(format!("路径错误: {e}"))),
                };

                if !full.exists() {
                    return Ok(ToolOutput::text(format!("文件不存在: {path}")));
                }
                if full.is_dir() {
                    return Ok(ToolOutput::text(format!("路径是目录,不是文件: {path}")));
                }

                let content = match std::fs::read_to_string(&full) {
                    Ok(c) => c,
                    Err(e) => return Ok(ToolOutput::text(format!("读取失败(可能是二进制文件): {e}"))),
                };

                // 统计匹配次数
                let match_count = content.matches(old_string).count();
                if match_count == 0 {
                    return Ok(ToolOutput::text(
                        "未找到匹配:old_string 在文件中不存在。请确认 old_string 与文件内容完全一致(包括缩进和换行)。",
                    ));
                }

                if !replace_all && match_count > 1 {
                    return Ok(ToolOutput::text(format!(
                        "old_string 在文件中出现 {match_count} 次。如需替换所有匹配请设置 replace_all=true;否则请在 old_string 中加入更多上下文使其唯一。"
                    )));
                }

                let new_content = if replace_all {
                    content.replace(old_string, new_string)
                } else {
                    content.replacen(old_string, new_string, 1)
                };

                match std::fs::write(&full, &new_content) {
                    Ok(_) => {
                        let replaced = if replace_all { match_count } else { 1 };
                        Ok(ToolOutput::text(format!(
                            "已替换 {path} 中的 {replaced} 处匹配"
                        )))
                    }
                    Err(e) => Ok(ToolOutput::text(format!("写入失败: {e}"))),
                }
            })
        },
    )
}

// ============================= search =============================

/// `search`:在 workspace 文件中搜索文本或正则表达式。
fn search_tool(ws: PathBuf) -> DynamicTool {
    DynamicTool::new(
        "search",
        "在 workspace 文件中搜索文本或正则表达式(类似 grep)。参数:pattern(搜索模式),path(搜索子目录,默认 workspace 根),include(文件名 glob 过滤,如 *.rs),literal(字面量搜索,默认 false)。",
        json!({
            "type": "object",
            "properties": {
                "pattern": { "type": "string", "description": "搜索模式(正则表达式或字面量文本)" },
                "path": { "type": "string", "description": "搜索的子目录(相对路径),默认 workspace 根" },
                "include": { "type": "string", "description": "文件名 glob 过滤(如 *.rs),默认所有文件" },
                "literal": { "type": "boolean", "description": "将 pattern 视为字面量文本而非正则,默认 false" }
            },
            "required": ["pattern"]
        }),
        move |_ctx, args| {
            let ws = ws.clone();
            Box::pin(async move {
                let pattern = args.get("pattern").and_then(Value::as_str).unwrap_or("");
                let sub_path = args.get("path").and_then(Value::as_str).unwrap_or(".");
                let include = args.get("include").and_then(Value::as_str);
                let literal = args.get("literal").and_then(Value::as_bool).unwrap_or(false);

                if pattern.is_empty() {
                    return Ok(ToolOutput::text("错误: pattern 不能为空"));
                }

                let search_root = match safe_join(&ws, sub_path) {
                    Ok(p) => p,
                    Err(e) => return Ok(ToolOutput::text(format!("路径错误: {e}"))),
                };

                if !search_root.exists() {
                    return Ok(ToolOutput::text(format!("搜索路径不存在: {sub_path}")));
                }

                let re = {
                    let pat = if literal {
                        regex::escape(pattern)
                    } else {
                        pattern.to_string()
                    };
                    match Regex::new(&pat) {
                        Ok(r) => r,
                        Err(e) => {
                            return Ok(ToolOutput::text(format!(
                                "正则表达式错误: {e}"
                            )))
                        }
                    }
                };

                let glob_pat = include.and_then(|g| glob::Pattern::new(g).ok());

                let mut results: Vec<String> = Vec::new();
                let mut total = 0usize;
                const MAX_RESULTS: usize = 50;
                const MAX_FILE_SIZE: u64 = 1024 * 1024;

                for entry in walkdir::WalkDir::new(&search_root)
                    .into_iter()
                    .filter_entry(|e| {
                        if e.depth() == 0 {
                            return true;
                        }
                        if e.file_type().is_dir() {
                            let name = e.file_name().to_string_lossy();
                            return !should_skip_dir(&name);
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
                    if is_binary_ext(&name) {
                        continue;
                    }

                    if let Some(ref gp) = glob_pat {
                        if !gp.matches(&name) {
                            continue;
                        }
                    }

                    if entry
                        .metadata()
                        .map(|m| m.len() > MAX_FILE_SIZE)
                        .unwrap_or(true)
                    {
                        continue;
                    }

                    let fpath = entry.path();
                    let content = match std::fs::read_to_string(fpath) {
                        Ok(c) => c,
                        Err(_) => continue,
                    };

                    let rel = fpath
                        .strip_prefix(&ws)
                        .unwrap_or(fpath)
                        .to_string_lossy()
                        .to_string();

                    for (lineno, line) in content.lines().enumerate() {
                        if re.is_match(line) {
                            results.push(format!("{}:{}: {}", rel, lineno + 1, line.trim()));
                            total += 1;
                            if total >= MAX_RESULTS {
                                break;
                            }
                        }
                    }
                    if total >= MAX_RESULTS {
                        break;
                    }
                }

                if results.is_empty() {
                    Ok(ToolOutput::text(format!(
                        "未找到匹配 \"{pattern}\" 的结果"
                    )))
                } else {
                    let mut out = format!("找到 {total} 个匹配结果:\n\n");
                    out.push_str(&results.join("\n"));
                    if total >= MAX_RESULTS {
                        out.push_str(&format!(
                            "\n\n(结果过多,仅显示前 {MAX_RESULTS} 个)"
                        ));
                    }
                    Ok(ToolOutput::text(out))
                }
            })
        },
    )
}

// ============================= grep =============================

/// `grep`:在代码库中快速搜索文本或正则表达式,默认使用 ripgrep (rg)。
/// rg 不可用时回退到内置 walkdir 搜索。
fn grep_tool(ws: PathBuf) -> DynamicTool {
    DynamicTool::new(
        "grep",
        "在代码库中快速搜索文本或正则表达式,默认使用 ripgrep (rg) 工具(速度极快,自动遵循 .gitignore 并跳过二进制/隐藏文件)。rg 未安装时自动回退为内置逐文件搜索。参数:pattern(搜索模式),path(搜索子目录,默认 workspace 根),include(文件名 glob 过滤,如 *.rs),exclude(排除的 glob,如 *.lock),literal(字面量搜索,默认 false),case_insensitive(大小写不敏感,默认 false),context(匹配行前后显示的上下文行数,默认 0),max_results(最大返回匹配数,默认 50)。",
        json!({
            "type": "object",
            "properties": {
                "pattern": { "type": "string", "description": "搜索模式(正则表达式或字面量文本)" },
                "path": { "type": "string", "description": "搜索的子目录(workspace 内相对路径),默认 workspace 根" },
                "include": { "type": "string", "description": "文件名 glob 过滤(如 *.rs),默认所有文件" },
                "exclude": { "type": "string", "description": "排除的文件名 glob(如 *.lock、*.test.ts)" },
                "literal": { "type": "boolean", "description": "将 pattern 视为字面量文本而非正则,默认 false" },
                "case_insensitive": { "type": "boolean", "description": "大小写不敏感匹配,默认 false" },
                "context": { "type": "integer", "description": "匹配行前后显示的上下文行数,默认 0(仅显示匹配行)" },
                "max_results": { "type": "integer", "description": "最大返回匹配结果数,默认 50" }
            },
            "required": ["pattern"]
        }),
        move |_ctx, args| {
            let ws = ws.clone();
            Box::pin(async move {
                let pattern = args.get("pattern").and_then(Value::as_str).unwrap_or("");
                let sub_path = args.get("path").and_then(Value::as_str).unwrap_or(".");
                let include = args.get("include").and_then(Value::as_str);
                let exclude = args.get("exclude").and_then(Value::as_str);
                let literal = args.get("literal").and_then(Value::as_bool).unwrap_or(false);
                let case_insensitive = args
                    .get("case_insensitive")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                let context = args.get("context").and_then(Value::as_u64).unwrap_or(0) as usize;
                let max_results = args
                    .get("max_results")
                    .and_then(Value::as_u64)
                    .unwrap_or(50) as usize;

                if pattern.is_empty() {
                    return Ok(ToolOutput::text("错误: pattern 不能为空"));
                }

                // 安全校验路径
                if let Err(e) = safe_join(&ws, sub_path) {
                    return Ok(ToolOutput::text(format!("路径错误: {e}")));
                }

                // 优先尝试 ripgrep
                match run_ripgrep(
                    pattern,
                    sub_path,
                    &ws,
                    include,
                    exclude,
                    literal,
                    case_insensitive,
                    context,
                    max_results,
                )
                .await
                {
                    Ok(Some(text)) => return Ok(ToolOutput::text(text)),
                    Ok(None) => {} // rg 不可用,继续走回退
                    Err(e) => return Ok(ToolOutput::text(format!("grep 执行错误: {e}"))),
                }

                // 回退:内置 walkdir 搜索
                let results = fallback_search(
                    &ws,
                    sub_path,
                    pattern,
                    include,
                    exclude,
                    literal,
                    case_insensitive,
                    max_results,
                );
                if results.is_empty() {
                    Ok(ToolOutput::text(format!(
                        "未找到匹配 \"{pattern}\" 的结果"
                    )))
                } else {
                    let count = results.len();
                    let mut out =
                        format!("找到 {count} 个匹配结果(内置搜索,ripgrep 未安装):\n\n");
                    out.push_str(&results.join("\n"));
                    if count >= max_results {
                        out.push_str(&format!(
                            "\n\n(结果过多,仅显示前 {max_results} 个)"
                        ));
                    }
                    Ok(ToolOutput::text(out))
                }
            })
        },
    )
}

/// 执行 ripgrep 搜索。返回 `Ok(Some(text))` 表示 rg 已运行(无论有无匹配),
/// 返回 `Ok(None)` 表示系统未安装 rg,返回 `Err` 表示 rg 执行出错。
async fn run_ripgrep(
    pattern: &str,
    rel_path: &str,
    cwd: &Path,
    include: Option<&str>,
    exclude: Option<&str>,
    literal: bool,
    case_insensitive: bool,
    context: usize,
    max_results: usize,
) -> anyhow::Result<Option<String>> {
    // 先解析 rg(PATH + 常见安装目录,GUI 进程 PATH 不含 homebrew 也能找到)
    let Some(rg) = crate::binpath::resolve_rg() else {
        return Ok(None);
    };
    let mut cmd = Command::new(rg);
    cmd.current_dir(cwd)
        .arg("--line-number")
        .arg("--no-heading")
        .arg("--with-filename")
        .arg("--color")
        .arg("never")
        .arg("--max-filesize")
        .arg("1M");

    // 每文件最多 max_results 个匹配,避免大文件刷屏
    let per_file = max_results.min(200);
    cmd.arg("-m").arg(per_file.to_string());

    if literal {
        cmd.arg("--fixed-strings");
    }
    if case_insensitive {
        cmd.arg("--ignore-case");
    }
    if context > 0 {
        cmd.arg("-C").arg(context.to_string());
    }
    if let Some(glob) = include {
        cmd.arg("--glob").arg(glob);
    }
    if let Some(glob) = exclude {
        cmd.arg("--glob").arg(format!("!{glob}"));
    }

    cmd.arg("--").arg(pattern).arg(rel_path);

    cmd.stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .stdin(std::process::Stdio::null());

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.into()),
    };

    let timeout = std::time::Duration::from_secs(30);
    let status = match tokio::time::timeout(timeout, child.wait()).await {
        Ok(Ok(s)) => s,
        Ok(Err(e)) => return Err(e.into()),
        Err(_) => {
            let _ = child.kill().await;
            anyhow::bail!("grep 超时(30 秒)");
        }
    };

    let mut stdout = String::new();
    child
        .stdout
        .take()
        .unwrap()
        .read_to_string(&mut stdout)
        .await?;
    let mut stderr = String::new();
    child
        .stderr
        .take()
        .unwrap()
        .read_to_string(&mut stderr)
        .await?;

    // rg 退出码:0 = 有匹配,1 = 无匹配,2 = 错误
    if status.code() == Some(2) {
        let msg = if stderr.is_empty() {
            "ripgrep 执行出错".to_string()
        } else {
            stderr.trim().to_string()
        };
        anyhow::bail!("{msg}");
    }

    // 解析并截断输出
    let context_multiplier = (1 + 2 * context).max(1);
    let line_cap = max_results * context_multiplier;

    let lines: Vec<&str> = stdout
        .lines()
        .filter(|l| !l.is_empty() && *l != "--")
        .take(line_cap)
        .collect();

    let total_raw: usize = stdout
        .lines()
        .filter(|l| !l.is_empty() && *l != "--")
        .count();
    let truncated = total_raw > line_cap;
    let shown = lines.len();

    let text = if shown == 0 {
        format!("未找到匹配 \"{pattern}\" 的结果")
    } else {
        let label = if context > 0 {
            format!("找到 {shown} 行结果(含上下文,ripgrep)")
        } else {
            format!("找到 {shown} 个匹配(ripgrep)")
        };
        let mut out = format!("{label}\n\n");
        out.push_str(&lines.join("\n"));
        if truncated {
            out.push_str(&format!("\n\n(结果过多,仅显示前 {shown} 行)"));
        }
        out
    };

    Ok(Some(text))
}

/// 内置 walkdir 搜索(rg 不可用时的回退)。
fn fallback_search(
    ws: &Path,
    sub_path: &str,
    pattern: &str,
    include: Option<&str>,
    exclude: Option<&str>,
    literal: bool,
    case_insensitive: bool,
    max_results: usize,
) -> Vec<String> {
    let search_root = match safe_join(ws, sub_path) {
        Ok(p) => p,
        Err(_) => return Vec::new(),
    };

    if !search_root.exists() {
        return Vec::new();
    }

    let re = {
        let pat = if literal {
            regex::escape(pattern)
        } else {
            pattern.to_string()
        };
        let pat = if case_insensitive {
            format!("(?i){pat}")
        } else {
            pat
        };
        match Regex::new(&pat) {
            Ok(r) => r,
            Err(_) => return Vec::new(),
        }
    };

    let include_pat = include.and_then(|g| glob::Pattern::new(g).ok());
    let exclude_pat = exclude.and_then(|g| glob::Pattern::new(g).ok());

    let mut results = Vec::new();
    const MAX_FILE_SIZE: u64 = 1024 * 1024;

    for entry in walkdir::WalkDir::new(&search_root)
        .into_iter()
        .filter_entry(|e| {
            if e.depth() == 0 {
                return true;
            }
            if e.file_type().is_dir() {
                let name = e.file_name().to_string_lossy();
                return !should_skip_dir(&name);
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
        if is_binary_ext(&name) {
            continue;
        }

        if let Some(ref gp) = include_pat {
            if !gp.matches(&name) {
                continue;
            }
        }
        if let Some(ref ep) = exclude_pat {
            if ep.matches(&name) {
                continue;
            }
        }

        if entry
            .metadata()
            .map(|m| m.len() > MAX_FILE_SIZE)
            .unwrap_or(true)
        {
            continue;
        }

        let fpath = entry.path();
        let content = match std::fs::read_to_string(fpath) {
            Ok(c) => c,
            Err(_) => continue,
        };

        let rel = fpath
            .strip_prefix(ws)
            .unwrap_or(fpath)
            .to_string_lossy()
            .to_string();

        for (lineno, line) in content.lines().enumerate() {
            if re.is_match(line) {
                results.push(format!("{}:{}: {}", rel, lineno + 1, line.trim()));
                if results.len() >= max_results {
                    return results;
                }
            }
        }
    }

    results
}

// ============================= bash =============================

/// `bash`:在 workspace 根目录执行终端命令(shell 命令)。
fn bash_tool(ws: PathBuf) -> DynamicTool {
    DynamicTool::new(
        "bash",
        "在 workspace 根目录执行终端命令(shell 命令),返回标准输出与标准错误。参数:command(要执行的完整命令,支持管道/重定向/多命令),timeout(超时秒数,默认30,超时后进程会被终止)。注意:命令在 workspace 目录下运行,每次调用都是独立的新 shell,不保留上次的 cd 或环境变量。",
        json!({
            "type": "object",
            "properties": {
                "command": { "type": "string", "description": "要执行的完整 shell 命令" },
                "timeout": { "type": "integer", "description": "超时秒数,默认 30,最大 300" }
            },
            "required": ["command"]
        }),
        move |_ctx, args| {
            let ws = ws.clone();
            Box::pin(async move {
                let command = args.get("command").and_then(Value::as_str).unwrap_or("");
                let timeout = args
                    .get("timeout")
                    .and_then(Value::as_u64)
                    .unwrap_or(30)
                    .clamp(1, 300);

                if command.trim().is_empty() {
                    return Ok(ToolOutput::text("错误: command 不能为空"));
                }

                let started = std::time::Instant::now();
                match run_bash_command(command, &ws, timeout).await {
                    Ok(output) => Ok(bash_output_envelope(
                        &output,
                        started.elapsed().as_millis() as u64,
                    )),
                    Err(e) => Ok(ToolOutput::text(format!("命令执行失败: {e}"))),
                }
            })
        },
    )
}

/// bash 执行结果。
struct BashOutput {
    stdout: String,
    stderr: String,
    code: Option<i32>,
    timed_out: bool,
}

/// 把 bash 执行结果组装成结构化工具输出:内容与状态字段分离。
/// 完成/失败/超时不再拼进输出文本,由 agent 解析字段、serve 标记到
/// tool_result 消息项(前端据此在卡片上直接展示状态)。
fn bash_output_envelope(output: &BashOutput, duration_ms: u64) -> ToolOutput {
    let mut out = String::new();
    if !output.stdout.is_empty() {
        out.push_str(&output.stdout);
    }
    if !output.stderr.is_empty() {
        if !output.stdout.is_empty() {
            out.push_str("\n");
        }
        out.push_str(&output.stderr);
    }
    ToolOutput::json(json!({
        "content": out,
        "exit_code": output.code,
        "timed_out": output.timed_out,
        "duration_ms": duration_ms,
    }))
}

/// 实际执行命令:选择 shell(Unix 用 $SHELL 或 /bin/sh,Windows 用 cmd.exe),
/// 在 `cwd` 目录下运行,合并捕获 stdout/stderr,超时后杀死进程树。
async fn run_bash_command(
    command: &str,
    cwd: &Path,
    timeout_secs: u64,
) -> anyhow::Result<BashOutput> {
    let mut cmd = if cfg!(target_os = "windows") {
        let mut c = Command::new("cmd.exe");
        c.arg("/C").arg(command);
        c
    } else {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
        let mut c = Command::new(&shell);
        c.arg("-lc").arg(command); // login shell,保证 PATH 等已加载
        c
    };
    cmd.current_dir(cwd);
    // PATH 统一经 spawn_path_for 补全(命令所在目录 + 登录 shell PATH + 常见
    // 安装目录兜底):GUI/launchd 启动的进程 PATH 只有系统目录,agent 执行
    // npm/node 等会 command not found;登录 shell 探测有缓存,仅首次多一次
    // $SHELL -ilc。PATH 不再原样透传进程环境,与 LSP 安装命令同一口径。
    let env_path = tokio::task::spawn_blocking(|| crate::lsp::spawn_path_for(None))
        .await
        .unwrap_or_default();
    if !env_path.is_empty() {
        cmd.env("PATH", env_path);
    }
    for key in &["HOME", "USER", "LANG", "LC_ALL", "LC_CTYPE"] {
        if let Ok(val) = std::env::var(key) {
            cmd.env(key, val);
        }
    }

    let mut child = cmd
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .stdin(std::process::Stdio::null())
        .spawn()?;

    let mut stdout = child.stdout.take().expect("stdout 管道已请求");
    let mut stderr = child.stderr.take().expect("stderr 管道已请求");
    let read_stdout = tokio::spawn(async move {
        let mut buf = Vec::new();
        let _ = (&mut stdout).read_to_end(&mut buf).await;
        buf
    });
    let read_stderr = tokio::spawn(async move {
        let mut buf = Vec::new();
        let _ = (&mut stderr).read_to_end(&mut buf).await;
        buf
    });

    let timeout = std::time::Duration::from_secs(timeout_secs);
    let status = match tokio::time::timeout(timeout, child.wait()).await {
        Ok(Ok(s)) => Some(s),
        Ok(Err(e)) => return Err(e.into()),
        Err(_) => {
            // 超时:终止进程并回收,避免僵尸进程
            let _ = child.kill().await;
            let _ = child.wait().await;
            None
        }
    };

    let (stdout_bytes, stderr_bytes) = match tokio::join!(read_stdout, read_stderr) {
        (Ok(a), Ok(b)) => (a, b),
        _ => (Vec::new(), Vec::new()),
    };

    let timed_out = status.is_none();
    let code = status.as_ref().and_then(|s| s.code());

    const MAX_OUTPUT: usize = 30_000;
    let truncate = |bytes: Vec<u8>| -> String {
        let s = String::from_utf8_lossy(&bytes).to_string();
        if s.chars().count() > MAX_OUTPUT {
            let cut = s
                .char_indices()
                .nth(MAX_OUTPUT)
                .map(|(i, _)| i)
                .unwrap_or(s.len());
            format!("{}…(输出过长,已截断 {} 字符)", &s[..cut], s.chars().count() - MAX_OUTPUT)
        } else {
            s
        }
    };

    Ok(BashOutput {
        stdout: truncate(stdout_bytes),
        stderr: truncate(stderr_bytes),
        code,
        timed_out,
    })
}

// ============================= web_search =============================

/// `web_search`:网络搜索,支持多引擎(bing/ddg,默认 bing)。
fn web_search_tool() -> DynamicTool {
    DynamicTool::new(
        "web_search",
        "网络搜索:使用搜索引擎查找信息,返回结果的标题、链接和摘要。参数:query(搜索关键词),max_results(结果数量上限,默认5),engine(搜索引擎:bing/ddg,默认bing)。",
        json!({
            "type": "object",
            "properties": {
                "query": { "type": "string", "description": "搜索关键词" },
                "max_results": { "type": "integer", "description": "返回结果数量上限,默认 5" },
                "engine": {
                    "type": "string",
                    "description": "搜索引擎:bing/ddg,默认 bing",
                    "enum": ["bing", "ddg", "duckduckgo"]
                }
            },
            "required": ["query"]
        }),
        move |_ctx, args| {
            Box::pin(async move {
                let query = args.get("query").and_then(Value::as_str).unwrap_or("");
                let max_results =
                    args.get("max_results").and_then(Value::as_u64).unwrap_or(5) as usize;
                let engine = args.get("engine").and_then(Value::as_str).unwrap_or("bing");

                if query.is_empty() {
                    return Ok(ToolOutput::text("错误: query 不能为空"));
                }

                let results = match engine {
                    "bing" => web_search_bing(query, max_results).await,
                    "ddg" | "duckduckgo" => web_search_ddg(query, max_results).await,
                    _ => web_search_bing(query, max_results).await,
                };

                match results {
                    Ok(results) => {
                        if results.is_empty() {
                            Ok(ToolOutput::text(format!(
                                "未找到 \"{query}\" 的搜索结果"
                            )))
                        } else {
                            let mut out = format!("搜索 \"{query}\" 的结果(引擎:{engine}):\n\n");
                            for (i, r) in results.iter().enumerate() {
                                out.push_str(&format!(
                                    "{}. {}\n   🔗 {}\n   {}\n\n",
                                    i + 1,
                                    r.title,
                                    r.url,
                                    r.snippet
                                ));
                            }
                            Ok(ToolOutput::text(out))
                        }
                    }
                    Err(e) => Ok(ToolOutput::text(format!("网络搜索失败: {e}"))),
                }
            })
        },
    )
}

struct WebResult {
    title: String,
    url: String,
    snippet: String,
}


/// 使用 Bing 搜索。
async fn web_search_bing(query: &str, max_results: usize) -> anyhow::Result<Vec<WebResult>> {
    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")
        .timeout(std::time::Duration::from_secs(15))
        .build()?;

    let url = format!(
        "https://www.bing.com/search?q={}&setlang=zh-CN",
        url_encode_query(query)
    );
    let resp = client.get(&url).send().await?;
    if !resp.status().is_success() {
        anyhow::bail!("Bing 返回状态码: {}", resp.status());
    }

    let html = resp.text().await?;
    Ok(parse_bing_html(&html, max_results))
}

/// 解析 Bing 搜索结果页。
fn parse_bing_html(html: &str, max_results: usize) -> Vec<WebResult> {
    let tag_re = Regex::new(r"<[^>]+>").unwrap();
    // 结果块:li.b_algo
    let block_re = Regex::new(r#"(?s)<li class="b_algo"[^>]*>(.*?)</li>"#).unwrap();
    let title_re =
        Regex::new(r#"(?s)<h2[^>]*>.*?<a[^>]*href="([^"]+)"[^>]*>(.*?)</a>"#).unwrap();
    let snippet_re = Regex::new(r#"(?s)<p[^>]*>(.*?)</p>"#).unwrap();

    let mut results = Vec::new();
    for cap in block_re.captures_iter(html) {
        let block = &cap[1];
        let Some(title_cap) = title_re.captures(block) else {
            continue;
        };
        let title = strip_tags(&title_cap[2], &tag_re);
        if title.is_empty() {
            continue;
        }
        let snippet = snippet_re
            .captures(block)
            .map(|c| strip_tags(&c[1], &tag_re))
            .unwrap_or_default();
        results.push(WebResult {
            title,
            url: title_cap[1].to_string(),
            snippet,
        });
        if results.len() >= max_results {
            break;
        }
    }
    results
}

/// 使用 DuckDuckGo HTML 端点搜索。
async fn web_search_ddg(query: &str, max_results: usize) -> anyhow::Result<Vec<WebResult>> {
    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0")
        .timeout(std::time::Duration::from_secs(15))
        .build()?;

    let encoded = url_encode_query(query);
    let url = format!("https://html.duckduckgo.com/html/?q={encoded}");
    let resp = client.get(&url).send().await?;

    if !resp.status().is_success() {
        anyhow::bail!("DuckDuckGo 返回状态码: {}", resp.status());
    }

    let html = resp.text().await?;
    Ok(parse_ddg_html(&html, max_results))
}

/// 简单 URL 编码(用于查询参数)。
fn url_encode_query(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char);
            }
            b' ' => out.push('+'),
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

/// 解析 DuckDuckGo HTML 结果页。
fn parse_ddg_html(html: &str, max_results: usize) -> Vec<WebResult> {
    let tag_re = Regex::new(r"<[^>]+>").unwrap();
    let link_re =
        Regex::new(r#"(?s)<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>(.*?)</a>"#).unwrap();
    let snippet_re =
        Regex::new(r#"(?s)<a[^>]*class="result__snippet"[^>]*>(.*?)</a>"#).unwrap();

    let links: Vec<(String, String)> = link_re
        .captures_iter(html)
        .map(|cap| {
            let href = cap[1].to_string();
            let title = strip_tags(&cap[2], &tag_re);
            let url = extract_ddg_url(&href);
            (title, url)
        })
        .collect();

    let snippets: Vec<String> = snippet_re
        .captures_iter(html)
        .map(|cap| strip_tags(&cap[1], &tag_re))
        .collect();

    links
        .into_iter()
        .enumerate()
        .map(|(i, (title, url))| {
            let snippet = snippets.get(i).cloned().unwrap_or_default();
            WebResult {
                title,
                url,
                snippet,
            }
        })
        .take(max_results)
        .collect()
}

fn strip_tags(html: &str, tag_re: &Regex) -> String {
    let text = tag_re.replace_all(html, "");
    text.trim()
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#x27;", "'")
        .replace("&#39;", "'")
        .replace("&nbsp;", " ")
        .replace("&ensp;", " ")
        .replace("&emsp;", " ")
        .replace("&#0183;", "·")
}

/// 从 DuckDuckGo 重定向链接中提取实际 URL。
fn extract_ddg_url(href: &str) -> String {
    // DuckDuckGo wraps: //duckduckgo.com/l/?uddg=<encoded>&rut=...
    if let Some(pos) = href.find("uddg=") {
        let rest = &href[pos + 5..];
        let end = rest.find('&').unwrap_or(rest.len());
        let encoded = &rest[..end];
        return percent_decode(encoded);
    }
    if href.starts_with("//") {
        return format!("https:{href}");
    }
    href.to_string()
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut result: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(h), Some(l)) = (hex_digit(bytes[i + 1]), hex_digit(bytes[i + 2])) {
                result.push(h * 16 + l);
                i += 3;
                continue;
            }
        }
        if bytes[i] == b'+' {
            result.push(b' ');
            i += 1;
            continue;
        }
        result.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&result).to_string()
}

fn hex_digit(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

// ============================= 辅助函数 =============================

/// 在 workspace 根内安全拼接相对路径(拒绝 `..`、绝对路径)。
fn safe_join(root: &Path, rel: &str) -> anyhow::Result<PathBuf> {
    let mut clean = PathBuf::new();
    for comp in Path::new(rel).components() {
        match comp {
            Component::Normal(p) => clean.push(p),
            Component::CurDir => {}
            Component::ParentDir => anyhow::bail!("不允许访问上级目录 (..)"),
            Component::RootDir | Component::Prefix(_) => anyhow::bail!("不允许绝对路径"),
        }
    }
    Ok(root.join(clean))
}

/// 判断文件扩展名是否为二进制(搜索时跳过)。
fn is_binary_ext(name: &str) -> bool {
    let ext = name
        .rsplit_once('.')
        .map(|(_, e)| e.to_lowercase())
        .unwrap_or_default();
    matches!(
        ext.as_str(),
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "ico" | "pdf"
            | "zip" | "tar" | "gz" | "bz2" | "7z" | "rar" | "xz" | "tgz"
            | "mp3" | "mp4" | "avi" | "mov" | "wav" | "flac" | "mkv"
            | "exe" | "dll" | "so" | "dylib" | "bin" | "o" | "a" | "lib"
            | "class" | "jar" | "war" | "wasm"
            | "ttf" | "otf" | "woff" | "woff2" | "eot"
            | "db" | "sqlite" | "sqlite3" | "lock"
    )
}

/// 搜索时应跳过的目录名。
fn should_skip_dir(name: &str) -> bool {
    if name.starts_with('.') {
        return true;
    }
    matches!(
        name,
        "node_modules"
            | "target"
            | "dist"
            | "build"
            | "__pycache__"
            | ".venv"
            | "venv"
            | ".next"
            | ".nuxt"
            | ".gradle"
            | ".idea"
            | "vendor"
            | "Pods"
    )
}

// ============================= 时间工具 =============================

/// `current_datetime`:返回当前本地日期和时间。
fn current_datetime_tool() -> DynamicTool {
    DynamicTool::new(
        "current_datetime",
        "获取当前本地日期和时间(YYYY-MM-DD HH:MM:SS)。当你需要知道今天几号或现在几点时使用。",
        json!({
            "type": "object",
            "properties": {}
        }),
        |_context, _args| {
            Box::pin(async move {
                use chrono::Local;
                let now = Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
                Ok(ToolOutput::text(format!("当前日期时间:{now}")))
            })
        },
    )
}

// ============================= LSP =============================

/// 解析 path 参数为 workspace 内绝对路径。
fn resolve_ws_path(ws: &Path, path: &str) -> Result<PathBuf, String> {
    if path.is_empty() {
        return Err("错误: path 不能为空".into());
    }
    safe_join(ws, path).map_err(|e| format!("路径错误: {e}"))
}

/// 取文件扩展名(小写,不含 `.`)。
fn ext_of(path: &Path) -> String {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default()
}

/// `diagnostics`:获取文件的 LSP 诊断(错误/警告)。
fn lsp_diagnostics_tool(ws: PathBuf, manager: Arc<LspManager>) -> DynamicTool {
    DynamicTool::new(
        "diagnostics",
        "获取文件的代码诊断(编译错误、类型错误、警告等)。需要配置 LSP server([lsp])。参数:path(相对 workspace 的文件路径)。",
        json!({
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "要诊断的文件路径(workspace 内相对路径)" }
            },
            "required": ["path"]
        }),
        move |_ctx, args| {
            let ws = ws.clone();
            let manager = manager.clone();
            Box::pin(async move {
                let path = args.get("path").and_then(Value::as_str).unwrap_or("");
                let full = match resolve_ws_path(&ws, path) {
                    Ok(p) => p,
                    Err(e) => return Ok(ToolOutput::text(e)),
                };
                let ext = ext_of(&full);
                match manager.diagnostics(&full, &ext).await {
                    Ok(s) => Ok(ToolOutput::text(s)),
                    Err(e) => Ok(ToolOutput::text(format!("LSP 诊断失败: {e}"))),
                }
            })
        },
    )
}

/// `definition`:跳转到符号定义位置。
fn lsp_definition_tool(ws: PathBuf, manager: Arc<LspManager>) -> DynamicTool {
    DynamicTool::new(
        "definition",
        "跳转到符号的定义位置。需要配置 LSP server([lsp])。参数:path、line(1-based 行号)、column(1-based 列号)。",
        json!({
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "文件路径(workspace 内相对路径)" },
                "line": { "type": "integer", "description": "行号(1-based)" },
                "column": { "type": "integer", "description": "列号(1-based)" }
            },
            "required": ["path", "line", "column"]
        }),
        move |_ctx, args| {
            let ws = ws.clone();
            let manager = manager.clone();
            Box::pin(async move {
                let (full, line, col) = match parse_loc_args(&ws, &args) {
                    Ok(v) => v,
                    Err(e) => return Ok(ToolOutput::text(e)),
                };
                let ext = ext_of(&full);
                match manager.definition(&full, &ext, line.saturating_sub(1), col.saturating_sub(1)).await {
                    Ok(s) => Ok(ToolOutput::text(s)),
                    Err(e) => Ok(ToolOutput::text(format!("LSP 定义查询失败: {e}"))),
                }
            })
        },
    )
}

/// `references`:查找符号的所有引用位置。
fn lsp_references_tool(ws: PathBuf, manager: Arc<LspManager>) -> DynamicTool {
    DynamicTool::new(
        "references",
        "查找符号的所有引用位置。需要配置 LSP server([lsp])。参数:path、line(1-based 行号)、column(1-based 列号)。",
        json!({
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "文件路径(workspace 内相对路径)" },
                "line": { "type": "integer", "description": "行号(1-based)" },
                "column": { "type": "integer", "description": "列号(1-based)" }
            },
            "required": ["path", "line", "column"]
        }),
        move |_ctx, args| {
            let ws = ws.clone();
            let manager = manager.clone();
            Box::pin(async move {
                let (full, line, col) = match parse_loc_args(&ws, &args) {
                    Ok(v) => v,
                    Err(e) => return Ok(ToolOutput::text(e)),
                };
                let ext = ext_of(&full);
                match manager.references(&full, &ext, line.saturating_sub(1), col.saturating_sub(1)).await {
                    Ok(s) => Ok(ToolOutput::text(s)),
                    Err(e) => Ok(ToolOutput::text(format!("LSP 引用查询失败: {e}"))),
                }
            })
        },
    )
}

/// `hover`:获取符号的悬停文档(类型签名/文档)。
fn lsp_hover_tool(ws: PathBuf, manager: Arc<LspManager>) -> DynamicTool {
    DynamicTool::new(
        "hover",
        "获取符号的悬停信息(类型签名、文档)。需要配置 LSP server([lsp])。参数:path、line(1-based 行号)、column(1-based 列号)。",
        json!({
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "文件路径(workspace 内相对路径)" },
                "line": { "type": "integer", "description": "行号(1-based)" },
                "column": { "type": "integer", "description": "列号(1-based)" }
            },
            "required": ["path", "line", "column"]
        }),
        move |_ctx, args| {
            let ws = ws.clone();
            let manager = manager.clone();
            Box::pin(async move {
                let (full, line, col) = match parse_loc_args(&ws, &args) {
                    Ok(v) => v,
                    Err(e) => return Ok(ToolOutput::text(e)),
                };
                let ext = ext_of(&full);
                match manager.hover(&full, &ext, line.saturating_sub(1), col.saturating_sub(1)).await {
                    Ok(s) => Ok(ToolOutput::text(s)),
                    Err(e) => Ok(ToolOutput::text(format!("LSP hover 失败: {e}"))),
                }
            })
        },
    )
}

/// 从工具参数解析 (绝对路径, line, column)。
fn parse_loc_args(ws: &Path, args: &Value) -> Result<(PathBuf, u32, u32), String> {
    let path = args.get("path").and_then(Value::as_str).unwrap_or("");
    let full = resolve_ws_path(ws, path)?;
    let line = args.get("line").and_then(Value::as_u64).unwrap_or(0) as u32;
    let col = args.get("column").and_then(Value::as_u64).unwrap_or(0) as u32;
    if line == 0 || col == 0 {
        return Err("错误: line 和 column 必须是 ≥ 1 的正整数".into());
    }
    Ok((full, line, col))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_join_rejects_dotdot() {
        let root = PathBuf::from("/tmp/ws");
        assert!(safe_join(&root, "../etc/passwd").is_err());
    }

    #[test]
    fn safe_join_rejects_absolute() {
        let root = PathBuf::from("/tmp/ws");
        assert!(safe_join(&root, "/etc/passwd").is_err());
    }

    #[test]
    fn safe_join_normal() {
        let root = PathBuf::from("/tmp/ws");
        let p = safe_join(&root, "src/main.rs").unwrap();
        assert_eq!(p, PathBuf::from("/tmp/ws/src/main.rs"));
    }

    #[test]
    fn extract_ddg_url_decodes() {
        let url = extract_ddg_url(
            "//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpath&rut=abc",
        );
        assert_eq!(url, "https://example.com/path");
    }

    #[test]
    fn extract_ddg_url_passthrough() {
        let url = extract_ddg_url("https://example.com");
        assert_eq!(url, "https://example.com");
    }

    #[test]
    fn percent_decode_basic() {
        assert_eq!(percent_decode("hello%20world"), "hello world");
        assert_eq!(percent_decode("a+b"), "a b");
    }

    #[test]
    fn parse_ddg_html_extracts_results() {
        let html = r#"
        <div class="result">
          <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com">Example <em>Site</em></a>
          <a class="result__snippet">This is a <b>snippet</b></a>
        </div>
        <div class="result">
          <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Ftest.org">Test Org</a>
          <a class="result__snippet">Another snippet</a>
        </div>
        "#;
        let results = parse_ddg_html(html, 5);
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].title, "Example Site");
        assert_eq!(results[0].url, "https://example.com");
        assert_eq!(results[0].snippet, "This is a snippet");
        assert_eq!(results[1].title, "Test Org");
    }

    #[test]
    fn parse_bing_html_extracts_results() {
        let html = r#"
        <ol id="b_results">
        <li class="b_algo" data-id="1">
          <h2 class=""><a target="_blank" href="https://rust-lang.org/zh-CN/"><strong>Rust</strong> 程序设计语言</a></h2>
          <p class="b_lineclamp2">1 天前&ensp;&#0183;&ensp;生产环境中的 <strong>Rust</strong> 应用</p>
        </li>
        <li class="b_algo" data-id="2">
          <h2><a href="https://example.com">Example Site</a></h2>
          <p>Another snippet</p>
        </li>
        </ol>
        "#;
        let results = parse_bing_html(html, 5);
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].title, "Rust 程序设计语言");
        assert_eq!(results[0].url, "https://rust-lang.org/zh-CN/");
        assert_eq!(results[0].snippet, "1 天前 · 生产环境中的 Rust 应用");
        assert_eq!(results[1].title, "Example Site");
    }

    // ============================= bash 工具测试 =============================

    #[cfg(unix)]
    #[tokio::test]
    async fn bash_echo_success() {
        let out = run_bash_command("echo hello", Path::new("/tmp"), 10)
            .await
            .unwrap();
        assert_eq!(out.code, Some(0));
        assert!(out.stdout.contains("hello"));
        assert!(!out.timed_out);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn bash_nonzero_exit_code() {
        let out = run_bash_command("exit 3", Path::new("/tmp"), 10)
            .await
            .unwrap();
        assert_eq!(out.code, Some(3));
        assert!(!out.timed_out);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn bash_timeout_kills_process() {
        let start = std::time::Instant::now();
        let out = run_bash_command("sleep 30", Path::new("/tmp"), 1)
            .await
            .unwrap();
        assert!(out.timed_out);
        assert!(start.elapsed() < std::time::Duration::from_secs(10));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn bash_runs_in_workspace_dir() {
        let dir = tempfile::tempdir().unwrap();
        let out = run_bash_command("pwd", dir.path(), 10).await.unwrap();
        assert_eq!(out.code, Some(0));
        assert!(out.stdout.trim().ends_with(dir.path().to_str().unwrap()));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn bash_stderr_captured() {
        let out = run_bash_command("echo err >&2", Path::new("/tmp"), 10)
            .await
            .unwrap();
        assert_eq!(out.code, Some(0));
        assert!(out.stderr.contains("err"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn bash_pipeline_and_env() {
        let out = run_bash_command(
            "printf 'b\\na\\nc\\n' | sort | head -1",
            Path::new("/tmp"),
            10,
        )
        .await
        .unwrap();
        assert_eq!(out.code, Some(0));
        assert_eq!(out.stdout.trim(), "a");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn bash_envelope_keeps_status_out_of_content() {
        // 成功:内容为纯输出,状态字段单独携带,不再拼进文本
        let out = run_bash_command("echo hi", Path::new("/tmp"), 10)
            .await
            .unwrap();
        let env = bash_output_envelope(&out, 12);
        let json = env.as_json().unwrap();
        assert_eq!(json["content"], "hi\n");
        assert_eq!(json["exit_code"], 0);
        assert_eq!(json["timed_out"], false);
        assert_eq!(json["duration_ms"], 12);
        let content = json["content"].as_str().unwrap();
        assert!(!content.contains("命令执行成功"));

        // 失败:退出码非 0
        let out = run_bash_command("exit 7", Path::new("/tmp"), 10)
            .await
            .unwrap();
        let env = bash_output_envelope(&out, 3);
        let json = env.as_json().unwrap();
        assert_eq!(json["exit_code"], 7);
        assert_eq!(json["timed_out"], false);
        assert!(!json["content"].as_str().unwrap().contains("命令执行失败"));

        // 超时:timed_out=true
        let out = run_bash_command("sleep 30", Path::new("/tmp"), 1)
            .await
            .unwrap();
        assert!(out.timed_out);
        let env = bash_output_envelope(&out, 1000);
        let json = env.as_json().unwrap();
        assert_eq!(json["timed_out"], true);
        assert!(!json["content"].as_str().unwrap().contains("命令执行超时"));
    }

    // ============================= replace 工具测试 =============================

    /// 辅助:通过文件读写直接验证替换核心逻辑。
    #[test]
    fn replace_single_unique_match() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("test.txt");
        std::fs::write(&file, "hello world\nfoo bar\n").unwrap();

        let content = std::fs::read_to_string(&file).unwrap();
        let new_content = content.replacen("world", "Rust", 1);
        std::fs::write(&file, &new_content).unwrap();

        assert_eq!(std::fs::read_to_string(&file).unwrap(), "hello Rust\nfoo bar\n");
    }

    #[test]
    fn replace_all_occurrences() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("test.txt");
        std::fs::write(&file, "aaa bbb aaa\nccc aaa\n").unwrap();

        let content = std::fs::read_to_string(&file).unwrap();
        let match_count = content.matches("aaa").count();
        assert_eq!(match_count, 3);

        let new_content = content.replace("aaa", "XXX");
        std::fs::write(&file, &new_content).unwrap();

        assert_eq!(
            std::fs::read_to_string(&file).unwrap(),
            "XXX bbb XXX\nccc XXX\n"
        );
    }

    #[test]
    fn replace_no_match_returns_zero() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("test.txt");
        std::fs::write(&file, "hello world\n").unwrap();

        let content = std::fs::read_to_string(&file).unwrap();
        let match_count = content.matches("nonexistent").count();
        assert_eq!(match_count, 0);
    }

    #[test]
    fn replace_multiline_string() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("test.rs");
        let original = "fn main() {\n    println!(\"hello\");\n}\n";
        std::fs::write(&file, original).unwrap();

        let old = "    println!(\"hello\");";
        let new = "    println!(\"world\");";
        let content = std::fs::read_to_string(&file).unwrap();
        let new_content = content.replacen(old, new, 1);
        std::fs::write(&file, &new_content).unwrap();

        assert_eq!(
            std::fs::read_to_string(&file).unwrap(),
            "fn main() {\n    println!(\"world\");\n}\n"
        );
    }

    #[test]
    fn replace_multiple_matches_counted() {
        let content = "foo bar foo baz foo";
        let count = content.matches("foo").count();
        assert_eq!(count, 3);
    }

    // ============================= grep 工具测试 =============================

    #[test]
    fn fallback_search_finds_matches() {
        let dir = tempfile::tempdir().unwrap();
        let ws = dir.path();
        std::fs::write(ws.join("a.txt"), "hello world\nfoo bar\n").unwrap();
        std::fs::write(ws.join("b.txt"), "world peace\n").unwrap();

        let results = fallback_search(ws, ".", "world", None, None, false, false, 50);
        assert_eq!(results.len(), 2);
        assert!(results.iter().any(|r| r.contains("a.txt")));
        assert!(results.iter().any(|r| r.contains("b.txt")));
    }

    #[test]
    fn fallback_search_literal_escapes_regex() {
        let dir = tempfile::tempdir().unwrap();
        let ws = dir.path();
        std::fs::write(ws.join("test.rs"), "let x = a.b.c;\n").unwrap();

        let results = fallback_search(ws, ".", "a.b.c", None, None, true, false, 50);
        assert_eq!(results.len(), 1);
        assert!(results[0].contains("a.b.c"));
    }

    #[test]
    fn fallback_search_case_insensitive() {
        let dir = tempfile::tempdir().unwrap();
        let ws = dir.path();
        std::fs::write(ws.join("test.txt"), "Hello\nHELLO\nhello\n").unwrap();

        let results = fallback_search(ws, ".", "hello", None, None, false, true, 50);
        assert_eq!(results.len(), 3);
    }

    #[test]
    fn fallback_search_include_glob() {
        let dir = tempfile::tempdir().unwrap();
        let ws = dir.path();
        std::fs::write(ws.join("a.rs"), "pattern here\n").unwrap();
        std::fs::write(ws.join("b.txt"), "pattern here\n").unwrap();

        let results = fallback_search(ws, ".", "pattern", Some("*.rs"), None, false, false, 50);
        assert_eq!(results.len(), 1);
        assert!(results[0].contains("a.rs"));
    }

    #[test]
    fn fallback_search_exclude_glob() {
        let dir = tempfile::tempdir().unwrap();
        let ws = dir.path();
        std::fs::write(ws.join("a.rs"), "pattern here\n").unwrap();
        std::fs::write(ws.join("b.lock"), "pattern here\n").unwrap();

        let results =
            fallback_search(ws, ".", "pattern", None, Some("*.lock"), false, false, 50);
        assert_eq!(results.len(), 1);
        assert!(results[0].contains("a.rs"));
    }

    #[test]
    fn fallback_search_max_results() {
        let dir = tempfile::tempdir().unwrap();
        let ws = dir.path();
        std::fs::write(ws.join("test.txt"), "match\nmatch\nmatch\nmatch\nmatch\n").unwrap();

        let results = fallback_search(ws, ".", "match", None, None, false, false, 3);
        assert_eq!(results.len(), 3);
    }

    #[test]
    fn fallback_search_subpath() {
        let dir = tempfile::tempdir().unwrap();
        let ws = dir.path();
        std::fs::create_dir_all(ws.join("src")).unwrap();
        std::fs::write(ws.join("src/main.rs"), "target here\n").unwrap();
        std::fs::write(ws.join("other.txt"), "target here\n").unwrap();

        let results = fallback_search(ws, "src", "target", None, None, false, false, 50);
        assert_eq!(results.len(), 1);
        assert!(results[0].contains("src/main.rs"));
    }

    #[test]
    fn fallback_search_no_match() {
        let dir = tempfile::tempdir().unwrap();
        let ws = dir.path();
        std::fs::write(ws.join("test.txt"), "hello world\n").unwrap();

        let results = fallback_search(ws, ".", "nonexistent", None, None, false, false, 50);
        assert!(results.is_empty());
    }

    #[test]
    fn fallback_search_skips_ignored_dirs() {
        let dir = tempfile::tempdir().unwrap();
        let ws = dir.path();
        std::fs::create_dir_all(ws.join("target")).unwrap();
        std::fs::create_dir_all(ws.join("src")).unwrap();
        std::fs::write(ws.join("target/out.txt"), "secret\n").unwrap();
        std::fs::write(ws.join("src/main.rs"), "secret\n").unwrap();

        let results = fallback_search(ws, ".", "secret", None, None, false, false, 50);
        assert_eq!(results.len(), 1);
        assert!(results[0].contains("src/main.rs"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn run_ripgrep_returns_none_when_not_installed() {
        // 仅当系统完全找不到 rg(PATH 与常见安装目录均无)时才验证 None 路径;
        // 装了 rg 的环境跳过(结果非 None)。
        let has_rg = crate::binpath::resolve_rg().is_some();
        if has_rg {
            return; // 系统有 rg,跳过此测试
        }
        let result = run_ripgrep(
            "test",
            ".",
            Path::new("/tmp"),
            None,
            None,
            false,
            false,
            0,
            50,
        )
        .await
        .unwrap();
        assert!(result.is_none());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn run_ripgrep_searches_files() {
        if crate::binpath::resolve_rg().is_none() {
            eprintln!("跳过:系统未安装 rg");
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let ws = dir.path();
        std::fs::write(ws.join("a.rs"), "fn main() {}\nhello world\n").unwrap();
        std::fs::write(ws.join("b.txt"), "hello planet\n").unwrap();

        let result = run_ripgrep(
            "hello",
            ".",
            ws,
            None,
            None,
            false,
            false,
            0,
            50,
        )
        .await
        .unwrap()
        .expect("rg 应该可用");

        assert!(result.contains("a.rs"));
        assert!(result.contains("b.txt"));
        assert!(result.contains("hello world"));
        assert!(result.contains("hello planet"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn run_ripgrep_literal_search() {
        if crate::binpath::resolve_rg().is_none() {
            eprintln!("跳过:系统未安装 rg");
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let ws = dir.path();
        // 字面量搜索 "." 不应被当作正则
        std::fs::write(ws.join("test.rs"), "let x = a.b.c;\n").unwrap();

        let result = run_ripgrep(
            "a.b.c",
            ".",
            ws,
            None,
            None,
            true,
            false,
            0,
            50,
        )
        .await
        .unwrap()
        .expect("rg 应该可用");

        assert!(result.contains("a.b.c"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn run_ripgrep_case_insensitive() {
        if crate::binpath::resolve_rg().is_none() {
            eprintln!("跳过:系统未安装 rg");
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let ws = dir.path();
        std::fs::write(ws.join("test.txt"), "Hello\nHELLO\nhello\n").unwrap();

        let result = run_ripgrep(
            "hello",
            ".",
            ws,
            None,
            None,
            false,
            true,
            0,
            50,
        )
        .await
        .unwrap()
        .expect("rg 应该可用");

        // 应该匹配全部 3 行
        assert!(result.contains("找到 3 个匹配"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn run_ripgrep_include_glob() {
        if crate::binpath::resolve_rg().is_none() {
            eprintln!("跳过:系统未安装 rg");
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let ws = dir.path();
        std::fs::write(ws.join("a.rs"), "pattern here\n").unwrap();
        std::fs::write(ws.join("b.txt"), "pattern here\n").unwrap();

        let result = run_ripgrep(
            "pattern",
            ".",
            ws,
            Some("*.rs"),
            None,
            false,
            false,
            0,
            50,
        )
        .await
        .unwrap()
        .expect("rg 应该可用");

        assert!(result.contains("a.rs"));
        assert!(!result.contains("b.txt"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn run_ripgrep_context_lines() {
        if crate::binpath::resolve_rg().is_none() {
            eprintln!("跳过:系统未安装 rg");
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let ws = dir.path();
        std::fs::write(ws.join("test.txt"), "line1\nline2\nmatch\nline4\nline5\n").unwrap();

        let result = run_ripgrep(
            "match",
            ".",
            ws,
            None,
            None,
            false,
            false,
            1, // 1 行上下文
            50,
        )
        .await
        .unwrap()
        .expect("rg 应该可用");

        // 应该包含上下文行
        assert!(result.contains("line2") || result.contains("line4"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn run_ripgrep_no_match() {
        if crate::binpath::resolve_rg().is_none() {
            eprintln!("跳过:系统未安装 rg");
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let ws = dir.path();
        std::fs::write(ws.join("test.txt"), "hello world\n").unwrap();

        let result = run_ripgrep(
            "nonexistent",
            ".",
            ws,
            None,
            None,
            false,
            false,
            0,
            50,
        )
        .await
        .unwrap()
        .expect("rg 应该可用");

        assert!(result.contains("未找到匹配"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn run_ripgrep_invalid_regex_returns_error() {
        if crate::binpath::resolve_rg().is_none() {
            eprintln!("跳过:系统未安装 rg");
            return;
        }
        let dir = tempfile::tempdir().unwrap();

        let result = run_ripgrep(
            "(unclosed",
            ".",
            dir.path(),
            None,
            None,
            false,
            false,
            0,
            50,
        )
        .await;

        assert!(result.is_err());
    }
}
