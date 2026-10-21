//! Personal API tokens (`ihp_…`) for scripts, the CLI and the MCP endpoint.
//!
//! Tokens are random 32-byte values shown once; only their SHA-256 is stored.
//! A token never carries the vault key, so encrypted credential fields stay
//! inaccessible, and it may only reach an explicit allowlist of routes.
use crate::{
    auth::Auth,
    error::{AppError, Result},
    AppState,
};
use axum::{
    extract::{Path, State},
    http::{Method, StatusCode},
    Extension, Json,
};
use rand::RngCore;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;

pub const PREFIX: &str = "ihp_";
pub const SCOPES: [&str; 2] = ["read", "write"];

/// Scope needed for a route, or None if tokens may not use it at all.
pub fn required_scope(method: &Method, path: &str) -> Option<&'static str> {
    let path = path.strip_prefix("/api").unwrap_or(path);
    let segments: Vec<&str> = path.trim_matches('/').split('/').collect();
    let uuid = |s: &str| Uuid::parse_str(s).is_ok();
    match (method.as_str(), segments.as_slice()) {
        ("GET", ["items"]) | ("GET", ["tags"]) | ("GET", ["projects"]) | ("GET", ["jobs"]) => {
            Some("read")
        }
        ("GET", ["items", id]) if uuid(id) => Some("read"),
        ("GET", ["items", id, "highlights"]) if uuid(id) => Some("read"),
        ("POST", ["items"]) | ("POST", ["jobs"]) => Some("write"),
        // MCP checks per-tool scopes itself; read is the minimum.
        ("POST", ["mcp"]) | ("GET", ["mcp"]) => Some("read"),
        _ => None,
    }
}
pub fn hash(token: &str) -> String {
    hex::encode(Sha256::digest(token.as_bytes()))
}

