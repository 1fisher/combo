//! 内置工具:read / write / search / web_search + current_time / current_date。
//!
//! read/write/search 需要 workspace 根目录(由 `builtin_tools` 传入);
//! web_search 支持多搜索引擎(baidu/bing/ddg,默认 baidu),无需 API key。

use regex::Regex;
use rig::tool::{DynamicTool, ToolOutput};
use serde_json::{Value, json};
use std::path::{Component, Path, PathBuf};

/// 返回内置工具列表。
pub fn builtin_tools(workspace_dir: Option<PathBuf>) -> Vec<DynamicTool> {
    let ws = workspace_dir.unwrap_or_else(|| PathBuf::from("."));
    vec![
        read_tool(ws.clone()),
        write_tool(ws.clone()),
        search_tool(ws.clone()),
        web_search_tool(),
        current_time_tool(),
        current_date_tool(),
    ]
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

// ============================= web_search =============================

/// `web_search`:网络搜索,支持多引擎(baidu/bing/ddg,默认 baidu)。
fn web_search_tool() -> DynamicTool {
    DynamicTool::new(
        "web_search",
        "网络搜索:使用搜索引擎查找信息,返回结果的标题、链接和摘要。参数:query(搜索关键词),max_results(结果数量上限,默认5),engine(搜索引擎:baidu/bing/ddg,默认baidu)。",
        json!({
            "type": "object",
            "properties": {
                "query": { "type": "string", "description": "搜索关键词" },
                "max_results": { "type": "integer", "description": "返回结果数量上限,默认 5" },
                "engine": {
                    "type": "string",
                    "description": "搜索引擎:baidu/bing/ddg,默认 baidu",
                    "enum": ["baidu", "bing", "ddg", "duckduckgo"]
                }
            },
            "required": ["query"]
        }),
        move |_ctx, args| {
            Box::pin(async move {
                let query = args.get("query").and_then(Value::as_str).unwrap_or("");
                let max_results =
                    args.get("max_results").and_then(Value::as_u64).unwrap_or(5) as usize;
                let engine = args.get("engine").and_then(Value::as_str).unwrap_or("baidu");

                if query.is_empty() {
                    return Ok(ToolOutput::text("错误: query 不能为空"));
                }

                let results = match engine {
                    "bing" => web_search_bing(query, max_results).await,
                    "ddg" | "duckduckgo" => web_search_ddg(query, max_results).await,
                    _ => web_search_baidu(query, max_results).await,
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

/// 使用百度搜索。百度对无 cookie 的请求返回安全验证页,先访问首页获取 cookie。
async fn web_search_baidu(query: &str, max_results: usize) -> anyhow::Result<Vec<WebResult>> {
    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")
        .cookie_store(true)
        .timeout(std::time::Duration::from_secs(15))
        .build()?;

    // 先访问首页获取 BAIDUID 等 cookie,否则搜索结果会被安全验证拦截
    client.get("https://www.baidu.com/").send().await?;

    let url = format!(
        "https://www.baidu.com/s?wd={}&ie=utf-8",
        url_encode_query(query)
    );
    let resp = client.get(&url).send().await?;
    if !resp.status().is_success() {
        anyhow::bail!("百度返回状态码: {}", resp.status());
    }

    let html = resp.text().await?;
    if html.contains("百度安全验证") {
        anyhow::bail!("百度安全验证拦截了搜索请求,请稍后重试或改用其它引擎");
    }
    Ok(parse_baidu_html(&html, max_results))
}

/// 解析百度搜索结果页(桌面版 `www.baidu.com/s?wd=...`)。
fn parse_baidu_html(html: &str, max_results: usize) -> Vec<WebResult> {
    let tag_re = Regex::new(r"<[^>]+>").unwrap();
    // 结果容器:class 同时含 result/result-op 与 c-container
    let container_re = Regex::new(
        r#"(?s)<div[^>]*class="[^"]*(?:result|result-op)[^"]*c-container[^"]*"[^>]*>"#,
    )
    .unwrap();
    // 容器开标签中的真实地址(mu 属性)
    let mu_re = Regex::new(r#"mu="([^"]*)""#).unwrap();
    // 块内标题链接(href 是百度重定向链接,mu 缺失时兜底)
    let title_re =
        Regex::new(r#"(?s)<h3[^>]*>.*?<a[^>]*href="([^"]+)"[^>]*>(.*?)</a>"#).unwrap();
    // 块内摘要(data-module="abstract" 是新版稳定的标记)
    let abstract_re = Regex::new(r#"(?s)<div data-module="abstract"[^>]*>(.*?)</div>"#).unwrap();

    let starts: Vec<usize> = container_re.find_iter(html).map(|m| m.start()).collect();
    let mut results = Vec::new();
    for (i, start) in starts.iter().enumerate() {
        let end = starts.get(i + 1).copied().unwrap_or(html.len());
        let block = &html[*start..end];

        let mu = mu_re
            .captures(block)
            .map(|c| c[1].to_string())
            .unwrap_or_default();
        let url = (!mu.is_empty() && !mu.contains("nourl.ubs.baidu.com"))
            .then_some(mu)
            .unwrap_or_default();

        let (title, link) = title_re
            .captures(block)
            .map(|c| (strip_tags(&c[2], &tag_re), c[1].to_string()))
            .unwrap_or_default();
        if title.is_empty() {
            continue;
        }

        let snippet = abstract_re
            .captures(block)
            .map(|c| strip_tags(&c[1], &tag_re))
            .unwrap_or_default();

        results.push(WebResult {
            title,
            url: if url.is_empty() { link } else { url },
            snippet,
        });
        if results.len() >= max_results {
            break;
        }
    }
    results
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

/// `current_time`:返回当前本地时间(时:分:秒)。
fn current_time_tool() -> DynamicTool {
    DynamicTool::new(
        "current_time",
        "获取当前本地时间(HH:MM:SS)。当你需要知道现在几点时使用。",
        json!({
            "type": "object",
            "properties": {}
        }),
        |_context, _args| {
            Box::pin(async move {
                use chrono::Local;
                let now = Local::now().format("%H:%M:%S").to_string();
                Ok(ToolOutput::text(format!("当前时间:{now}")))
            })
        },
    )
}

/// `current_date`:返回当前日期(年-月-日)。
fn current_date_tool() -> DynamicTool {
    DynamicTool::new(
        "current_date",
        "获取当前日期(YYYY-MM-DD)。当你需要知道今天几号时使用。",
        json!({
            "type": "object",
            "properties": {}
        }),
        |_context, _args| {
            Box::pin(async move {
                use chrono::Local;
                let date = Local::now().format("%Y-%m-%d").to_string();
                Ok(ToolOutput::text(format!("当前日期:{date}")))
            })
        },
    )
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
    fn parse_baidu_html_extracts_results() {
        let html = r#"
        <div class="result c-container new-pmd" mu="https://www.rust-lang.org/zh-CN/">
          <h3 class="cosc-title t cos-line-clamp-1 title_4QsBx" data-module="title"><a class="cosc-title-a" href="http://www.baidu.com/link?url=abc" target="_blank"><span><em>Rust</em> 程序设计语言</span></a></h3>
          <div data-module="abstract" class="content-gap_3jlQr"><div role="text"><span class="summary-text_15QGa"><em>Rust</em> 是一门系统编程语言,注重安全与性能。</span></div></div>
        </div>
        <div class="result-op c-container xpath-log new-pmd" mu="http://nourl.ubs.baidu.com/279">
          <h3 class="t"><a href="http://www.baidu.com/link?url=def">测试标题</a></h3>
        </div>
        "#;
        let results = parse_baidu_html(html, 5);
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].title, "Rust 程序设计语言");
        assert_eq!(results[0].url, "https://www.rust-lang.org/zh-CN/");
        assert_eq!(results[0].snippet, "Rust 是一门系统编程语言,注重安全与性能。");
        // mu 为占位地址时回退到重定向链接
        assert_eq!(results[1].title, "测试标题");
        assert_eq!(results[1].url, "http://www.baidu.com/link?url=def");
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
}
