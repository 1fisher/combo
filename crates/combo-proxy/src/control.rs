//! Control 端点:手动触发 crush 重启。

use crate::AppState;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::Response;
use serde_json::json;

/// POST /v1/control/ensure-crush — 确保 crush server 运行中。
/// 若 crush 已健康则快速返回;否则尝试重新拉起。
pub async fn ensure_crush(State(state): State<AppState>) -> Response {
    let Some(supervisor) = &state.crush_supervisor else {
        return json_err(
            StatusCode::SERVICE_UNAVAILABLE,
            "crush supervisor 未启用(外部 upstream 模式)",
        );
    };
    match supervisor.ensure_running().await {
        Ok(_) => {
            let healthy = supervisor.is_healthy().await;
            Response::builder()
                .status(StatusCode::OK)
                .header("content-type", "application/json")
                .body(axum::body::Body::from(
                    json!({ "healthy": healthy }).to_string(),
                ))
                .unwrap()
        }
        Err(e) => json_err(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("crush 启动失败: {e}"),
        ),
    }
}

fn json_err(status: StatusCode, msg: &str) -> Response {
    Response::builder()
        .status(status)
        .header("content-type", "application/json")
        .body(axum::body::Body::from(
            serde_json::json!({ "message": msg }).to_string(),
        ))
        .unwrap()
}
