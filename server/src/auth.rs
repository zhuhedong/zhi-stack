use crate::{
    crypto::{self, VaultKey},
    error::{AppError, Result},
    AppState,
};
use axum::{
    extract::{Request, State},
    http::StatusCode,
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

pub async fn middleware(
    State(state): State<AppState>,
    mut request: Request,
    next: Next,
) -> Result<Response> {
    let token = request
        .headers()
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .ok_or_else(AppError::unauthorized)?;
    let token = hex::encode(Sha256::digest(token.as_bytes()));
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
        json!({"initialized": initialized, "database": "PostgreSQL", "version": env!("CARGO_PKG_VERSION")}),
    ))
}

async fn throttle(state: &AppState) -> Result<()> {
    let mut attempts = state.login_attempts.lock().await;
    if attempts.0.elapsed() > Duration::from_secs(60) {
        *attempts = (Instant::now(), 0);
    }
    if attempts.1 >= 10 {
        return Err(AppError(
            StatusCode::TOO_MANY_REQUESTS,
            "尝试过于频繁，请一分钟后重试".into(),
        ));
    }
    attempts.1 += 1;
    Ok(())
}

pub(crate) async fn verify(state: &AppState, password: String) -> Result<VaultKey> {
    throttle(state).await?;
    if password.len() > 1024 {
        return Err(AppError::bad("密码过长"));
    }
    let config: Option<(Vec<u8>, Vec<u8>)> =
        sqlx::query_as("SELECT salt, verifier FROM vault_config WHERE id = 1")
            .fetch_optional(&state.db)
            .await?;
    let (salt, verifier) = config.ok_or_else(|| AppError::bad("请先创建主密码"))?;
    let key = crypto::derive(password, salt).await?;
    crypto::decrypt(&key, &verifier, "infohub-vault-v1")
        .map_err(|_| AppError(StatusCode::UNAUTHORIZED, "主密码不正确".into()))?;
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

pub async fn setup(
    State(state): State<AppState>,
    Json(input): Json<Password>,
) -> Result<Json<Value>> {
    throttle(&state).await?;
    if input.password.chars().count() < 12 || input.password.len() > 1024 {
        return Err(AppError::bad("主密码至少 12 个字符，最长 1024 字节"));
    }
    let mut salt = vec![0; 16];
    rand::thread_rng().fill_bytes(&mut salt);
    let key = crypto::derive(input.password, salt.clone()).await?;
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
    Ok(new_session(&state, key).await)
}
pub async fn login(
    State(state): State<AppState>,
    Json(input): Json<Password>,
) -> Result<Json<Value>> {
    let key = verify(&state, input.password).await?;
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
    Json(input): Json<Password>,
) -> Result<Json<Value>> {
    let key = verify(&state, input.password).await?;
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

    #[tokio::test]
    async fn login_rate_limit_recovers_after_its_window() {
        let state = state();
        for _ in 0..10 {
            assert!(throttle(&state).await.is_ok());
        }
        assert_eq!(
            throttle(&state).await.unwrap_err().0,
            StatusCode::TOO_MANY_REQUESTS
        );
        state.login_attempts.lock().await.0 = Instant::now() - Duration::from_secs(61);
        assert!(throttle(&state).await.is_ok());
    }
}