/// Validates an `ihp_` bearer token for `method path`; returns the request's Auth.
pub async fn authenticate(
    state: &AppState,
    token: &str,
    method: &Method,
    path: &str,
) -> Result<Auth> {
    let row: Option<(Uuid, Vec<String>)> = sqlx::query_as(
        "UPDATE api_tokens SET last_used_at=CASE WHEN last_used_at IS NULL OR last_used_at<now()-interval '1 minute' THEN now() ELSE last_used_at END WHERE token_hash=$1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>now()) RETURNING id,scopes",
    )
    .bind(hash(token))
    .fetch_optional(&state.db)
    .await?;
    let (id, scopes) = row.ok_or_else(|| {
        AppError(
            StatusCode::UNAUTHORIZED,
            "API 令牌无效、已过期或已撤销".into(),
        )
    })?;
    let needed = required_scope(method, path)
        .ok_or_else(|| AppError(StatusCode::FORBIDDEN, "API 令牌不能访问该接口".into()))?;
    if !scopes.iter().any(|s| s == needed) {
        return Err(AppError(
            StatusCode::FORBIDDEN,
            format!("API 令牌缺少 {needed} 权限"),
        ));
    }
    Ok(Auth {
        token: format!("api-token:{id}"),
        key: None,
        scopes: Some(scopes),
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateToken {
    pub name: String,
    pub scopes: Vec<String>,
    /// Days until expiry; None never expires.
    pub expires_in_days: Option<i64>,
}
fn session_only(auth: &Auth) -> Result<()> {
    if auth.scopes.is_some() {
        return Err(AppError(
            StatusCode::FORBIDDEN,
            "请使用登录会话管理 API 令牌".into(),
        ));
    }
    Ok(())
}
pub async fn list(
    State(state): State<AppState>,
    Extension(auth): Extension<Auth>,
) -> Result<Json<Value>> {
    session_only(&auth)?;
    let tokens: Vec<Value> = sqlx::query_scalar("SELECT jsonb_build_object('id',id,'name',name,'prefix',prefix,'scopes',scopes,'createdAt',created_at,'lastUsedAt',last_used_at,'expiresAt',expires_at,'revokedAt',revoked_at,'expired',expires_at IS NOT NULL AND expires_at<=now()) FROM api_tokens ORDER BY revoked_at IS NOT NULL, created_at DESC")
        .fetch_all(&state.db)
        .await?;
    Ok(Json(json!({ "tokens": tokens })))
}
pub async fn create(
    State(state): State<AppState>,
    Extension(auth): Extension<Auth>,
    Json(input): Json<CreateToken>,
) -> Result<(StatusCode, Json<Value>)> {
    session_only(&auth)?;
    let name = input.name.trim();
    if name.is_empty() || name.chars().count() > 80 {
        return Err(AppError::bad("请填写 1–80 字的令牌名称"));
    }
    let mut scopes: Vec<String> = input.scopes.iter().map(|s| s.trim().to_string()).collect();
    scopes.sort();
    scopes.dedup();
    if scopes.is_empty() || scopes.iter().any(|s| !SCOPES.contains(&s.as_str())) {
        return Err(AppError::bad("权限只能是 read 和/或 write"));
    }
    if let Some(days) = input.expires_in_days {
        if !(1..=3650).contains(&days) {
            return Err(AppError::bad("有效期需在 1–3650 天之间"));
        }
    }
    let active: i64 =
        sqlx::query_scalar("SELECT count(*) FROM api_tokens WHERE revoked_at IS NULL")
            .fetch_one(&state.db)
            .await?;
    if active >= 50 {
        return Err(AppError::bad("有效令牌最多 50 个，请先撤销不用的令牌"));
    }
    let mut bytes = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    let token = format!("{PREFIX}{}", hex::encode(bytes));
    let id = Uuid::new_v4();
    let prefix: String = token.chars().take(PREFIX.len() + 6).collect();
    let expires_at: Option<chrono::DateTime<chrono::Utc>> = sqlx::query_scalar(
        "INSERT INTO api_tokens(id,name,prefix,token_hash,scopes,expires_at) VALUES($1,$2,$3,$4,$5,CASE WHEN $6::bigint IS NULL THEN NULL ELSE now()+make_interval(days=>$6::int) END) RETURNING expires_at",
    )
    .bind(id)
    .bind(name)
    .bind(&prefix)
    .bind(hash(&token))
    .bind(&scopes)
    .bind(input.expires_in_days)
    .fetch_one(&state.db)
    .await?;
    Ok((
        StatusCode::CREATED,
        Json(
            json!({"id": id, "token": token, "prefix": prefix, "scopes": scopes, "expiresAt": expires_at}),
        ),
    ))
}
pub async fn revoke(
    State(state): State<AppState>,
    Extension(auth): Extension<Auth>,
    Path(id): Path<Uuid>,
) -> Result<StatusCode> {
    session_only(&auth)?;
    let done =
        sqlx::query("UPDATE api_tokens SET revoked_at=now() WHERE id=$1 AND revoked_at IS NULL")
            .bind(id)
            .execute(&state.db)
            .await?;
    if done.rows_affected() == 0 {
        return Err(AppError(StatusCode::NOT_FOUND, "令牌不存在或已撤销".into()));
    }
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn allowlist() {
        let id = Uuid::new_v4().to_string();
        assert_eq!(required_scope(&Method::GET, "/items"), Some("read"));
        assert_eq!(
            required_scope(&Method::GET, &format!("/api/items/{id}")),
            Some("read")
        );
        assert_eq!(required_scope(&Method::POST, "/jobs"), Some("write"));
        assert_eq!(required_scope(&Method::POST, "/mcp"), Some("read"));
        assert_eq!(required_scope(&Method::PUT, &format!("/items/{id}")), None);
        assert_eq!(
            required_scope(&Method::DELETE, &format!("/items/{id}")),
            None
        );
        assert_eq!(required_scope(&Method::GET, "/tokens"), None);
        assert_eq!(required_scope(&Method::POST, "/backup/export"), None);
        assert_eq!(required_scope(&Method::GET, "/items/not-a-uuid"), None);
        assert_eq!(
            required_scope(&Method::GET, &format!("/items/{id}/export")),
            None
        );
        assert_eq!(required_scope(&Method::POST, "/vault/password"), None);
    }
}
