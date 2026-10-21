use crate::{
    crypto::{self, VaultKey},
    error::{AppError, Result},
    AppState,
};
use axum::{
    extract::{ConnectInfo, FromRequestParts, Request, State},
    http::{request::Parts, HeaderMap, StatusCode},
    middleware::Next,
    response::Response,
    Extension, Json,
};
use rand::RngCore;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    net::{IpAddr, Ipv4Addr, SocketAddr},
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::Mutex;

pub struct Session {
    pub key: Option<VaultKey>,
    pub expires: Instant,
    pub touched: Instant,
}
pub type Sessions = Arc<Mutex<HashMap<String, Session>>>;
#[derive(Clone)]
pub struct Auth {
    pub token: String,
    pub key: Option<VaultKey>,
}
impl Auth {
    pub fn vault(&self) -> Result<&VaultKey> {
        self.key.as_ref().ok_or_else(AppError::locked)
    }
}
#[derive(Deserialize)]
pub struct Password {
    pub password: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Setup {
    pub password: String,
    #[serde(default)]
    pub setup_token: String,
}

/// Client address used for login throttling. Defaults to the TCP peer; the
/// rightmost `X-Forwarded-For` hop is only trusted when the peer is listed in
/// `TRUSTED_PROXIES`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ClientIp(pub IpAddr);
pub fn client_ip(peer: Option<IpAddr>, headers: &HeaderMap, trusted: &[IpAddr]) -> IpAddr {
    let peer = peer.unwrap_or(IpAddr::V4(Ipv4Addr::UNSPECIFIED));
    if !trusted.contains(&peer) {
        return peer;
    }
    let hops: Vec<IpAddr> = headers
        .get_all("x-forwarded-for")
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(','))
        .filter_map(|h| h.trim().parse().ok())
        .collect();
    hops.into_iter()
        .rev()
        .find(|ip| !trusted.contains(ip))
        .unwrap_or(peer)
}
impl FromRequestParts<AppState> for ClientIp {
    type Rejection = std::convert::Infallible;
    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> std::result::Result<Self, Self::Rejection> {
        let peer = parts
            .extensions
            .get::<ConnectInfo<SocketAddr>>()
            .map(|c| c.0.ip());
        Ok(ClientIp(client_ip(
            peer,
            &parts.headers,
            &state.settings.trusted_proxies,
        )))
    }
}

