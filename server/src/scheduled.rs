//! Scheduled automatic backups to the configured file storage (local or R2)
//! and/or a server directory (BACKUP_DIR). Files use the normal encrypted
//! backup format and restore with the master password that was current when
//! the schedule was enabled (or last rotated).
use crate::{
    auth::{self, Auth},
    backup, crypto,
    error::{AppError, Result},
    service_key, AppState,
};
use axum::{
    extract::{Path, State},
    http::StatusCode,
    Extension, Json,
};
use rand::RngCore;
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::{Postgres, Transaction};
use std::time::Duration;
use uuid::Uuid;

type DueRow = (Vec<String>, i32, Vec<u8>, Vec<u8>);
const KEY_CONTEXT: &str = "infohub-scheduled-backup-key";

fn backup_dir() -> Option<std::path::PathBuf> {
    std::env::var("BACKUP_DIR")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .map(Into::into)
}
async fn ensure_row(state: &AppState) -> Result<()> {
    sqlx::query("INSERT INTO backup_schedule(id) VALUES(1) ON CONFLICT DO NOTHING")
        .execute(&state.db)
        .await?;
    Ok(())
}

pub async fn status(State(state): State<AppState>) -> Result<Json<Value>> {
    ensure_row(&state).await?;
    let schedule: Value = sqlx::query_scalar("SELECT jsonb_build_object('enabled',enabled,'intervalHours',interval_hours,'keep',keep,'targets',targets,'nextRunAt',next_run_at,'lastRunAt',last_run_at,'lastStatus',last_status,'lastMessage',last_message,'running',running,'hasKey',wrapped_key IS NOT NULL) FROM backup_schedule WHERE id=1")
        .fetch_one(&state.db)
        .await?;
    let backups: Vec<Value> = sqlx::query_scalar("SELECT jsonb_build_object('id',id,'target',target,'name',regexp_replace(location,'^.*/',''),'size',size,'createdAt',created_at) FROM scheduled_backups ORDER BY created_at DESC LIMIT 200")
        .fetch_all(&state.db)
        .await?;
    Ok(Json(json!({
        "schedule": schedule,
        "backups": backups,
        "storage": state.storage.kind,
        "dirAvailable": backup_dir().is_some(),
        "serviceKey": service_key::get().await.is_ok(),
    })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleInput {
    pub enabled: bool,
    pub interval_hours: i32,
    pub keep: i32,
    pub targets: Vec<String>,
    /// Master password: required to enable for the first time (derives the backup key).
    #[serde(default)]
    pub password: String,
}
pub async fn update(
    State(state): State<AppState>,
    Extension(auth): Extension<Auth>,
    ip: auth::ClientIp,
    Json(input): Json<ScheduleInput>,
) -> Result<Json<Value>> {
    auth.vault()?;
    ensure_row(&state).await?;
    if !(1..=720).contains(&input.interval_hours) || !(1..=100).contains(&input.keep) {
        return Err(AppError::bad("间隔为 1–720 小时，保留 1–100 份"));
    }
    let mut targets = input.targets.clone();
    targets.sort();
    targets.dedup();
    if targets.is_empty() || targets.iter().any(|t| t != "storage" && t != "dir") {
        return Err(AppError::bad("请选择至少一个备份位置"));
    }
    if targets.iter().any(|t| t == "dir") && backup_dir().is_none() {
        return Err(AppError::bad("服务端未配置 BACKUP_DIR，无法备份到本地目录"));
    }
    let has_key: bool =
        sqlx::query_scalar("SELECT wrapped_key IS NOT NULL FROM backup_schedule WHERE id=1")
            .fetch_one(&state.db)
            .await?;
    let mut wrapped: Option<(Vec<u8>, Vec<u8>)> = None;
    if !input.password.is_empty() || (input.enabled && !has_key) {
        if input.password.is_empty() {
            return Err(AppError::bad("首次启用需要输入主密码，用于加密定时备份"));
        }
        auth::verify(&state, ip, input.password.clone()).await?;
        let mut salt = vec![0; 16];
        rand::thread_rng().fill_bytes(&mut salt);
        let key = crypto::derive(input.password, salt.clone()).await?;
        wrapped = Some((salt, service_key::seal(key.as_ref(), KEY_CONTEXT).await?));
    }
    sqlx::query("UPDATE backup_schedule SET enabled=$1,interval_hours=$2,keep=$3,targets=$4,salt=COALESCE($5,salt),wrapped_key=COALESCE($6,wrapped_key),next_run_at=CASE WHEN $1 AND NOT enabled THEN now()+make_interval(hours=>$2) WHEN $1 THEN COALESCE(last_run_at,now())+make_interval(hours=>$2) ELSE next_run_at END WHERE id=1")
        .bind(input.enabled)
        .bind(input.interval_hours)
        .bind(input.keep)
        .bind(&targets)
        .bind(wrapped.as_ref().map(|w| w.0.clone()))
        .bind(wrapped.as_ref().map(|w| w.1.clone()))
        .execute(&state.db)
        .await?;
    state.backups_notify.notify_one();
    status(State(state)).await
}
pub async fn run_now(State(state): State<AppState>) -> Result<StatusCode> {
    ensure_row(&state).await?;
    let changed = sqlx::query(
        "UPDATE backup_schedule SET next_run_at=now() WHERE id=1 AND wrapped_key IS NOT NULL",
    )
    .execute(&state.db)
    .await?;
    if changed.rows_affected() == 0 {
        return Err(AppError::bad("请先输入主密码启用定时备份"));
    }
    state.backups_notify.notify_one();
    Ok(StatusCode::ACCEPTED)
}

/// Re-derive the schedule key when the master password changes, so new
/// scheduled backups follow the new password.
pub(crate) async fn rekey(tx: &mut Transaction<'_, Postgres>, password: &str) -> Result<()> {
    let salt: Option<Option<Vec<u8>>> = sqlx::query_scalar(
        "SELECT salt FROM backup_schedule WHERE id=1 AND wrapped_key IS NOT NULL",
    )
    .fetch_optional(&mut **tx)
    .await?;
    let Some(Some(salt)) = salt else {
        return Ok(());
    };
    let key = crypto::derive(password.to_string(), salt).await?;
    sqlx::query("UPDATE backup_schedule SET wrapped_key=$1 WHERE id=1")
        .bind(service_key::seal(key.as_ref(), KEY_CONTEXT).await?)
        .execute(&mut **tx)
        .await?;
    Ok(())
}

async fn read_backup(state: &AppState, id: Uuid) -> Result<tempfile::NamedTempFile> {
    let (target, location, sha): (String, String, String) =
        sqlx::query_as("SELECT target,location,sha256 FROM scheduled_backups WHERE id=$1")
            .bind(id)
            .fetch_optional(&state.db)
            .await?
            .ok_or_else(|| AppError(StatusCode::NOT_FOUND, "备份不存在".into()))?;
    let bytes = if target == "storage" {
        state
            .storage
            .read_large(&location, state.settings.max_backup_bytes)
            .await?
    } else {
        let dir = backup_dir().ok_or_else(|| AppError::bad("服务端未配置 BACKUP_DIR"))?;
        tokio::fs::read(dir.join(&location))
            .await
            .map_err(|_| AppError::bad("备份文件不存在或无法读取"))?
    };
    if crate::storage::digest(&bytes) != sha {
        return Err(AppError::bad("备份文件校验失败，可能已损坏"));
    }
    let temp = tempfile::NamedTempFile::new().map_err(|_| AppError::bad("无法创建临时文件"))?;
    tokio::fs::write(temp.path(), bytes)
        .await
        .map_err(|_| AppError::bad("无法写入临时文件"))?;
    Ok(temp)
}
async fn remove_file(state: &AppState, target: &str, location: &str) {
    if target == "storage" {
        let _ = state.storage.delete(location).await;
    } else if let Some(dir) = backup_dir() {
        let _ = tokio::fs::remove_file(dir.join(location)).await;
    }
}
pub async fn delete(State(state): State<AppState>, Path(id): Path<Uuid>) -> Result<StatusCode> {
    let row: Option<(String, String)> =
        sqlx::query_as("DELETE FROM scheduled_backups WHERE id=$1 RETURNING target,location")
            .bind(id)
            .fetch_optional(&state.db)
            .await?;
    let (target, location) =
        row.ok_or_else(|| AppError(StatusCode::NOT_FOUND, "备份不存在".into()))?;
    remove_file(&state, &target, &location).await;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreInput {
    /// Current master password (re-authentication, as for uploaded restores).
    pub current_password: String,
    /// Master password the backup was made with.
    pub password: String,
    pub confirm: String,
}
pub async fn restore(
    State(state): State<AppState>,
    Extension(auth): Extension<Auth>,
    ip: auth::ClientIp,
    Path(id): Path<Uuid>,
    Json(input): Json<RestoreInput>,
) -> Result<Json<Value>> {
    auth.vault()?;
    if input.confirm != "恢复并替换" || input.password.is_empty() {
        return Err(AppError::bad(
            "请填写备份时的主密码，并输入“恢复并替换”确认",
        ));
    }
    auth::verify(&state, ip, input.current_password).await?;
    let temp = read_backup(&state, id).await?;
    backup::audit_schema(&state).await?;
    backup::load_backup(&state, temp.path(), input.password).await?;
    // The schedule key belonged to the replaced data's password: require re-enabling.
    sqlx::query("UPDATE backup_schedule SET enabled=false,wrapped_key=NULL,salt=NULL,last_message='已从备份恢复，请重新输入主密码启用定时备份' WHERE id=1")
        .execute(&state.db)
        .await?;
    state.sessions.lock().await.clear();
    state.file_cleanup.notify_one();
    Ok(Json(
        json!({"restored":true,"message":"恢复完成，请使用备份时的主密码登录"}),
    ))
}

pub async fn initialize(state: &AppState) -> Result<()> {
    sqlx::query("UPDATE backup_schedule SET running=false,last_status='failed',last_message='上次备份因服务中断未完成' WHERE running")
        .execute(&state.db)
        .await?;
    Ok(())
}
pub async fn worker(state: AppState) {
    loop {
        tokio::select! {_=state.backups_notify.notified()=>{},_=tokio::time::sleep(Duration::from_secs(60))=>{}}
        if let Err(error) = tick(&state).await {
            tracing::warn!(status=%error.0, "scheduled backup failed");
        }
    }
}
async fn tick(state: &AppState) -> Result<()> {
    let due: Option<DueRow> = sqlx::query_as("UPDATE backup_schedule SET running=true,next_run_at=now()+make_interval(hours=>interval_hours) WHERE id=1 AND enabled AND NOT running AND wrapped_key IS NOT NULL AND next_run_at<=now() RETURNING targets,keep,salt,wrapped_key")
        .fetch_optional(&state.db)
        .await?;
    let Some((targets, keep, salt, wrapped)) = due else {
        return Ok(());
    };
    let result = run(state, &targets, keep, &salt, &wrapped).await;
    let (status, message) = match &result {
        Ok(size) => (
            "success",
            format!("已备份 {:.1} MB", *size as f64 / 1048576.0),
        ),
        Err(error) => ("failed", error.1.clone()),
    };
    sqlx::query("UPDATE backup_schedule SET running=false,last_run_at=now(),last_status=$1,last_message=$2 WHERE id=1")
        .bind(status)
        .bind(message)
        .execute(&state.db)
        .await?;
    result.map(|_| ())
}
async fn run(
    state: &AppState,
    targets: &[String],
    keep: i32,
    salt: &[u8],
    wrapped: &[u8],
) -> Result<u64> {
    let plain = service_key::open(wrapped, KEY_CONTEXT).await?;
    let mut key = zeroize::Zeroizing::new([0u8; 32]);
    if plain.len() != 32 {
        return Err(AppError::bad("定时备份密钥无效，请重新启用"));
    }
    key.copy_from_slice(&plain);
    let (temp, size) = {
        // Same exclusivity as a manual export: a consistent snapshot.
        let _guard = state.maintenance.write().await;
        backup::audit_schema(state).await?;
        backup::make_backup_with_key(state, key, salt).await?
    };
    if size > state.settings.max_backup_bytes {
        return Err(AppError::bad("备份超过 MAX_BACKUP_BYTES 上限"));
    }
    let bytes = tokio::fs::read(temp.path())
        .await
        .map_err(|_| AppError::bad("无法读取备份临时文件"))?;
    let sha = crate::storage::digest(&bytes);
    let stamp = chrono::Utc::now().format("%Y%m%d-%H%M%S");
    for target in targets {
        let id = Uuid::new_v4();
        let location = if target == "storage" {
            let key = format!("backups/{id}");
            state.storage.put_large(&key, bytes.clone()).await?;
            key
        } else {
            let dir = backup_dir().ok_or_else(|| AppError::bad("服务端未配置 BACKUP_DIR"))?;
            tokio::fs::create_dir_all(&dir)
                .await
                .map_err(|_| AppError::bad("无法创建 BACKUP_DIR"))?;
            let name = format!("infohub-{stamp}-{}.infohub", &id.to_string()[..8]);
            let path = dir.join(&name);
            tokio::fs::write(&path, &bytes)
                .await
                .map_err(|_| AppError::bad("无法写入 BACKUP_DIR"))?;
            name
        };
        sqlx::query(
            "INSERT INTO scheduled_backups(id,target,location,size,sha256) VALUES($1,$2,$3,$4,$5)",
        )
        .bind(id)
        .bind(target)
        .bind(&location)
        .bind(size as i64)
        .bind(&sha)
        .execute(&state.db)
        .await?;
        let old: Vec<(String, String)> = sqlx::query_as("DELETE FROM scheduled_backups WHERE id IN (SELECT id FROM scheduled_backups WHERE target=$1 ORDER BY created_at DESC OFFSET $2) RETURNING target,location")
            .bind(target)
            .bind(keep as i64)
            .fetch_all(&state.db)
            .await?;
        for (target, location) in old {
            remove_file(state, &target, &location).await;
        }
    }
    Ok(size)
}
