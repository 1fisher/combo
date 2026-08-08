//! 远程访问令牌(移动端扫码连接用)。
//!
//! 桌面端在「移动端远程控制」里生成一次性令牌,二维码内嵌令牌;
//! 移动端扫码打开后从 URL 提取令牌并随每个请求携带(`Authorization:
//! Bearer <token>` 或 `?token=<token>`)。鉴权中间件对非回环请求强制
//! 校验,本地(127.0.0.1/::1)与公开端点(`/v1/health`、`/v1/auth/*`)放行。

use crate::AppState;
use axum::body::Body;
use axum::extract::{Query, Request, State};
use axum::http::{header, StatusCode};
use axum::middleware::Next;
use axum::response::Response;
use serde::Deserialize;
use serde_json::json;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicU64, Ordering};

/// 默认令牌有效期:7 天。
const DEFAULT_TOKEN_TTL_SECS: i64 = 7 * 24 * 3600;

fn unix_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn json_response(status: StatusCode, value: serde_json::Value) -> Response {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(value.to_string()))
        .unwrap()
}

fn ok_json(value: serde_json::Value) -> Response {
    json_response(StatusCode::OK, value)
}

fn error(status: StatusCode, message: &str) -> Response {
    json_response(status, json!({ "message": message }))
}

/// 读取 OS 加密随机字节(Unix: /dev/urandom)。
fn read_random_bytes(n: usize) -> Option<Vec<u8>> {
    use std::io::Read;
    let mut f = std::fs::File::open("/dev/urandom").ok()?;
    let mut buf = vec![0u8; n];
    f.read_exact(&mut buf).ok()?;
    Some(buf)
}

static COUNTER: AtomicU64 = AtomicU64::new(0);

/// /dev/urandom 不可用时的回退(不保证密码学安全,仅极端环境兜底)。
fn fallback_token() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let pid = std::process::id();
    let c = COUNTER.fetch_add(1, Ordering::Relaxed);
    let mix = format!("{nanos:x}{pid:x}{c:x}");
    hex::encode(mix.as_bytes())
}

/// 生成一个新的随机令牌(32 字节 hex = 64 字符)。
pub fn generate_token() -> String {
    match read_random_bytes(32) {
        Some(bytes) => hex::encode(bytes),
        None => fallback_token(),
    }
}

/// 公开端点:无需令牌即可访问。
fn is_public_path(path: &str) -> bool {
    path == "/v1/health" || path.starts_with("/v1/auth")
}

/// 判断请求是否来自本地回环。
fn is_local_request(req: &Request) -> bool {
    match req.extensions().get::<axum::extract::ConnectInfo<SocketAddr>>() {
        Some(ci) => ci.0.ip().is_loopback(),
        None => true, // 无法判定来源时放行,避免破坏非 connect_info 部署
    }
}

/// 从 `Authorization: Bearer <token>` 或 `?token=<token>` 提取令牌。
fn extract_token(req: &Request) -> Option<String> {
    if let Some(auth) = req.headers().get(header::AUTHORIZATION) {
        if let Ok(s) = auth.to_str() {
            if let Some(rest) = s.strip_prefix("Bearer ") {
                let t = rest.trim();
                if !t.is_empty() {
                    return Some(t.to_string());
                }
            }
        }
    }
    if let Some(q) = req.uri().query() {
        for pair in q.split('&') {
            let mut it = pair.splitn(2, '=');
            if it.next() == Some("token") {
                if let Some(v) = it.next() {
                    let decoded = urlencoding_decode(v);
                    if !decoded.is_empty() {
                        return Some(decoded);
                    }
                }
            }
        }
    }
    None
}

/// 简易 percent-decode(仅 token 值,避免引入新依赖)。
fn urlencoding_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(b) = u8::from_str_radix(
                &std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or(""),
                16,
            ) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        if bytes[i] == b'+' {
            out.push(b' ');
        } else {
            out.push(bytes[i]);
        }
        i += 1;
    }
    String::from_utf8(out).unwrap_or_default()
}

