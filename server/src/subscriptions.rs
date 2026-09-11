use crate::{
    error::{AppError, Result},
    ingest, AppState,
};
use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::time::Duration;
use uuid::Uuid;

fn snapshot(data: &Value) -> Value {
    let mut result = json!({});
    for key in [
        "latestRelease",
        "releaseDate",
        "releaseUrl",
        "releaseNotes",
        "pushedAt",
    ] {
        if let Some(value) = data.get(key) {
            result[key] = value.clone();
        }
    }
    result
}
fn signature(value: &Value) -> String {
    hex::encode(Sha256::digest(
        json!([
            value["latestRelease"],
            value["releaseDate"],
            value["pushedAt"]
        ])
        .to_string(),
    ))
}
async fn check(state: &AppState, id: Uuid) -> Result<Value> {
    sqlx::query_scalar("SELECT data FROM items WHERE id=$1 AND kind='repo' AND deleted_at IS NULL")
        .bind(id)
        .fetch_one(&state.db)
        .await
        .map_err(Into::into)
}
pub async fn all(State(state): State<AppState>) -> Result<Json<Value>> {
    let rows:Vec<Value>=sqlx::query_scalar("SELECT to_jsonb(s)||jsonb_build_object('title',i.title,'unread',s.signature<>s.seen_signature) FROM repo_subscriptions s JOIN items i ON i.id=s.item_id WHERE i.deleted_at IS NULL ORDER BY (s.signature<>s.seen_signature) DESC,s.last_checked_at DESC NULLS LAST").fetch_all(&state.db).await?;
    Ok(Json(json!(rows)))
}
pub async fn get(State(state): State<AppState>, Path(id): Path<Uuid>) -> Result<Json<Value>> {
    check(&state, id).await?;
    let value:Option<Value>=sqlx::query_scalar("SELECT to_jsonb(s)||jsonb_build_object('unread',signature<>seen_signature) FROM repo_subscriptions s WHERE item_id=$1").bind(id).fetch_optional(&state.db).await?;
    let checks: Vec<Value> = sqlx::query_scalar(
        "SELECT to_jsonb(c) FROM repo_checks c WHERE item_id=$1 ORDER BY created_at DESC LIMIT 20",
    )
    .bind(id)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(
        json!({"subscription":value.unwrap_or(json!({"enabled":false,"interval_hours":24,"revision":0,"snapshot":{},"unread":false})),"checks":checks}),
    ))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub enabled: bool,
    pub interval_hours: i32,
    pub revision: i64,
}
pub async fn update(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Json(input): Json<Settings>,
) -> Result<StatusCode> {
    if !(1..=168).contains(&input.interval_hours) {
        return Err(AppError::bad("检查间隔为 1–168 小时"));
    }
    let data = check(&state, id).await?;
    let url: String = sqlx::query_scalar("SELECT url FROM items WHERE id=$1")
        .bind(id)
        .fetch_one(&state.db)
        .await?;
    let parsed = crate::net::parse_url(&url)?;
    if !ingest::is_github_host(parsed.host_str()) {
        return Err(AppError::bad("请先为仓库填写 GitHub 来源地址"));
    }
    let mut tx = state.db.begin().await?;
    sqlx::query("SELECT id FROM items WHERE id=$1 FOR UPDATE")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    let revision: Option<i64> =
        sqlx::query_scalar("SELECT revision FROM repo_subscriptions WHERE item_id=$1 FOR UPDATE")
            .bind(id)
            .fetch_optional(&mut *tx)
            .await?;
    if revision.unwrap_or(0) != input.revision {
        return Err(AppError(
            StatusCode::CONFLICT,
            "订阅设置已修改，请刷新后重试".into(),
        ));
    }
    let value = snapshot(&data);
    let hash = signature(&value);
    sqlx::query("INSERT INTO repo_subscriptions(item_id,enabled,interval_hours,snapshot,signature,seen_signature) VALUES($1,$2,$3,$4,$5,$5) ON CONFLICT(item_id) DO UPDATE SET enabled=$2,interval_hours=$3,revision=repo_subscriptions.revision+1,next_check_at=CASE WHEN $2 THEN now() ELSE repo_subscriptions.next_check_at END").bind(id).bind(input.enabled).bind(input.interval_hours).bind(value).bind(hash).execute(&mut *tx).await?;
    tx.commit().await?;
    state.subscriptions_notify.notify_one();
    Ok(StatusCode::NO_CONTENT)
}
pub async fn request_check(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<StatusCode> {
    check(&state, id).await?;
    let changed = sqlx::query(
        "UPDATE repo_subscriptions SET next_check_at=now() WHERE item_id=$1 AND enabled",
    )
    .bind(id)
    .execute(&state.db)
    .await?;
    if changed.rows_affected() == 0 {
        return Err(AppError::bad("请先开启仓库订阅"));
    }
    state.subscriptions_notify.notify_one();
    Ok(StatusCode::ACCEPTED)
}
#[derive(Deserialize)]
pub struct Seen {
    pub signature: String,
}
pub async fn seen(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Json(input): Json<Seen>,
) -> Result<StatusCode> {
    check(&state, id).await?;
    if input.signature.len() != 64 || !input.signature.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(AppError::bad("更新标识无效，请刷新后重试"));
    }
    sqlx::query("UPDATE repo_subscriptions SET seen_signature=$2 WHERE item_id=$1")
        .bind(id)
        .bind(input.signature)
        .execute(&state.db)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}
