use crate::fs;
use crate::handler::proxy;
use crate::upstream::Upstream;
use axum::routing::get;
use axum::Router;
use std::sync::Arc;
use tower_http::cors::{Any, CorsLayer};

/// Builds the proxy router. When `allowed_origins` is empty the CORS
/// layer is permissive (development mode).
pub fn build_router(upstream: Upstream, allowed_origins: Vec<String>) -> Router {
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
        .route("/v1/workspaces/:id/files/list", get(fs::list))
        .route(
            "/v1/workspaces/:id/files/content",
            get(fs::read).put(fs::write),
        )
        .fallback(proxy)
        .with_state(Arc::new(upstream))
        .layer(cors)
}