struct Attempts {
    failures: u32,
    blocked_until: Option<Instant>,
    last: Instant,
    /// Concurrent verify/unlock attempts holding a reserved slot.
    in_flight: u32,
}
/// Per-client failed-password limiter with exponential backoff. Successful
/// verification clears the client's record, and one client's failures never
/// block another client.
///
/// Callers must [`Limiter::begin`] before the expensive Argon2 derive and
/// [`Limiter::end_fail`] / [`Limiter::end_succeed`] / [`Limiter::cancel`]
/// afterwards so concurrent requests cannot bypass the failure count.
#[derive(Default)]
pub struct Limiter {
    clients: HashMap<IpAddr, Attempts>,
}
const FREE_FAILURES: u32 = 5;
const MAX_BACKOFF: Duration = Duration::from_secs(15 * 60);
/// At most one password verify in flight per client IP.
const MAX_IN_FLIGHT: u32 = 1;
/// Global cap on concurrent Argon2id derives (shared via [`crate::AppState`]).
pub const ARGON2_PERMITS: usize = 2;
impl Limiter {
    pub fn check(&mut self, ip: IpAddr, now: Instant) -> std::result::Result<(), Duration> {
        match self.clients.get(&ip).and_then(|a| a.blocked_until) {
            Some(until) if until > now => Err(until - now),
            _ => Ok(()),
        }
    }
    fn entry(&mut self, ip: IpAddr, now: Instant) -> &mut Attempts {
        if self.clients.len() >= 4096 {
            self.clients.retain(|_, a| {
                now.duration_since(a.last) < Duration::from_secs(3600) || a.in_flight > 0
            });
        }
        let entry = self.clients.entry(ip).or_insert(Attempts {
            failures: 0,
            blocked_until: None,
            last: now,
            in_flight: 0,
        });
        if entry.in_flight == 0 && now.duration_since(entry.last) > Duration::from_secs(3600) {
            entry.failures = 0;
            entry.blocked_until = None;
        }
        entry.last = now;
        entry
    }
    /// Reserve a verify slot under the lock. Rejects if blocked or another
    /// attempt from this IP is already in flight.
    pub fn begin(&mut self, ip: IpAddr, now: Instant) -> std::result::Result<(), Duration> {
        self.check(ip, now)?;
        let entry = self.entry(ip, now);
        if entry.in_flight >= MAX_IN_FLIGHT {
            return Err(Duration::from_secs(1));
        }
        entry.in_flight += 1;
        Ok(())
    }
    fn release_in_flight(&mut self, ip: IpAddr) {
        let remove = match self.clients.get_mut(&ip) {
            Some(entry) => {
                entry.in_flight = entry.in_flight.saturating_sub(1);
                entry.in_flight == 0 && entry.failures == 0 && entry.blocked_until.is_none()
            }
            None => false,
        };
        if remove {
            self.clients.remove(&ip);
        }
    }
    /// Drop the reservation without counting a failure (e.g. validation error).
    pub fn cancel(&mut self, ip: IpAddr) {
        self.release_in_flight(ip);
    }
    pub fn fail(&mut self, ip: IpAddr, now: Instant) {
        let entry = self.entry(ip, now);
        entry.failures += 1;
        if entry.failures >= FREE_FAILURES {
            let exp = (entry.failures - FREE_FAILURES).min(10);
            let delay = Duration::from_secs(1u64 << exp).min(MAX_BACKOFF);
            entry.blocked_until = Some(now + delay);
        }
    }
    pub fn end_fail(&mut self, ip: IpAddr, now: Instant) {
        self.release_in_flight(ip);
        self.fail(ip, now);
    }
    pub fn succeed(&mut self, ip: IpAddr) {
        self.clients.remove(&ip);
    }
    pub fn end_succeed(&mut self, ip: IpAddr) {
        self.succeed(ip);
    }
}
fn too_many(wait: Duration) -> AppError {
    AppError(
        StatusCode::TOO_MANY_REQUESTS,
        format!("尝试过于频繁，请 {} 秒后重试", wait.as_secs().max(1)),
    )
}

/// SHA-256 hex of the `Authorization: Bearer` token, the key `state.sessions` uses.
fn bearer_hash(headers: &axum::http::HeaderMap) -> Result<String> {
    let token = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .ok_or_else(AppError::unauthorized)?;
    Ok(hex::encode(Sha256::digest(token.as_bytes())))
}

/// Checks for a live session without the middleware's side effects (no idle
/// key expiry, no touch), for routes that must also work before setup.
pub(crate) async fn require_session(
    state: &AppState,
    headers: &axum::http::HeaderMap,
) -> Result<()> {
    let token = bearer_hash(headers)?;
    let valid = state
        .sessions
        .lock()
        .await
        .get(&token)
        .is_some_and(|s| s.expires > Instant::now());
    if valid {
        Ok(())
    } else {
        Err(AppError::unauthorized())
    }
}

pub async fn middleware(
    State(state): State<AppState>,
    mut request: Request,
    next: Next,
) -> Result<Response> {
    let token = bearer_hash(request.headers())?;
    let mut sessions = state.sessions.lock().await;
    sessions.retain(|_, s| s.expires > Instant::now());
    let session = sessions
        .get_mut(&token)
        .ok_or_else(AppError::unauthorized)?;
    if session.touched.elapsed() > Duration::from_secs(15 * 60) {
        session.key = None;
    }
    session.touched = Instant::now();
    request.extensions_mut().insert(Auth {
        token,
        key: session.key.clone(),
    });
    drop(sessions);
    Ok(next.run(request).await)
}

pub async fn status(State(state): State<AppState>) -> Result<Json<Value>> {
    let initialized: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM vault_config)")
        .fetch_one(&state.db)
        .await?;
    Ok(Json(
        json!({"initialized": initialized, "setupTokenRequired": !initialized, "database": "PostgreSQL", "version": env!("CARGO_PKG_VERSION")}),
    ))
}

