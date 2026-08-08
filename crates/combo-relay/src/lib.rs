pub mod protocol;
pub mod tunnel;

pub use tunnel::{tunnel_forward, ws_tunnel_handler, RelayState};

use axum::body::Body;
use axum::extract::{Request, State};
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
/// 2. `GET /v1/health` — 健康检查
/// 3. `/v1/*` — 通过隧道转发到桌面客户端
/// 4. `/*` — 静态前端(如果配置了 `static_dir`)
pub fn build_router(
    state: RelayState,
    static_dir: Option<PathBuf>,
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
        .route("/v1/health", get(health))
        .fallback(move |State(state): State<RelayState>, req: Request| {
            fallback(state, static_dir_val.clone(), req)
        })
        .with_state(state)
        .layer(cors)
}

/// fallback handler: /v1/* 走隧道转发,其余走静态文件。
async fn fallback(state: RelayState, static_dir: Option<PathBuf>, req: Request) -> Response {
    let path = req.uri().path();
    if path.starts_with("/v1/") {
        return tunnel_forward(State(state), req).await;
    }
    match static_dir {
        Some(dir) => serve_static(&dir, req).await,
        None => (StatusCode::NOT_FOUND, "Not Found").into_response(),
    }
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
