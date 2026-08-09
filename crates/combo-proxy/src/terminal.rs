//! WebSocket 终端:在 workspace 根目录启动真实 PTY shell,
//! 通过 WebSocket 双向桥接前端 xterm.js 与底层进程。

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::Response;
use futures_util::{SinkExt, StreamExt};
use portable_pty::{CommandBuilder, NativePtySystem, PtySize, PtySystem};
use serde_json::{json, Value};
use std::io::{Read, Write};
use tokio::sync::mpsc;

use crate::fs::resolve_root;
use crate::AppState;

/// GET /v1/terminal — 无 workspace 的 WebSocket 终端,默认在用户主目录打开。
pub async fn terminal_default(ws: WebSocketUpgrade) -> Response {
    let root = dirs_or_home();
    ws.on_upgrade(move |socket| run_pty(socket, root))
}

/// GET /v1/workspaces/{id}/terminal — 在指定 workspace 根目录启动 PTY。
///
/// workspace 根目录直接从 sqlite 元数据解析(与 fs/git 一致),
/// 不依赖 agent 后端在线——终端只是本地 shell,无需 crush/codex 等。
pub async fn terminal(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Response {
    let root = match resolve_root(&state, &id) {
        Ok(r) => r,
        Err(resp) => return resp,
    };
    ws.on_upgrade(move |socket| run_pty(socket, root))
}

async fn run_pty(socket: WebSocket, root: std::path::PathBuf) {
    let pty_system = NativePtySystem::default();

    let pair = match pty_system.openpty(PtySize {
        rows: 24,
        cols: 80,
        pixel_width: 0,
        pixel_height: 0,
    }) {
        Ok(p) => p,
        Err(e) => {
            send_close(socket, &format!("PTY openpty 失败: {e}")).await;
            return;
        }
    };

    // 选择 shell:优先 $SHELL,fallback 到平台默认
    let shell = std::env::var("SHELL").unwrap_or_else(|_| {
        if cfg!(target_os = "windows") {
            "cmd.exe".to_string()
        } else {
            "/bin/sh".to_string()
        }
    });

    let mut cmd = CommandBuilder::new(&shell);
    cmd.cwd(&root);

    for key in &["PATH", "HOME", "USER", "LANG", "LC_ALL", "LC_CTYPE"] {
        if let Ok(val) = std::env::var(key) {
            cmd.env(key, val);
        }
    }
    cmd.env("TERM", "xterm-256color");

    let mut child = match pair.slave.spawn_command(cmd) {
        Ok(c) => c,
        Err(e) => {
            send_close(socket, &format!("shell 启动失败: {e}")).await;
            return;
        }
    };
    drop(pair.slave); // 释放 slave 端,使 EOF 能正确传播

    let mut writer = match pair.master.take_writer() {
        Ok(w) => w,
        Err(e) => {
            send_close(socket, &format!("PTY writer 获取失败: {e}")).await;
            return;
        }
    };

    let reader = match pair.master.try_clone_reader() {
        Ok(r) => r,
        Err(e) => {
            send_close(socket, &format!("PTY reader 获取失败: {e}")).await;
            return;
        }
    };

    let master = pair.master;

    // PTY 读取端 → channel(在 blocking 线程中读)
    let (tx, mut rx) = mpsc::channel::<Vec<u8>>(256);
    let read_handle = tokio::task::spawn_blocking(move || {
        let mut reader = reader;
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if tx.blocking_send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });

    let (mut ws_sink, mut ws_stream) = socket.split();

    // 主循环:select WS 输入与 PTY 输出
    loop {
        tokio::select! {
            // PTY 输出 → WS
            data = rx.recv() => {
                match data {
                    Some(d) => {
                        if ws_sink.send(Message::Binary(d.into())).await.is_err() {
                            break;
                        }
                    }
                    None => break, // PTY 进程已退出
                }
            }
            // WS 输入 → PTY
            msg = ws_stream.next() => {
                match msg {
                    Some(Ok(Message::Binary(data))) => {
                        let _ = writer.write_all(&data);
                    }
                    Some(Ok(Message::Text(text))) => {
                        if let Ok(ctrl) = serde_json::from_str::<Value>(&text) {
                            if ctrl.get("type").and_then(|v| v.as_str()) == Some("resize") {
                                let cols = ctrl.get("cols").and_then(|v| v.as_u64()).unwrap_or(80) as u16;
                                let rows = ctrl.get("rows").and_then(|v| v.as_u64()).unwrap_or(24) as u16;
                                let _ = master.resize(PtySize {
                                    rows,
                                    cols,
                                    pixel_width: 0,
                                    pixel_height: 0,
                                });
                            }
                        }
                    }
                    Some(Ok(Message::Ping(data))) => {
                        let _ = ws_sink.send(Message::Pong(data)).await;
                    }
                    Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                    _ => {}
                }
            }
        }
    }

    read_handle.abort();
    let _ = child.kill();
    let _ = child.wait();
}

fn json_err(status: StatusCode, msg: &str) -> Response {
    Response::builder()
        .status(status)
        .header("content-type", "application/json")
        .body(axum::body::Body::from(json!({ "message": msg }).to_string()))
        .unwrap()
}

/// 返回用户主目录作为默认终端工作目录。
fn dirs_or_home() -> std::path::PathBuf {
    std::env::var("HOME")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| {
            // HOME 不可用时回退到 /tmp
            std::path::PathBuf::from("/tmp")
        })
}

async fn send_close(mut socket: WebSocket, msg: &str) {
    let _ = socket.send(Message::Binary(msg.as_bytes().to_vec().into())).await;
    let _ = socket.close().await;
}