/// 校验令牌是否有效(存在、未撤销、未过期)。有效则更新最后使用时间。
pub fn verify(state: &AppState, token: &str) -> bool {
    match state.meta.db().get_token(token) {
        Ok(Some(t)) => {
            if t.revoked {
                return false;
            }
            if let Some(exp) = t.expires_at {
                if exp < unix_secs() {
                    return false;
                }
            }
            let _ = state.meta.db().touch_token(token);
            true
        }
        _ => false,
    }
}

/// 鉴权中间件:非回环、非公开端点的请求必须携带有效令牌。
pub async fn require_token(State(state): State<AppState>, req: Request, next: Next) -> Response {
    let path = req.uri().path().to_string();
    if is_public_path(&path) || is_local_request(&req) {
        return next.run(req).await;
    }
    match extract_token(&req) {
        Some(t) if verify(&state, &t) => next.run(req).await,
        Some(_) => error(StatusCode::UNAUTHORIZED, "令牌无效或已过期"),
        None => error(StatusCode::UNAUTHORIZED, "访问被拒绝,需要有效的访问令牌"),
    }
}

// ---------- handlers ----------

#[derive(Deserialize)]
pub struct CreateTokenBody {
    pub label: Option<String>,
    /// 有效期(秒);缺省 7 天,传 0 表示永不过期。
    pub ttl_secs: Option<i64>,
}

/// POST /v1/auth/token — 生成新的访问令牌(桌面端调用)。
pub async fn create_token(
    State(state): State<AppState>,
    body: axum::Json<CreateTokenBody>,
) -> Response {
    let token = generate_token();
    let label = body.label.clone().unwrap_or_default();
    let now = unix_secs();
    let expires_at = match body.ttl_secs {
        Some(0) | None => Some(now + DEFAULT_TOKEN_TTL_SECS),
        Some(secs) => Some(now + secs),
    };
    if let Err(e) = state.meta.db().insert_token(&token, &label, expires_at) {
        return error(StatusCode::INTERNAL_SERVER_ERROR, &format!("创建令牌失败: {e}"));
    }
    ok_json(json!({
        "token": token,
        "label": label,
        "created_at": now,
        "expires_at": expires_at,
    }))
}

/// GET /v1/auth/tokens — 列出全部令牌(不含明文仍含,因为本地端管理用)。
pub async fn list_tokens(State(state): State<AppState>) -> Response {
    match state.meta.db().list_tokens() {
        Ok(tokens) => ok_json(json!(tokens.iter().map(token_to_json).collect::<Vec<_>>())),
        Err(e) => error(StatusCode::INTERNAL_SERVER_ERROR, &format!("读取令牌失败: {e}")),
    }
}

#[derive(Deserialize)]
pub struct VerifyQuery {
    pub token: Option<String>,
}

/// GET /v1/auth/verify?token= — 校验令牌有效性。
pub async fn verify_token(
    State(state): State<AppState>,
    Query(q): Query<VerifyQuery>,
) -> Response {
    match q.token {
        Some(t) if verify(&state, &t) => ok_json(json!({ "valid": true })),
        _ => ok_json(json!({ "valid": false })),
    }
}

#[derive(Deserialize)]
pub struct RevokeQuery {
    pub token: Option<String>,
    pub all: Option<bool>,
}

/// DELETE /v1/auth/token?token=&all= — 撤销令牌。
pub async fn revoke_token(
    State(state): State<AppState>,
    Query(q): Query<RevokeQuery>,
) -> Response {
    if q.all.unwrap_or(false) {
        if let Err(e) = state.meta.db().revoke_all_tokens() {
            return error(StatusCode::INTERNAL_SERVER_ERROR, &format!("撤销失败: {e}"));
        }
        return ok_json(json!({ "revoked": "all" }));
    }
    match q.token {
        Some(t) => match state.meta.db().revoke_token(&t) {
            Ok(true) => ok_json(json!({ "revoked": t })),
            Ok(false) => error(StatusCode::NOT_FOUND, "令牌不存在"),
            Err(e) => error(StatusCode::INTERNAL_SERVER_ERROR, &format!("撤销失败: {e}")),
        },
        None => error(StatusCode::BAD_REQUEST, "需要 token 或 all=true 参数"),
    }
}

