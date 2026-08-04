use crate::fs;
use crate::handler::proxy;
use crate::session;
use crate::skills;
use crate::workspace;
use crate::control;
use crate::AppState;
use axum::routing::{delete, get, post};
use axum::Router;
use tower_http::cors::{Any, CorsLayer};

/// 构建 proxy router。`allowed_origins` 为空时 CORS 全开放(开发模式)。
pub fn build_router(state: AppState, allowed_origins: Vec<String>) -> Router {
    let cors = if allowed_origins.is_empty() {
        CorsLayer::permissive()
    } else {
        let origins: Vec<axum::http::HeaderValue> = allowed_origins
            .iter()
            .map(|o| {
                o.parse()
                    .expect("allowed_origins must contain valid origin values")
            })
            .collect();
        CorsLayer::new()
            .allow_origin(origins)
            .allow_methods(Any)
            .allow_headers(Any)
    };
    Router::new()
        .route("/v1/skills", get(skills::list))
        .route("/v1/control/ensure-crush", post(control::ensure_crush))
        .route("/v1/workspaces", get(workspace::list).post(workspace::create))
        .route(
            "/v1/workspaces/:id",
            get(workspace::get).patch(workspace::rename).delete(workspace::delete),
        )
        .route(
            "/v1/workspaces/:id/sessions",
            get(session::list).post(session::create),
        )
        .route(
            "/v1/workspaces/:id/sessions/:sid",
            delete(session::delete),
        )
        .route("/v1/workspaces/:id/files/list", get(fs::list))
        .route(
            "/v1/workspaces/:id/files/content",
            get(fs::read).put(fs::write),
        )
        .fallback(proxy)
        .with_state(state)
        .layer(cors)
}