pub async fn initialize(state: &AppState) -> Result<()> {
    sqlx::query("UPDATE repo_subscriptions SET checking=false,next_check_at=now(),last_error='上次检查因服务中断，将重新检查' WHERE checking").execute(&state.db).await?;
    Ok(())
}
pub async fn worker(state: AppState) {
    let mut recovery_needed = false;
    loop {
        tokio::select! {_=state.subscriptions_notify.notified()=>{},_=tokio::time::sleep(Duration::from_secs(30))=>{}}
        loop {
            let _guard = state.maintenance.read().await;
            if recovery_needed {
                if initialize(&state).await.is_err() {
                    break;
                }
                recovery_needed = false;
            }
            match next(&state).await {
                Ok(true) => {}
                Ok(false) => break,
                Err(error) => {
                    recovery_needed = true;
                    tracing::warn!(status=%error.0,"repository check encountered a storage error");
                    break;
                }
            }
        }
    }
}
async fn next(state: &AppState) -> Result<bool> {
    let mut tx = state.db.begin().await?;
    let row:Option<(Uuid,String,Value)>=sqlx::query_as("SELECT s.item_id,i.url,s.snapshot FROM repo_subscriptions s JOIN items i ON i.id=s.item_id WHERE s.enabled AND NOT s.checking AND s.next_check_at<=now() AND i.deleted_at IS NULL ORDER BY s.next_check_at FOR UPDATE OF s SKIP LOCKED LIMIT 1").fetch_optional(&mut *tx).await?;
    let Some((id, url, mut value)) = row else {
        return Ok(false);
    };
    sqlx::query("UPDATE repo_subscriptions SET checking=true,next_check_at=now()+make_interval(hours=>interval_hours) WHERE item_id=$1").bind(id).execute(&mut *tx).await?;
    tx.commit().await?;
    let (status, message) = match ingest::collect(state, &url, "repo").await {
        Ok(collected) => {
            let latest = snapshot(&collected.input.data);
            for (key, field) in latest.as_object().into_iter().flatten() {
                value[key] = field.clone();
            }
            (
                if collected.warnings.is_empty() {
                    "success"
                } else {
                    "partial"
                },
                collected.warnings.join("；"),
            )
        }
        Err(error) => ("failed", error.1),
    };
    let hash = signature(&value);
    let mut tx = state.db.begin().await?;
    let changed=sqlx::query("UPDATE repo_subscriptions SET checking=false,last_checked_at=now(),last_error=$2,snapshot=$3,signature=$4 WHERE item_id=$1").bind(id).bind(&message).bind(&value).bind(hash).execute(&mut *tx).await?;
    if changed.rows_affected() > 0 {
        sqlx::query(
            "INSERT INTO repo_checks(id,item_id,status,snapshot,message) VALUES($1,$2,$3,$4,$5)",
        )
        .bind(Uuid::new_v4())
        .bind(id)
        .bind(status)
        .bind(value)
        .bind(message)
        .execute(&mut *tx)
        .await?;
        sqlx::query("DELETE FROM repo_checks WHERE item_id=$1 AND id NOT IN (SELECT id FROM repo_checks WHERE item_id=$1 ORDER BY created_at DESC LIMIT 100)").bind(id).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    Ok(true)
}
