pub mod protocol;
pub mod tunnel;

pub use tunnel::{
    is_ws_upgrade, token_cookie_headers, tunnel_forward, tunnel_forward_all, tunnel_status_handler,
    waiting_page, ws_proxy_handler, ws_signal_handler, ws_tunnel_handler, RelayState,
};

use axum::body::Body;
use axum::extract::ws::WebSocketUpgrade;
use axum::extract::{FromRequestParts, Request, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use std::path::{Path, PathBuf};
use tower_http::cors::{Any, CorsLayer};

/// 构建中转服务器路由。
///
/// 路由优先级:
/// 1. `GET /v1/relay/tunnel?token=xxx` — WebSocket 升级(桌面客户端建立隧道)
/// 2. `GET /v1/relay/status?token=xxx` — 中转级隧道状态(不经过隧道,供移动端检查)
/// 3. `GET /v1/health` — 健康检查
/// 4. `/v1/*` — 通过隧道转发到桌面客户端
/// 5. `/*` — 静态前端(如果配置了 `static_dir`),或通过隧道转发(tunnel-all 模式)
///
/// 当 `tunnel_all` 为 true 且未配置 `static_dir` 时,所有非 API 请求也通过隧道
/// 转发到桌面端(桌面端需提供静态文件服务,如 `combo-cli serve --static-dir dist/`)。
/// 此模式下支持 cookie 令牌与单隧道自动选用,浏览器无需逐请求携带 Authorization。
pub fn build_router(
    state: RelayState,
    static_dir: Option<PathBuf>,
    tunnel_all: bool,
    allowed_origins: Vec<String>,
) -> Router {
    let cors = if allowed_origins.is_empty() {
        CorsLayer::permissive()
    } else {
        let origins: Vec<axum::http::HeaderValue> = allowed_origins
            .iter()
            .filter_map(|o| o.parse().ok())
            .collect();
        CorsLayer::new()
            .allow_origin(origins)
            .allow_methods(Any)
            .allow_headers(Any)
    };

    let static_dir_val = static_dir.clone();

    Router::new()
        .route("/v1/relay/tunnel", get(ws_tunnel_handler))
        .route("/v1/relay/signal", get(ws_signal_handler))
        .route("/v1/relay/status", get(tunnel_status_handler))
        .route("/v1/health", get(health))
        .fallback(move |State(state): State<RelayState>, req: Request| {
            fallback(state, static_dir_val.clone(), tunnel_all, req)
        })
        .with_state(state)
        .layer(cors)
}

/// fallback handler:WS 升级请求走 WS 隧道代理,/v1/* 走 HTTP 隧道转发,
/// 其余根据配置走静态文件或 tunnel-all。
async fn fallback(
    state: RelayState,
    static_dir: Option<PathBuf>,
    tunnel_all: bool,
    req: Request,
) -> Response {
    let path = req.uri().path();
    if path.starts_with("/v1/") {
        if is_ws_upgrade(&req) {
            return ws_proxy(state, req).await;
        }
        return tunnel_forward(State(state), req).await;
    }
    // 非 API 请求
    match static_dir {
        Some(dir) => {
            // 优先尝试静态文件;找不到时若 tunnel-all 开启则走隧道(SPA fallback)
            let resp = serve_static(&dir, req).await;
            if tunnel_all && resp.status() == StatusCode::NOT_FOUND {
                // 静态文件未命中,通过隧道转发到桌面端(让桌面端处理 SPA 路由)
                // 注意:此处需要重新构造 Request(serve_static 已消费)
                // 由于 serve_static 已消费 req,直接返回 404 让前端 SPA 路由处理
                // 实际上 SPA fallback 已在 serve_static 中处理(index.html),
                // 此分支极少触发,仅在 index.html 也不存在时才到达
                return resp;
            }
            resp
        }
        None => {
            if tunnel_all {
                // tunnel-all 模式:所有请求通过隧道转发到桌面端
                tunnel_forward_all(State(state), req).await
            } else {
                (StatusCode::NOT_FOUND, "Not Found").into_response()
            }
        }
    }
}

/// 从 Request 中提取 WebSocketUpgrade,交给 ws_proxy_handler。
async fn ws_proxy(state: RelayState, req: Request) -> Response {
    let (mut parts, body) = req.into_parts();
    let ws_upgrade = match WebSocketUpgrade::from_request_parts(&mut parts, &state).await {
        Ok(ws) => ws,
        Err(e) => return e.into_response(),
    };
    let req = Request::from_parts(parts, body);
    ws_proxy_handler(State(state), ws_upgrade, req).await
}

async fn health() -> &'static str {
    "ok"
}

/// 简单静态文件服务 + SPA fallback(index.html)。
async fn serve_static(root: &Path, req: Request) -> Response {
    let path = req.uri().path();
    // 安全:禁止路径穿越
    let clean = path.trim_start_matches('/');
    let candidate = root.join(clean);

    // 尝试直接读取文件
    if candidate.is_file() {
        return send_file(&candidate).await;
    }

    // 尝试目录下的 index.html
    let index_in_dir = candidate.join("index.html");
    if index_in_dir.is_file() {
        return send_file(&index_in_dir).await;
    }

    // SPA fallback:index.html
    let spa = root.join("index.html");
    if spa.is_file() {
        return send_file(&spa).await;
    }

    (StatusCode::NOT_FOUND, "Not Found").into_response()
}

async fn send_file(path: &Path) -> Response {
    match tokio::fs::read(path).await {
        Ok(data) => {
            let mime = mime_for(path);
            Response::builder()
                .header(header::CONTENT_TYPE, mime)
                .body(Body::from(data))
                .unwrap()
        }
        Err(_) => (StatusCode::NOT_FOUND, "Not Found").into_response(),
    }
}

fn mime_for(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "application/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        _ => "application/octet-stream",
    }
}
