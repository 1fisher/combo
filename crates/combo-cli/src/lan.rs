//! 局域网直连支持:探测本机局域网地址,供移动端扫码后直连桌面端。
//!
//! 端点:
//! - `GET /v1/lan-info` — 返回本机局域网候选地址与端口(供桌面端前端生成二维码)。
//!
//! 桌面端 serve 监听 `0.0.0.0` 时(Tauri 默认),同一局域网内的手机可直接访问
//! `http://<lan-ip>:<port>/?token=...`,完全不经中转服务器。鉴权由现有令牌
//! 中间件保障(非回环请求必须携带有效令牌)。

use crate::serve::AppState;
use axum::extract::State;
use axum::Json;
use serde::Serialize;
use std::collections::BTreeSet;
use std::net::{IpAddr, UdpSocket};

/// 探测用公共目标:UDP connect 不会真正发包,仅让内核选择默认路由的源地址。
/// 多个目标(国内外)提高无外网/仅内网路由时的命中率。
const PROBE_TARGETS: &[&str] = &["8.8.8.8:80", "114.114.114.114:80", "192.168.255.254:9"];

/// 判断地址是否适合作为局域网直连地址(私网/链路本地 IPv4 + 全球单播 IPv6)。
fn is_lan_candidate(ip: &IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let o = v4.octets();
            // 私网 10/8、172.16/12、192.168/16,以及链路本地 169.254/16
            o[0] == 10
                || (o[0] == 172 && (16..=31).contains(&o[1]))
                || (o[0] == 192 && o[1] == 168)
                || (o[0] == 169 && o[1] == 254)
        }
        IpAddr::V6(v6) => {
            // 跳过回环、链路本地(fe80)与多播;全球单播地址可作为候选
            !v6.is_loopback() && !v6.is_unspecified() && !(v6.segments()[0] & 0xffc0 == 0xfe80)
        }
    }
}

/// 探测本机局域网 IP:逐个尝试 UDP connect 公共目标,取默认路由源地址。
/// 无网络时返回空列表(纯本地探测,不产生任何出站流量)。
pub fn detect_lan_ips() -> Vec<IpAddr> {
    let mut seen = BTreeSet::new();
    for target in PROBE_TARGETS {
        let Ok(sock) = UdpSocket::bind(if target.parse::<std::net::SocketAddr>().map(|a| a.is_ipv6()).unwrap_or(false) {
            "[::]:0"
        } else {
            "0.0.0.0:0"
        }) else {
            continue;
        };
        if sock.connect(target).is_err() {
            continue;
        }
        if let Ok(addr) = sock.local_addr() {
            let ip = addr.ip();
            if !ip.is_loopback() && !ip.is_unspecified() && is_lan_candidate(&ip) {
                seen.insert(ip);
            }
        }
    }
    // 优先 IPv4(手机在内网扫码场景下 IPv4 直连兼容性最好)
    let mut ips: Vec<IpAddr> = seen.into_iter().collect();
    ips.sort_by_key(|ip| matches!(ip, IpAddr::V6(_)));
    ips.truncate(4);
    ips
}

#[derive(Serialize)]
pub struct LanInfo {
    /// 候选直连地址(如 `http://192.168.1.5:18236`),空表示无局域网可用
    pub urls: Vec<String>,
    /// 本地服务端口
    pub port: u16,
    /// serve 是否监听了非回环地址(0.0.0.0 或具体网卡 IP)
    pub lan_listening: bool,
    /// 是否配置了前端静态资源目录(直连页面需要桌面端自己供页面)
    pub has_static: bool,
}

/// GET /v1/lan-info:返回局域网直连信息(桌面端前端生成二维码时调用)。
pub async fn lan_info(State(state): State<AppState>) -> Json<LanInfo> {
    let urls = if state.bind_lan && state.has_static {
        detect_lan_ips()
            .into_iter()
            .map(|ip| match ip {
                IpAddr::V6(v6) => format!("http://[{}]:{}", v6, state.local_port),
                IpAddr::V4(v4) => format!("http://{}:{}", v4, state.local_port),
            })
            .collect()
    } else {
        Vec::new()
    };
    Json(LanInfo {
        urls,
        port: state.local_port,
        lan_listening: state.bind_lan,
        has_static: state.has_static,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lan_candidate_filters_loopback_and_public_v4() {
        assert!(!is_lan_candidate(&"127.0.0.1".parse::<IpAddr>().unwrap()));
        assert!(is_lan_candidate(&"192.168.1.5".parse::<IpAddr>().unwrap()));
        assert!(is_lan_candidate(&"10.0.0.3".parse::<IpAddr>().unwrap()));
        assert!(is_lan_candidate(&"172.17.0.1".parse::<IpAddr>().unwrap()));
        // 公网 IPv4 不算局域网候选(直连场景排除)
        assert!(!is_lan_candidate(&"8.8.8.8".parse::<IpAddr>().unwrap()));
    }

    #[test]
    fn detect_never_panics_without_network() {
        // 无网络/无路由环境下应返回空列表而非 panic
        let ips = detect_lan_ips();
        for ip in ips {
            assert!(is_lan_candidate(&ip));
            assert!(!ip.is_loopback());
        }
    }
}