pub(crate) async fn verify(state: &AppState, ip: ClientIp, password: String) -> Result<VaultKey> {
    state
        .login_limiter
        .lock()
        .await
        .begin(ip.0, Instant::now())
        .map_err(too_many)?;
    match verify_reserved(state, password).await {
        Ok(key) => {
            state.login_limiter.lock().await.end_succeed(ip.0);
            Ok(key)
        }
        Err(err) if err.0 == StatusCode::UNAUTHORIZED => {
            state
                .login_limiter
                .lock()
                .await
                .end_fail(ip.0, Instant::now());
            Err(err)
        }
        Err(err) => {
            state.login_limiter.lock().await.cancel(ip.0);
            Err(err)
        }
    }
}

async fn verify_reserved(state: &AppState, password: String) -> Result<VaultKey> {
    if password.len() > 1024 {
        return Err(AppError::bad("密码过长"));
    }
    let config: Option<(Vec<u8>, Vec<u8>)> =
        sqlx::query_as("SELECT salt, verifier FROM vault_config WHERE id = 1")
            .fetch_optional(&state.db)
            .await?;
    let (salt, verifier) = config.ok_or_else(|| AppError::bad("请先创建主密码"))?;
    let _permit = state
        .argon2_limit
        .acquire()
        .await
        .expect("argon2 semaphore is never closed");
    let key = crypto::derive(password, salt).await?;
    if crypto::decrypt(&key, &verifier, "infohub-vault-v1").is_err() {
        return Err(AppError(StatusCode::UNAUTHORIZED, "主密码不正确".into()));
    }
    Ok(key)
}

pub(crate) async fn new_session(state: &AppState, key: VaultKey) -> Json<Value> {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    let token = hex::encode(bytes);
    let hash = hex::encode(Sha256::digest(token.as_bytes()));
    let mut sessions = state.sessions.lock().await;
    sessions.retain(|_, s| s.expires > Instant::now());
    // Keep session memory bounded for this single-user application.
    if sessions.len() >= 32 {
        if let Some(oldest) = sessions
            .iter()
            .min_by_key(|(_, s)| s.touched)
            .map(|(k, _)| k.clone())
        {
            sessions.remove(&oldest);
        }
    }
    sessions.insert(
        hash,
        Session {
            key: Some(key),
            expires: Instant::now() + Duration::from_secs(8 * 3600),
            touched: Instant::now(),
        },
    );
    Json(json!({"token": token, "unlocked": true}))
}

