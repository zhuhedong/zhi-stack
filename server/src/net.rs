use crate::error::{AppError, Result};
use reqwest::{
    header::{HeaderMap, HeaderName, HeaderValue},
    Method,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    net::{IpAddr, Ipv4Addr},
    time::Duration,
};
use url::Url;

pub const MAX_DOCUMENT: usize = 8 * 1024 * 1024;
#[derive(Clone, Default)]
pub struct Network {
    pub allowed_private_hosts: Vec<String>,
}
pub struct Fetched {
    pub url: Url,
    pub status: u16,
    pub headers: HashMap<String, String>,
    pub bytes: Vec<u8>,
}

pub fn parse_url(value: &str) -> Result<Url> {
    let url = Url::parse(value).map_err(|_| AppError::bad("请输入完整的 HTTP 或 HTTPS 地址"))?;
    if !["http", "https"].contains(&url.scheme())
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(AppError::bad("只支持不含用户名密码的 HTTP / HTTPS 地址"));
    }
    Ok(url)
}
fn public_v4(ip: Ipv4Addr) -> bool {
    let [a, b, _, _] = ip.octets();
    !(ip.is_private()
        || ip.is_loopback()
        || ip.is_link_local()
        || ip.is_unspecified()
        || ip.is_multicast()
        || ip.is_broadcast()
        || ip.is_documentation()
        || a == 0
        || a >= 240
        || (a == 100 && (64..=127).contains(&b))
        || (a == 198 && (b == 18 || b == 19))
        || (a == 192 && b == 0))
}
fn is_public(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v) => public_v4(v),
        IpAddr::V6(v) => {
            if let Some(v4) = v.to_ipv4_mapped() {
                return public_v4(v4);
            }
            // Global unicast only; exclude documentation and 6to4 transition ranges.
            (v.segments()[0] & 0xe000) == 0x2000
                && v.segments()[0] != 0x2002
                && !(v.segments()[0] == 0x2001
                    && (v.segments()[1] < 0x200 || v.segments()[1] == 0xdb8))
        }
    }
}
impl Network {
    pub async fn fetch(
        &self,
        value: &str,
        method: Method,
        headers: HeaderMap,
        body: Option<String>,
        redirects: bool,
    ) -> Result<Fetched> {
        let mut url = parse_url(value)?;
        let initial_origin = url.origin();
        for step in 0..6 {
            let host = url
                .host_str()
                .unwrap_or_default()
                .trim_matches(['[', ']'])
                .to_string();
            let port = url.port_or_known_default().unwrap_or(443);
            let addresses: Vec<_> = tokio::time::timeout(
                Duration::from_secs(10),
                tokio::net::lookup_host((host.as_str(), port)),
            )
            .await
            .map_err(|_| AppError::bad("DNS 解析超时"))?
            .map_err(|_| AppError::bad("无法解析目标域名"))?
            .collect();
            if addresses.is_empty() {
                return Err(AppError::bad("目标域名没有可用地址"));
            }
            if !self
                .allowed_private_hosts
                .iter()
                .any(|h| h.eq_ignore_ascii_case(&host))
                && addresses.iter().any(|a| !is_public(a.ip()))
            {
                return Err(AppError::bad(
                    "该地址属于内网或保留网段；请在服务端 ALLOWED_PRIVATE_HOSTS 中显式配置目标主机",
                ));
            }
            let client = reqwest::Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(10))
                .timeout(Duration::from_secs(30))
                .user_agent("InfoHub/0.1 (+personal-archive)")
                .resolve_to_addrs(&host, &addresses)
                .build()?;
            let mut request = client.request(method.clone(), url.clone());
            // Credentials must never cross origins, including a followed ingestion redirect.
            if url.origin() == initial_origin {
                request = request.headers(headers.clone());
            }
            if let Some(body) = &body {
                request = request.body(body.clone());
            }
            let mut response = request.send().await?;
            if redirects && response.status().is_redirection() {
                let location = response
                    .headers()
                    .get("location")
                    .and_then(|h| h.to_str().ok())
                    .ok_or_else(|| AppError::bad("重定向缺少目标地址"))?;
                url = url
                    .join(location)
                    .map_err(|_| AppError::bad("无效的重定向地址"))?;
                parse_url(url.as_str())?;
                if step == 5 {
                    return Err(AppError::bad("重定向次数过多"));
                }
                continue;
            }
            if method != Method::HEAD
                && response
                    .content_length()
                    .is_some_and(|n| n > MAX_DOCUMENT as u64)
            {
                return Err(AppError::bad("目标响应超过 8 MB 限制"));
            }
            let status = response.status().as_u16();
            let response_headers = response
                .headers()
                .iter()
                .filter_map(|(k, v)| v.to_str().ok().map(|v| (k.to_string(), v.to_string())))
                .collect();
            let mut bytes = Vec::new();
            while let Some(chunk) = response.chunk().await? {
                if bytes.len() + chunk.len() > MAX_DOCUMENT {
                    return Err(AppError::bad("目标响应超过 8 MB 限制"));
                }
                bytes.extend_from_slice(&chunk);
            }
            return Ok(Fetched {
                url,
                status,
                headers: response_headers,
                bytes,
            });
        }
        Err(AppError::bad("无法完成网络请求"))
    }
    pub async fn get(&self, url: &str) -> Result<Fetched> {
        let response = self
            .fetch(url, Method::GET, HeaderMap::new(), None, true)
            .await?;
        if !(200..300).contains(&response.status) {
            return Err(AppError::bad(format!(
                "目标站点返回 HTTP {}，未保存不完整内容",
                response.status
            )));
        }
        Ok(response)
    }
}

#[derive(Deserialize)]
pub struct ProbeInput {
    pub url: String,
    pub method: String,
    #[serde(default)]
    pub headers: Vec<HeaderPair>,
    pub body: Option<String>,
}
#[derive(Deserialize, Serialize)]
pub struct HeaderPair {
    pub key: String,
    pub value: String,
    #[serde(default = "yes")]
    pub enabled: bool,
}
fn yes() -> bool {
    true
}
pub fn request_headers(pairs: &[HeaderPair]) -> Result<HeaderMap> {
    let mut result = HeaderMap::new();
    for h in pairs
        .iter()
        .filter(|h| h.enabled && !h.key.trim().is_empty())
    {
        let name = HeaderName::from_bytes(h.key.trim().as_bytes())
            .map_err(|_| AppError::bad("Header 名称无效"))?;
        if [
            "host",
            "content-length",
            "connection",
            "transfer-encoding",
            "proxy-authorization",
            "proxy-connection",
            "upgrade",
            "te",
            "trailer",
        ]
        .contains(&name.as_str())
        {
            return Err(AppError::bad(format!(
                "{} 由 HTTP 客户端管理，请移除该 Header",
                name
            )));
        }
        result.insert(
            name,
            HeaderValue::from_str(&h.value).map_err(|_| AppError::bad("Header 值包含无效字符"))?,
        );
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn prevents_ssrf_and_protocol_confusion() {
        for ip in [
            "127.0.0.1",
            "10.2.3.4",
            "169.254.169.254",
            "100.64.1.2",
            "::1",
            "::ffff:127.0.0.1",
            "fd00::1",
            "2002:7f00:1::",
        ] {
            assert!(!is_public(ip.parse().unwrap()), "{ip}");
        }
        assert!(is_public("8.8.8.8".parse().unwrap()));
        assert!(parse_url("file:///etc/passwd").is_err());
        assert!(parse_url("https://user:pass@example.com").is_err());
    }
}
