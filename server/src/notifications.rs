//! Release notifications delivered outside the app: generic JSON webhook,
//! WeCom / DingTalk / Feishu group robots, Telegram bots and SMTP email.
use crate::{
    error::{AppError, Result},
    service_key, AppState,
};
use axum::{
    extract::{Path, State},
    http::{HeaderMap, HeaderValue, Method, StatusCode},
    Json,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use hmac::{Hmac, Mac};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::Sha256;
use std::time::Duration;
use uuid::Uuid;
use zeroize::Zeroizing;

fn internal(message: impl Into<String>) -> AppError {
    AppError(StatusCode::INTERNAL_SERVER_ERROR, message.into())
}
type ChannelRow = (
    Uuid,
    String,
    String,
    bool,
    Value,
    Option<Vec<u8>>,
    Option<chrono::DateTime<chrono::Utc>>,
    String,
    String,
);
const CONTEXT: &str = "infohub-notification-secret";
const KINDS: [&str; 6] = [
    "webhook", "wecom", "dingtalk", "feishu", "telegram", "email",
];

/// A notification event; currently only new repository releases.
#[derive(Clone, Debug)]
pub struct Event {
    pub repo: String,
    pub release: String,
    pub url: String,
    pub notes: String,
    pub published_at: String,
}
impl Event {
    fn title(&self) -> String {
        format!("{} 发布了新版本 {}", self.repo, self.release)
    }
    fn text(&self) -> String {
        let mut notes: String = self.notes.chars().take(800).collect();
        if self.notes.chars().count() > 800 {
            notes.push('…');
        }
        let mut text = self.title();
        if !self.published_at.is_empty() {
            text += &format!("\n发布时间：{}", self.published_at);
        }
        if !self.url.is_empty() {
            text += &format!("\n{}", self.url);
        }
        if !notes.trim().is_empty() {
            text += &format!("\n\n{}", notes.trim());
        }
        text
    }
    fn markdown(&self) -> String {
        let mut text = format!("### {}\n", self.title());
        if !self.published_at.is_empty() {
            text += &format!("> 发布时间：{}\n", self.published_at);
        }
        if !self.url.is_empty() {
            text += &format!("\n[查看发布说明]({})\n", self.url);
        }
        let notes: String = self.notes.chars().take(800).collect();
        if !notes.trim().is_empty() {
            text += &format!("\n{}\n", notes.trim());
        }
        text
    }
}

/// Secret material per channel kind, sealed as JSON.
#[derive(Deserialize, serde::Serialize, Default, Clone)]
#[serde(rename_all = "camelCase", default)]
struct Secret {
    /// Webhook URL (generic/WeCom/DingTalk/Feishu) — robot URLs embed their access key.
    url: String,
    /// Optional signing secret (generic HMAC header, DingTalk / Feishu signature).
    signing: String,
    /// Telegram bot token.
    bot_token: String,
    /// SMTP password.
    password: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelInput {
    pub name: String,
    pub kind: String,
    #[serde(default = "yes")]
    pub enabled: bool,
    #[serde(default)]
    pub config: Value,
    /// Only provided fields replace stored secrets; omitted keeps the old ones.
    #[serde(default)]
    pub secret: Option<Value>,
}
fn yes() -> bool {
    true
}

fn clean_config(kind: &str, config: &Value) -> Result<Value> {
    let s = |key: &str| config[key].as_str().unwrap_or("").trim().to_string();
    Ok(match kind {
        "telegram" => {
            let chat = s("chatId");
            if chat.is_empty() || chat.len() > 64 {
                return Err(AppError::bad("请填写 Telegram chat_id"));
            }
            json!({"chatId": chat})
        }
        "email" => {
            let host = s("host");
            if host.is_empty() || host.len() > 253 || host.contains(['/', ' ', ':']) {
                return Err(AppError::bad("请填写有效的 SMTP 服务器主机名"));
            }
            let security = match s("security").as_str() {
                "" | "starttls" => "starttls",
                "tls" => "tls",
                "none" => "none",
                _ => return Err(AppError::bad("SMTP 加密方式只能是 tls、starttls 或 none")),
            };
            let port = config["port"].as_u64().unwrap_or(match security {
                "tls" => 465,
                "none" => 25,
                _ => 587,
            });
            if port == 0 || port > 65535 {
                return Err(AppError::bad("SMTP 端口无效"));
            }
            let from = s("from");
            from.parse::<lettre::message::Mailbox>()
                .map_err(|_| AppError::bad("发件人地址无效"))?;
            let to: Vec<String> = s("to")
                .split([',', ';', '\n'])
                .map(|v| v.trim().to_string())
                .filter(|v| !v.is_empty())
                .collect();
            if to.is_empty() || to.len() > 20 {
                return Err(AppError::bad("请填写 1–20 个收件人地址"));
            }
            for address in &to {
                address
                    .parse::<lettre::message::Mailbox>()
                    .map_err(|_| AppError::bad(format!("收件人地址无效：{address}")))?;
            }
            json!({"host": host, "port": port, "security": security, "username": s("username"), "from": from, "to": to.join(", ")})
        }
        _ => json!({}),
    })
}
fn validate_secret(kind: &str, secret: &Secret, private_hosts: &[String]) -> Result<()> {
    match kind {
        "telegram" => {
            if !regex::Regex::new(r"^\d{3,20}:[A-Za-z0-9_-]{20,100}$")
                .unwrap()
                .is_match(&secret.bot_token)
            {
                return Err(AppError::bad("Telegram Bot Token 格式无效"));
            }
        }
        "email" => {}
        _ => {
            let url = crate::net::parse_url(&secret.url)
                .map_err(|_| AppError::bad("请填写有效的 HTTP(S) Webhook 地址"))?;
            // Robots must use HTTPS; explicitly allowed private hosts (tests, intranet relays) may use HTTP.
            let allowed = url
                .host_str()
                .is_some_and(|h| private_hosts.iter().any(|p| p.eq_ignore_ascii_case(h)));
            if url.scheme() != "https" && kind != "webhook" && !allowed {
                return Err(AppError::bad("机器人 Webhook 必须使用 HTTPS"));
            }
        }
    }
    if secret.signing.len() > 512 || secret.url.len() > 2048 || secret.password.len() > 512 {
        return Err(AppError::bad("密钥过长"));
    }
    Ok(())
}
async fn load_secret(sealed: Option<Vec<u8>>) -> Result<Secret> {
    match sealed {
        None => Ok(Secret::default()),
        Some(bytes) => {
            let plain = service_key::open(&bytes, CONTEXT).await?;
            serde_json::from_slice(&plain).map_err(|_| internal("通知密钥数据损坏"))
        }
    }
}
fn merge_secret(mut current: Secret, patch: &Value) -> Secret {
    let take = |key: &str, target: &mut String| {
        if let Some(value) = patch.get(key).and_then(Value::as_str) {
            *target = value.trim().to_string();
        }
    };
    take("url", &mut current.url);
    take("signing", &mut current.signing);
    take("botToken", &mut current.bot_token);
    take("password", &mut current.password);
    current
}
/// Non-secret hint so the UI can show which robot/host is configured.
fn hint(kind: &str, secret: &Secret) -> Value {
    let host = url::Url::parse(&secret.url)
        .ok()
        .and_then(|u| u.host_str().map(str::to_string))
        .unwrap_or_default();
    json!({
        "urlHost": host,
        "hasUrl": !secret.url.is_empty(),
        "hasSigning": !secret.signing.is_empty(),
        "hasBotToken": !secret.bot_token.is_empty(),
        "hasPassword": !secret.password.is_empty(),
        "kind": kind,
    })
}

pub async fn list(State(state): State<AppState>) -> Result<Json<Value>> {
    let rows: Vec<ChannelRow> = sqlx::query_as("SELECT id,name,kind,enabled,config,secret,last_sent_at,last_status,last_error FROM notification_channels ORDER BY created_at")
        .fetch_all(&state.db)
        .await?;
    let mut channels = Vec::new();
    for (id, name, kind, enabled, config, secret, last_sent_at, last_status, last_error) in rows {
        let secret = load_secret(secret).await.unwrap_or_default();
        channels.push(json!({"id":id,"name":name,"kind":kind,"enabled":enabled,"config":config,"secret":hint(&kind,&secret),"lastSentAt":last_sent_at,"lastStatus":last_status,"lastError":last_error}));
    }
    Ok(Json(
        json!({"channels": channels, "serviceKey": service_key::get().await.is_ok()}),
    ))
}
async fn save(state: &AppState, id: Option<Uuid>, input: ChannelInput) -> Result<Uuid> {
    if !KINDS.contains(&input.kind.as_str()) {
        return Err(AppError::bad("不支持的通知类型"));
    }
    let name = input.name.trim();
    if name.is_empty() || name.chars().count() > 80 {
        return Err(AppError::bad("请填写 1–80 字的名称"));
    }
    let config = clean_config(&input.kind, &input.config)?;
    let mut tx = state.db.begin().await?;
    let current = match id {
        Some(id) => {
            let row: Option<(String, Option<Vec<u8>>)> = sqlx::query_as(
                "SELECT kind,secret FROM notification_channels WHERE id=$1 FOR UPDATE",
            )
            .bind(id)
            .fetch_optional(&mut *tx)
            .await?;
            let (kind, sealed) =
                row.ok_or_else(|| AppError(StatusCode::NOT_FOUND, "通知渠道不存在".into()))?;
            if kind != input.kind {
                return Err(AppError::bad("不能修改通知类型，请新建渠道"));
            }
            load_secret(sealed).await?
        }
        None => Secret::default(),
    };
    let secret = match &input.secret {
        Some(patch) => merge_secret(current, patch),
        None => current,
    };
    validate_secret(&input.kind, &secret, &state.network.allowed_private_hosts)?;
    let plain = Zeroizing::new(serde_json::to_vec(&secret).map_err(|e| internal(e.to_string()))?);
    let sealed = service_key::seal(&plain, CONTEXT).await?;
    let id = id.unwrap_or_else(Uuid::new_v4);
    sqlx::query("INSERT INTO notification_channels(id,name,kind,enabled,config,secret) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO UPDATE SET name=$2,enabled=$4,config=$5,secret=$6")
        .bind(id)
        .bind(name)
        .bind(&input.kind)
        .bind(input.enabled)
        .bind(config)
        .bind(sealed)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(id)
}
pub async fn create(
    State(state): State<AppState>,
    Json(input): Json<ChannelInput>,
) -> Result<(StatusCode, Json<Value>)> {
    let id = save(&state, None, input).await?;
    Ok((StatusCode::CREATED, Json(json!({"id": id}))))
}
pub async fn update(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Json(input): Json<ChannelInput>,
) -> Result<Json<Value>> {
    save(&state, Some(id), input).await?;
    Ok(Json(json!({"id": id})))
}
pub async fn delete(State(state): State<AppState>, Path(id): Path<Uuid>) -> Result<StatusCode> {
    let done = sqlx::query("DELETE FROM notification_channels WHERE id=$1")
        .bind(id)
        .execute(&state.db)
        .await?;
    if done.rows_affected() == 0 {
        return Err(AppError(StatusCode::NOT_FOUND, "通知渠道不存在".into()));
    }
    Ok(StatusCode::NO_CONTENT)
}
pub async fn test(State(state): State<AppState>, Path(id): Path<Uuid>) -> Result<Json<Value>> {
    let event = Event {
        repo: "InfoHub".into(),
        release: "测试通知".into(),
        url: String::new(),
        notes: "这是一条测试消息：通知渠道配置正确。".into(),
        published_at: chrono::Utc::now().to_rfc3339(),
    };
    let row: Option<(String, Value, Option<Vec<u8>>)> =
        sqlx::query_as("SELECT kind,config,secret FROM notification_channels WHERE id=$1")
            .bind(id)
            .fetch_optional(&state.db)
            .await?;
    let (kind, config, secret) =
        row.ok_or_else(|| AppError(StatusCode::NOT_FOUND, "通知渠道不存在".into()))?;
    let result = deliver(&state, &kind, &config, &load_secret(secret).await?, &event).await;
    record(&state, id, &result).await?;
    result?;
    Ok(Json(json!({"sent": true})))
}
async fn record(state: &AppState, id: Uuid, result: &Result<()>) -> Result<()> {
    let (status, error) = match result {
        Ok(()) => ("success", String::new()),
        Err(e) => ("failed", e.1.chars().take(500).collect()),
    };
    sqlx::query("UPDATE notification_channels SET last_sent_at=now(),last_status=$2,last_error=$3 WHERE id=$1")
        .bind(id)
        .bind(status)
        .bind(error)
        .execute(&state.db)
        .await?;
    Ok(())
}

/// Sends `event` to every enabled channel. Failures are recorded per channel.
pub async fn broadcast(state: &AppState, event: Event) {
    let rows: Vec<(Uuid, String, Value, Option<Vec<u8>>)> = match sqlx::query_as(
        "SELECT id,kind,config,secret FROM notification_channels WHERE enabled ORDER BY created_at",
    )
    .fetch_all(&state.db)
    .await
    {
        Ok(rows) => rows,
        Err(e) => {
            tracing::warn!("notification channels unavailable: {e}");
            return;
        }
    };
    for (id, kind, config, secret) in rows {
        let result = match load_secret(secret).await {
            Ok(secret) => deliver(state, &kind, &config, &secret, &event).await,
            Err(e) => Err(e),
        };
        if let Err(e) = &result {
            tracing::warn!("notification {id} ({kind}) failed: {}", e.1);
        }
        let _ = record(state, id, &result).await;
    }
}

fn hmac_sha256(key: &[u8], message: &[u8]) -> Vec<u8> {
    let mut mac = Hmac::<Sha256>::new_from_slice(key).expect("hmac accepts any key length");
    mac.update(message);
    mac.finalize().into_bytes().to_vec()
}
/// DingTalk: sign = base64(HMAC-SHA256(secret, "{timestamp}\n{secret}")), appended to the URL.
pub fn dingtalk_url(url: &str, secret: &str, timestamp_ms: i64) -> String {
    if secret.is_empty() {
        return url.to_string();
    }
    let sign = STANDARD.encode(hmac_sha256(
        secret.as_bytes(),
        format!("{timestamp_ms}\n{secret}").as_bytes(),
    ));
    let sign: String = url::form_urlencoded::byte_serialize(sign.as_bytes()).collect();
    let sep = if url.contains('?') { '&' } else { '?' };
    format!("{url}{sep}timestamp={timestamp_ms}&sign={sign}")
}
/// Feishu: sign = base64(HMAC-SHA256(key = "{timestamp}\n{secret}", message = "")).
pub fn feishu_sign(secret: &str, timestamp_s: i64) -> String {
    STANDARD.encode(hmac_sha256(
        format!("{timestamp_s}\n{secret}").as_bytes(),
        b"",
    ))
}
/// Builds the HTTP target and JSON body for webhook-style channels.
pub fn webhook_payload(
    kind: &str,
    url: &str,
    signing: &str,
    event: &Event,
    now: chrono::DateTime<chrono::Utc>,
) -> (String, Value) {
    match kind {
        "wecom" => (
            url.into(),
            json!({"msgtype":"markdown","markdown":{"content": event.markdown()}}),
        ),
        "dingtalk" => (
            dingtalk_url(url, signing, now.timestamp_millis()),
            json!({"msgtype":"markdown","markdown":{"title": event.title(), "text": event.markdown()}}),
        ),
        "feishu" => {
            let mut body = json!({"msg_type":"text","content":{"text": event.text()}});
            if !signing.is_empty() {
                body["timestamp"] = json!(now.timestamp().to_string());
                body["sign"] = json!(feishu_sign(signing, now.timestamp()));
            }
            (url.into(), body)
        }
        _ => (
            url.into(),
            json!({"event":"release","repo":event.repo,"release":event.release,"url":event.url,"notes":event.notes,"publishedAt":event.published_at,"title":event.title(),"text":event.text()}),
        ),
    }
}
fn robot_error(kind: &str, body: &[u8]) -> Option<String> {
    let value: Value = serde_json::from_slice(body).ok()?;
    let code = match kind {
        "wecom" | "dingtalk" => value["errcode"].as_i64(),
        "feishu" => value["code"].as_i64().or(value["StatusCode"].as_i64()),
        "telegram" => (value["ok"] == json!(false)).then_some(1),
        _ => None,
    }?;
    (code != 0).then(|| {
        value["errmsg"]
            .as_str()
            .or(value["msg"].as_str())
            .or(value["description"].as_str())
            .unwrap_or("未知错误")
            .chars()
            .take(200)
            .collect()
    })
}
async fn post_json(
    state: &AppState,
    kind: &str,
    url: &str,
    body: &Value,
    headers: HeaderMap,
) -> Result<()> {
    let mut headers = headers;
    headers.insert("content-type", HeaderValue::from_static("application/json"));
    let fetched = state
        .network
        .fetch(url, Method::POST, headers, Some(body.to_string()), false)
        .await?;
    if !(200..300).contains(&fetched.status) {
        return Err(AppError::bad(format!("目标返回 HTTP {}", fetched.status)));
    }
    if let Some(message) = robot_error(kind, &fetched.bytes) {
        return Err(AppError::bad(format!("机器人返回错误：{message}")));
    }
    Ok(())
}
fn telegram_base() -> String {
    std::env::var("TELEGRAM_API_BASE")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| "https://api.telegram.org".into())
        .trim_end_matches('/')
        .to_string()
}
/// Delivers and scrubs every secret value from any error text (URLs embed robot keys).
async fn deliver(
    state: &AppState,
    kind: &str,
    config: &Value,
    secret: &Secret,
    event: &Event,
) -> Result<()> {
    deliver_raw(state, kind, config, secret, event)
        .await
        .map_err(|e| {
            let mut message = e.1;
            for value in [
                &secret.url,
                &secret.bot_token,
                &secret.password,
                &secret.signing,
            ] {
                if value.len() >= 4 {
                    message = message.replace(value.as_str(), "***");
                }
            }
            if let Ok(url) = url::Url::parse(&secret.url) {
                if let Some(query) = url.query() {
                    message = message.replace(query, "***");
                }
                if url.path().len() > 1 {
                    message = message.replace(url.path(), "/***");
                }
            }
            AppError(e.0, message)
        })
}
async fn deliver_raw(
    state: &AppState,
    kind: &str,
    config: &Value,
    secret: &Secret,
    event: &Event,
) -> Result<()> {
    match kind {
        "telegram" => {
            let url = format!("{}/bot{}/sendMessage", telegram_base(), secret.bot_token);
            let body = json!({"chat_id": config["chatId"], "text": event.text(), "disable_web_page_preview": true});
            post_json(state, kind, &url, &body, HeaderMap::new())
                .await
                .map_err(|e| {
                    // Never echo the URL (it contains the bot token).
                    AppError(e.0, e.1.replace(&secret.bot_token, "***"))
                })
        }
        "email" => send_email(state, config, secret, event).await,
        _ => {
            let (url, body) = webhook_payload(
                kind,
                &secret.url,
                &secret.signing,
                event,
                chrono::Utc::now(),
            );
            let mut headers = HeaderMap::new();
            if kind == "webhook" && !secret.signing.is_empty() {
                let signature = hex::encode(hmac_sha256(
                    secret.signing.as_bytes(),
                    body.to_string().as_bytes(),
                ));
                headers.insert(
                    "x-infohub-signature",
                    HeaderValue::from_str(&format!("sha256={signature}"))
                        .map_err(|e| internal(e.to_string()))?,
                );
            }
            headers.insert("x-infohub-event", HeaderValue::from_static("release"));
            post_json(state, kind, &url, &body, headers).await
        }
    }
}
async fn send_email(
    state: &AppState,
    config: &Value,
    secret: &Secret,
    event: &Event,
) -> Result<()> {
    use lettre::{
        message::{header::ContentType, Mailbox},
        transport::smtp::{
            authentication::Credentials,
            client::{Tls, TlsParameters},
        },
        AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor,
    };
    let host = config["host"].as_str().unwrap_or_default();
    let port = config["port"].as_u64().unwrap_or(587) as u16;
    // Same address policy as other outbound requests.
    let addresses: Vec<_> = tokio::time::timeout(
        Duration::from_secs(10),
        tokio::net::lookup_host((host, port)),
    )
    .await
    .map_err(|_| AppError::bad("SMTP 服务器 DNS 解析超时"))?
    .map_err(|_| AppError::bad("无法解析 SMTP 服务器"))?
    .collect();
    if !state
        .network
        .allowed_private_hosts
        .iter()
        .any(|h| h.eq_ignore_ascii_case(host))
        && addresses.iter().any(|a| !crate::net::is_public(a.ip()))
    {
        return Err(AppError::bad(
            "SMTP 服务器属于内网或保留网段；请在服务端 ALLOWED_PRIVATE_HOSTS 中显式配置",
        ));
    }
    let mut message = Message::builder()
        .from(
            config["from"]
                .as_str()
                .unwrap_or_default()
                .parse::<Mailbox>()
                .map_err(|_| AppError::bad("发件人地址无效"))?,
        )
        .subject(event.title())
        .header(ContentType::TEXT_PLAIN);
    for to in config["to"].as_str().unwrap_or_default().split(',') {
        message = message.to(to
            .trim()
            .parse::<Mailbox>()
            .map_err(|_| AppError::bad("收件人地址无效"))?);
    }
    let message = message
        .body(event.text())
        .map_err(|e| AppError::bad(e.to_string()))?;
    let tls =
        || TlsParameters::new(host.into()).map_err(|e| AppError::bad(format!("TLS 配置失败：{e}")));
    let builder = AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous(host)
        .port(port)
        .timeout(Some(Duration::from_secs(20)))
        .tls(match config["security"].as_str() {
            Some("tls") => Tls::Wrapper(tls()?),
            Some("none") => Tls::None,
            _ => Tls::Required(tls()?),
        });
    let username = config["username"].as_str().unwrap_or_default();
    let builder = if username.is_empty() {
        builder
    } else {
        builder.credentials(Credentials::new(username.into(), secret.password.clone()))
    };
    builder.build().send(message).await.map_err(|e| {
        AppError::bad(format!("SMTP 发送失败：{e}").replace(&secret.password, "***"))
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn event() -> Event {
        Event {
            repo: "tokio-rs/tokio".into(),
            release: "v1.2.3".into(),
            url: "https://github.com/tokio-rs/tokio/releases/tag/v1.2.3".into(),
            notes: "修复".into(),
            published_at: "2026-10-21T00:00:00Z".into(),
        }
    }
    #[test]
    fn formats_robot_payloads() {
        let now = chrono::DateTime::from_timestamp(1_700_000_000, 0).unwrap();
        let (_, wecom) =
            webhook_payload("wecom", "https://qyapi.weixin.qq.com/x", "", &event(), now);
        assert_eq!(wecom["msgtype"], "markdown");
        assert!(wecom["markdown"]["content"]
            .as_str()
            .unwrap()
            .contains("v1.2.3"));
        let (url, ding) = webhook_payload(
            "dingtalk",
            "https://oapi.dingtalk.com/robot/send?access_token=a",
            "SEC1",
            &event(),
            now,
        );
        assert!(url.starts_with(
            "https://oapi.dingtalk.com/robot/send?access_token=a&timestamp=1700000000000&sign="
        ));
        assert_eq!(
            ding["markdown"]["title"],
            "tokio-rs/tokio 发布了新版本 v1.2.3"
        );
        let (_, feishu) = webhook_payload("feishu", "https://open.feishu.cn/x", "s", &event(), now);
        assert_eq!(feishu["msg_type"], "text");
        assert_eq!(feishu["timestamp"], "1700000000");
        let (_, generic) = webhook_payload("webhook", "https://e.com", "", &event(), now);
        assert_eq!(generic["event"], "release");
        assert_eq!(generic["release"], "v1.2.3");
    }
    #[test]
    fn signatures_match_reference_algorithms() {
        // DingTalk reference: base64(hmac_sha256(secret, ts + "\n" + secret)).
        let expected = STANDARD.encode(hmac_sha256(b"SEC", b"1000\nSEC"));
        let url = dingtalk_url("https://x/send?a=1", "SEC", 1000);
        let sign: String = url::form_urlencoded::byte_serialize(expected.as_bytes()).collect();
        assert_eq!(
            url,
            format!("https://x/send?a=1&timestamp=1000&sign={sign}")
        );
        // Feishu reference: key = ts + "\n" + secret, empty message.
        assert_eq!(
            feishu_sign("abc", 1),
            STANDARD.encode(hmac_sha256(b"1\nabc", b""))
        );
    }
    #[test]
    fn robot_errors_are_detected() {
        assert_eq!(
            robot_error(
                "wecom",
                br#"{"errcode":93000,"errmsg":"invalid webhook url"}"#
            )
            .as_deref(),
            Some("invalid webhook url")
        );
        assert!(robot_error("wecom", br#"{"errcode":0,"errmsg":"ok"}"#).is_none());
        assert_eq!(
            robot_error("feishu", br#"{"code":19021,"msg":"sign match fail"}"#).as_deref(),
            Some("sign match fail")
        );
        assert!(robot_error("telegram", br#"{"ok":true}"#).is_none());
        assert!(robot_error("webhook", br#"{"errcode":5}"#).is_none());
    }
    #[test]
    fn validates_configuration() {
        assert!(clean_config(
            "email",
            &json!({"host":"smtp.example.com","from":"a@b.c","to":"x@y.z, q@r.s"})
        )
        .is_ok());
        assert!(clean_config(
            "email",
            &json!({"host":"smtp.example.com","from":"bad","to":"x@y.z"})
        )
        .is_err());
        assert!(clean_config("telegram", &json!({})).is_err());
        let bad = Secret {
            url: "https://x".into(),
            bot_token: "nope".into(),
            ..Default::default()
        };
        assert!(validate_secret("telegram", &bad, &[]).is_err());
        let http = Secret {
            url: "http://example.com/hook".into(),
            ..Default::default()
        };
        assert!(validate_secret("wecom", &http, &[]).is_err());
        assert!(validate_secret("webhook", &http, &[]).is_ok());
    }
}