fn token_to_json(t: &crate::db::AccessToken) -> serde_json::Value {
    json!({
        "token": t.token,
        "label": t.label,
        "created_at": t.created_at,
        "expires_at": t.expires_at,
        "last_used_at": t.last_used_at,
        "revoked": t.revoked,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend::BackendType;
    use crate::meta::WorkspaceMeta;
    use std::path::PathBuf;

    fn make_state() -> AppState {
        let meta = crate::MetaStore::new();
        // 填充一个 workspace 让 AppState 可构造
        meta.insert(WorkspaceMeta {
            id: "w1".into(),
            path: PathBuf::from("/tmp/w1"),
            name: "项目".into(),
            backend_type: BackendType::Crush,
        });
        AppState {
            meta: std::sync::Arc::new(meta),
            registry: std::sync::Arc::new(crate::BackendRegistry::new(std::sync::Arc::new(
                crate::CrushBackend::new(crate::Upstream::Unix(PathBuf::from("/tmp/x.sock"))),
            ))),
            crush_supervisor: None,
            browse_root: None,
            relay: crate::RelayManager::new(),
            local_port: 0,
        }
    }

    #[test]
    fn generated_tokens_are_unique_and_hex() {
        let a = generate_token();
        let b = generate_token();
        assert_ne!(a, b);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_eq!(a.len(), 64);
    }

    #[test]
    fn verify_roundtrip_and_revoke() {
        let state = make_state();
        let tok = generate_token();
        state
            .meta
            .db()
            .insert_token(&tok, "test", Some(unix_secs() + 3600))
            .unwrap();
        assert!(verify(&state, &tok));
        state.meta.db().revoke_token(&tok).unwrap();
        assert!(!verify(&state, &tok));
    }

    #[test]
    fn verify_expired_token_fails() {
        let state = make_state();
        let tok = generate_token();
        state
            .meta
            .db()
            .insert_token(&tok, "test", Some(unix_secs() - 1))
            .unwrap();
        assert!(!verify(&state, &tok));
    }

    #[test]
    fn verify_non_existent_fails() {
        let state = make_state();
        assert!(!verify(&state, "nope"));
    }

    #[test]
    fn urlencoding_decode_handles_percent() {
        assert_eq!(urlencoding_decode("abc"), "abc");
        assert_eq!(urlencoding_decode("a%2Bb"), "a+b");
        assert_eq!(urlencoding_decode("a+b"), "a b");
    }

    #[test]
    fn is_public_path_matches() {
        assert!(is_public_path("/v1/health"));
        assert!(is_public_path("/v1/auth/token"));
        assert!(is_public_path("/v1/auth/verify"));
        assert!(!is_public_path("/v1/workspaces"));
    }

    #[test]
    fn extract_token_from_header_and_query() {
        use axum::body::Body;
        use axum::http::{header, Method, Request};

        // Authorization: Bearer
        let mut req = Request::builder()
            .method(Method::GET)
            .uri("/v1/workspaces")
            .body(Body::empty())
            .unwrap();
        req.headers_mut()
            .insert(header::AUTHORIZATION, header::HeaderValue::from_static("Bearer abc123"));
        assert_eq!(extract_token(&req), Some("abc123".into()));

        // query 参数
        let req = Request::builder()
            .method(Method::GET)
            .uri("/v1/workspaces?token=xyz%2B")
            .body(Body::empty())
            .unwrap();
        assert_eq!(extract_token(&req), Some("xyz+".into()));

        // 都没有
        let req = Request::builder()
            .method(Method::GET)
            .uri("/v1/workspaces")
            .body(Body::empty())
            .unwrap();
        assert_eq!(extract_token(&req), None);
    }
}