/// Generates (or takes from SETUP_TOKEN) the one-time setup token and logs it
/// so only someone with access to the server logs can claim a new instance.
pub async fn prepare_setup_token(state: &AppState) -> Result<()> {
    let initialized: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM vault_config)")
        .fetch_one(&state.db)
        .await?;
    let mut token = state.setup_token.lock().await;
    if initialized {
        *token = None;
        return Ok(());
    }
    if token.is_none() {
        let mut bytes = [0u8; 12];
        rand::thread_rng().fill_bytes(&mut bytes);
        *token = Some(hex::encode(bytes));
        tracing::warn!(
            setup_token = %token.as_deref().unwrap_or_default(),
            "工作台尚未初始化：首次设置主密码时需要填写这个一次性初始化令牌"
        );
    } else {
        tracing::warn!("工作台尚未初始化：首次设置主密码时需要填写 SETUP_TOKEN 中的令牌");
    }
    Ok(())
}
pub(crate) async fn check_setup_token(state: &AppState, ip: ClientIp, given: &str) -> Result<()> {
    let mut limiter = state.login_limiter.lock().await;
    limiter.check(ip.0, Instant::now()).map_err(too_many)?;
    let expected = state.setup_token.lock().await.clone();
    let ok = expected.is_some_and(|t| {
        let (a, b) = (
            Sha256::digest(t.as_bytes()),
            Sha256::digest(given.trim().as_bytes()),
        );
        a == b
    });
    if !ok {
        limiter.fail(ip.0, Instant::now());
        return Err(AppError(
            StatusCode::FORBIDDEN,
            "初始化令牌不正确；请在服务端启动日志中查找 setup_token，或使用 SETUP_TOKEN 的值"
                .into(),
        ));
    }
    Ok(())
}
pub async fn setup(
    State(state): State<AppState>,
    ip: ClientIp,
    Json(input): Json<Setup>,
) -> Result<Json<Value>> {
    let initialized: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM vault_config)")
        .fetch_one(&state.db)
        .await?;
    if initialized {
        return Err(AppError(
            StatusCode::CONFLICT,
            "工作台已初始化，请登录".into(),
        ));
    }
    check_setup_token(&state, ip, &input.setup_token).await?;
    if input.password.chars().count() < 12 || input.password.len() > 1024 {
        return Err(AppError::bad("主密码至少 12 个字符，最长 1024 字节"));
    }
    let mut salt = vec![0; 16];
    rand::thread_rng().fill_bytes(&mut salt);
    let _permit = state
        .argon2_limit
        .acquire()
        .await
        .expect("argon2 semaphore is never closed");
    let key = crypto::derive(input.password, salt.clone()).await?;
    drop(_permit);
    let verifier = crypto::encrypt(&key, b"InfoHub vault verification", "infohub-vault-v1")?;
    let result = sqlx::query(
        "INSERT INTO vault_config(id, salt, verifier) VALUES (1, $1, $2) ON CONFLICT DO NOTHING",
    )
    .bind(salt)
    .bind(verifier)
    .execute(&state.db)
    .await?;
    if result.rows_affected() == 0 {
        return Err(AppError(
            StatusCode::CONFLICT,
            "工作台已初始化，请登录".into(),
        ));
    }
    *state.setup_token.lock().await = None;
    Ok(new_session(&state, key).await)
}
pub async fn login(
    State(state): State<AppState>,
    ip: ClientIp,
    Json(input): Json<Password>,
) -> Result<Json<Value>> {
    let key = verify(&state, ip, input.password).await?;
    Ok(new_session(&state, key).await)
}
pub async fn session(Extension(auth): Extension<Auth>) -> Json<Value> {
    Json(json!({"unlocked": auth.key.is_some()}))
}
pub async fn lock(State(state): State<AppState>, Extension(auth): Extension<Auth>) -> Json<Value> {
    if let Some(session) = state.sessions.lock().await.get_mut(&auth.token) {
        session.key = None;
    }
    Json(json!({"unlocked": false}))
}
pub async fn unlock(
    State(state): State<AppState>,
    Extension(auth): Extension<Auth>,
    ip: ClientIp,
    Json(input): Json<Password>,
) -> Result<Json<Value>> {
    let key = verify(&state, ip, input.password).await?;
    let mut sessions = state.sessions.lock().await;
    let session = sessions
        .get_mut(&auth.token)
        .ok_or_else(AppError::unauthorized)?;
    session.key = Some(key);
    session.touched = Instant::now();
    Ok(Json(json!({"unlocked": true})))
}
pub async fn logout(State(state): State<AppState>, Extension(auth): Extension<Auth>) -> StatusCode {
    state.sessions.lock().await.remove(&auth.token);
    StatusCode::NO_CONTENT
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::Body, http::Request};
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    fn state() -> AppState {
        AppState::new(
            sqlx::postgres::PgPoolOptions::new()
                .connect_lazy("postgres://test:test@127.0.0.1/test")
                .unwrap(),
            crate::storage::FileStorage::memory(),
        )
    }

    #[tokio::test]
    async fn idle_sessions_lock_and_expired_sessions_are_rejected() {
        let state = state();
        let token = new_session(&state, zeroize::Zeroizing::new([7; 32]))
            .await
            .0["token"]
            .as_str()
            .unwrap()
            .to_string();
        let hash = hex::encode(Sha256::digest(token.as_bytes()));
        state.sessions.lock().await.get_mut(&hash).unwrap().touched =
            Instant::now() - Duration::from_secs(901);
        let request = || {
            Request::builder()
                .uri("/api/session")
                .header("Authorization", format!("Bearer {token}"))
                .body(Body::empty())
                .unwrap()
        };
        let response = crate::router(state.clone())
            .oneshot(request())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body: Value =
            serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes())
                .unwrap();
        assert_eq!(body["unlocked"], false);
        assert!(state.sessions.lock().await[&hash].key.is_none());
        state.sessions.lock().await.get_mut(&hash).unwrap().expires =
            Instant::now() - Duration::from_secs(1);
        let response = crate::router(state.clone())
            .oneshot(request())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        assert!(state.sessions.lock().await.is_empty());
    }

    #[tokio::test]
    async fn session_count_is_bounded_and_tokens_are_stored_as_hashes() {
        let state = state();
        let first = new_session(&state, zeroize::Zeroizing::new([1; 32]))
            .await
            .0["token"]
            .as_str()
            .unwrap()
            .to_string();
        let hash = hex::encode(Sha256::digest(first.as_bytes()));
        state.sessions.lock().await.get_mut(&hash).unwrap().touched =
            Instant::now() - Duration::from_secs(10);
        for _ in 0..32 {
            let _ = new_session(&state, zeroize::Zeroizing::new([1; 32])).await;
        }
        let sessions = state.sessions.lock().await;
        assert_eq!(sessions.len(), 32);
        assert!(!sessions.contains_key(&first));
        assert!(!sessions.contains_key(&hash));
    }

    #[test]
    fn limiter_is_per_client_with_backoff() {
        let mut l = Limiter::default();
        let now = Instant::now();
        let attacker: IpAddr = "203.0.113.9".parse().unwrap();
        let owner: IpAddr = "198.51.100.7".parse().unwrap();
        for _ in 0..FREE_FAILURES - 1 {
            l.fail(attacker, now);
            assert!(l.check(attacker, now).is_ok());
        }
        l.fail(attacker, now);
        assert!(l.check(attacker, now).is_err());
        assert!(l.check(owner, now).is_ok());
        assert!(l.check(attacker, now + Duration::from_secs(2)).is_ok());
        for _ in 0..20 {
            l.fail(attacker, now);
        }
        let wait = l.check(attacker, now).unwrap_err();
        assert!(wait <= MAX_BACKOFF && wait > Duration::from_secs(60));
        l.succeed(attacker);
        assert!(l.check(attacker, now).is_ok());
    }

    #[test]
    fn begin_serializes_in_flight_attempts_per_client() {
        let mut l = Limiter::default();
        let now = Instant::now();
        let attacker: IpAddr = "203.0.113.9".parse().unwrap();
        let owner: IpAddr = "198.51.100.7".parse().unwrap();
        l.begin(attacker, now).unwrap();
        // Second concurrent attempt from the same IP is rejected while the
        // first reservation is held — this closes the check-then-Argon2 race.
        assert!(l.begin(attacker, now).is_err());
        assert!(l.begin(owner, now).is_ok());
        l.cancel(attacker);
        for _ in 0..FREE_FAILURES {
            l.begin(attacker, now).unwrap();
            l.end_fail(attacker, now);
        }
        assert!(l.check(attacker, now).is_err());
        assert!(l.begin(attacker, now).is_err());
        // Other clients are unaffected.
        l.end_succeed(owner);
        assert!(l.begin(owner, now).is_ok());
        l.end_succeed(owner);
    }

    #[test]
    fn cancel_does_not_count_as_failure() {
        let mut l = Limiter::default();
        let now = Instant::now();
        let ip: IpAddr = "203.0.113.10".parse().unwrap();
        for _ in 0..FREE_FAILURES {
            l.begin(ip, now).unwrap();
            l.cancel(ip);
        }
        assert!(l.begin(ip, now).is_ok());
        l.end_succeed(ip);
    }
    #[test]
    fn forwarded_for_is_only_trusted_from_configured_proxies() {
        let mut headers = HeaderMap::new();
        headers.insert("x-forwarded-for", "1.1.1.1, 9.9.9.9".parse().unwrap());
        let proxy: IpAddr = "10.0.0.2".parse().unwrap();
        assert_eq!(client_ip(Some(proxy), &headers, &[]), proxy);
        assert_eq!(
            client_ip(Some(proxy), &headers, &[proxy]),
            "9.9.9.9".parse::<IpAddr>().unwrap()
        );
    }
}
