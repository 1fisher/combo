use crate::fs;
use crate::git;
use crate::handler::proxy;
use crate::host;
use crate::session;
use crate::skills;
use crate::terminal;
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
        .route("/v1/terminal", get(terminal::terminal_default))
        .route("/v1/control/ensure-crush", post(control::ensure_crush))
        .route("/v1/host/home", get(host::home))
        .route("/v1/host/dirs", get(host::dirs))
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
            delete(session::delete).patch(session::rename),
        )
        .route(
            "/v1/workspaces/:id/sessions/:sid/history",
            get(session::history),
        )
        .route(
            "/v1/workspaces/:id/sessions/:sid/messages",
            post(session::upsert_msg),
        )
        .route("/v1/workspaces/:id/files/list", get(fs::list))
        .route(
            "/v1/workspaces/:id/files/content",
            get(fs::read).put(fs::write),
        )
        .route("/v1/workspaces/:id/files/raw", get(fs::raw))
        .route("/v1/workspaces/:id/git/status", get(git::status))
        .route("/v1/workspaces/:id/git/diff", get(git::diff))
        .route("/v1/workspaces/:id/git/diff/staged", get(git::diff_staged))
        .route("/v1/workspaces/:id/git/diff/head", get(git::diff_head))
        .route("/v1/workspaces/:id/git/file", get(git::file_at_head))
        .route("/v1/workspaces/:id/git/log", get(git::git_log))
        .route("/v1/workspaces/:id/git/stage", post(git::stage))
        .route("/v1/workspaces/:id/git/unstage", post(git::unstage))
        .route("/v1/workspaces/:id/git/commit", post(git::commit))
        .route("/v1/workspaces/:id/terminal", get(terminal::terminal))
        .fallback(proxy)
        .with_state(state)
        .layer(cors)
}
