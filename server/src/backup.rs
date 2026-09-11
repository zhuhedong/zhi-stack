//! Portable backups contain typed records and file bytes, encrypted in bounded
//! authenticated frames. No database URLs, storage credentials or machine paths
//! are exported. A final authenticated digest detects truncation/reordering.
use crate::{
    auth::{self, Auth},
    crypto::{self, VaultKey},
    error::{AppError, Result},
    files,
    storage::digest,
    AppState,
};
use axum::{
    body::Body,
    extract::{Multipart, Path, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::Response,
    Extension, Json,
};
use futures_util::{StreamExt, TryStreamExt};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap};
use tokio::{
    fs::File,
    io::{AsyncReadExt, AsyncWriteExt},
};
use uuid::Uuid;

const MAGIC: &[u8] = b"INFOHUB-BACKUP-1\n";
const MAX_FRAME: usize = 16 * 1024 * 1024;
// In FK order. A schema audit below refuses to silently omit future tables.
const TABLES: &[&str] = &[
    "vault_config",
    "projects",
    "items",
    "item_versions",
    "drafts",
    "attachments",
    "media",
    "version_media",
    "item_relations",
    "item_state",
    "saved_views",
    "api_history",
    "ingest_jobs",
    "repo_subscriptions",
    "repo_checks",
    "workbench_preferences",
    "usage_events",
    "feedback",
];

fn invalid() -> AppError {
    AppError::bad("备份文件不完整、密码错误或校验失败；当前数据未被替换")
}
fn io_error(_: impl std::fmt::Display) -> AppError {
    AppError::bad("无法读写备份临时文件，请检查磁盘空间与权限")
}
fn json_bytes(value: &Value) -> Result<Vec<u8>> {
    serde_json::to_vec(value).map_err(|_| invalid())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangePassword {
    pub current_password: String,
    pub new_password: String,
}
pub async fn change_password(
    State(state): State<AppState>,
    Extension(auth): Extension<Auth>,
    Json(input): Json<ChangePassword>,
) -> Result<Json<Value>> {
    auth.vault()?;
    if input.new_password.chars().count() < 12 || input.new_password.len() > 1024 {
        return Err(AppError::bad("新主密码至少 12 个字符，最长 1024 字节"));
    }
    let old = auth::verify(&state, input.current_password).await?;
    let mut salt = vec![0; 16];
    rand::thread_rng().fill_bytes(&mut salt);
    let new = crypto::derive(input.new_password, salt.clone()).await?;
    let verifier = crypto::encrypt(&new, b"InfoHub vault verification", "infohub-vault-v1")?;
    let mut tx = state.db.begin().await?;
    sqlx::query("SELECT set_config('infohub.skip_snapshot','on',true)")
        .execute(&mut *tx)
        .await?;
    for (table, context) in [("items", "id"), ("item_versions", "item_id")] {
        let rows: Vec<(Uuid, Uuid, Vec<u8>)> = sqlx::query_as(&format!(
            "SELECT id,{context},secret FROM {table} WHERE secret IS NOT NULL"
        ))
        .fetch_all(&mut *tx)
        .await?;
        for (id, context, secret) in rows {
            let plain = crypto::decrypt(&old, &secret, &context.to_string())?;
            let sealed = crypto::encrypt(&new, &plain, &context.to_string())?;
            sqlx::query(&format!("UPDATE {table} SET secret=$2 WHERE id=$1"))
                .bind(id)
                .bind(sealed)
                .execute(&mut *tx)
                .await?;
        }
    }
    let rows: Vec<(String, Vec<u8>)> =
        sqlx::query_as("SELECT id,payload FROM drafts WHERE encrypted")
            .fetch_all(&mut *tx)
            .await?;
    for (id, payload) in rows {
        let context = format!("draft:{id}");
        let plain = crypto::decrypt(&old, &payload, &context)?;
        let sealed = crypto::encrypt(&new, &plain, &context)?;
        sqlx::query("UPDATE drafts SET payload=$2 WHERE id=$1")
            .bind(id)
            .bind(sealed)
            .execute(&mut *tx)
            .await?;
    }
    let views: Vec<(Uuid, Vec<u8>)> = sqlx::query_as("SELECT id,filters FROM saved_views")
        .fetch_all(&mut *tx)
        .await?;
    for (id, filters) in views {
        let context = format!("view:{id}");
        let plain = crypto::decrypt(&old, &filters, &context)?;
        let sealed = crypto::encrypt(&new, &plain, &context)?;
        sqlx::query("UPDATE saved_views SET filters=$2 WHERE id=$1")
            .bind(id)
            .bind(sealed)
            .execute(&mut *tx)
            .await?;
    }
    let rows: Vec<(Uuid, String)> =
        sqlx::query_as("SELECT id,storage_key FROM attachments WHERE encrypted")
            .fetch_all(&mut *tx)
            .await?;
    let history: Vec<(Uuid, Vec<u8>)> = sqlx::query_as("SELECT id,payload FROM api_history")
        .fetch_all(&mut *tx)
        .await?;
    let feedback: Vec<(Uuid, Vec<u8>)> = sqlx::query_as("SELECT id,payload FROM feedback")
        .fetch_all(&mut *tx)
        .await?;
    for (id, payload) in feedback {
        let context = format!("feedback:{id}");
        let plain = crypto::decrypt(&old, &payload, &context)?;
        let sealed = crypto::encrypt(&new, &plain, &context)?;
        sqlx::query("UPDATE feedback SET payload=$2 WHERE id=$1")
            .bind(id)
            .bind(sealed)
            .execute(&mut *tx)
            .await?;
    }
    let jobs: Vec<(Uuid, Vec<u8>, Option<Vec<u8>>)> =
        sqlx::query_as("SELECT id,payload,output FROM ingest_jobs WHERE encrypted")
            .fetch_all(&mut *tx)
            .await?;
    for (id, payload, output) in jobs {
        for (field, bytes, prefix) in [
            ("payload", Some(payload), "job"),
            ("output", output, "job-output"),
        ] {
            if let Some(bytes) = bytes {
                let context = format!("{prefix}:{id}");
                let plain = crypto::decrypt(&old, &bytes, &context)?;
                let sealed = crypto::encrypt(&new, &plain, &context)?;
                sqlx::query(&format!("UPDATE ingest_jobs SET {field}=$2 WHERE id=$1"))
                    .bind(id)
                    .bind(sealed)
                    .execute(&mut *tx)
                    .await?;
            }
        }
    }
    for (id, payload) in history {
        let context = format!("request:{id}");
        let plain = crypto::decrypt(&old, &payload, &context)?;
        let sealed = crypto::encrypt(&new, &plain, &context)?;
        sqlx::query("UPDATE api_history SET payload=$2 WHERE id=$1")
            .bind(id)
            .bind(sealed)
            .execute(&mut *tx)
            .await?;
    }
    for (id, key) in rows {
        let bytes = files::read(&state.db, &state.storage, &key).await?;
        let context = format!("attachment:{id}");
        let plain = crypto::decrypt(&old, &bytes, &context)?;
        let sealed = crypto::encrypt(&new, &plain, &context)?;
        let key = format!("attachments/{}", Uuid::new_v4());
        files::stage(&state.db, &state.storage, &key, sealed).await?;
        files::read(&state.db, &state.storage, &key).await?;
        sqlx::query("UPDATE attachments SET storage_key=$2 WHERE id=$1")
            .bind(id)
            .bind(key)
            .execute(&mut *tx)
            .await?;
    }
    sqlx::query("UPDATE vault_config SET salt=$1,verifier=$2 WHERE id=1")
        .bind(salt)
        .bind(verifier)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    state.sessions.lock().await.clear();
    state.file_cleanup.notify_one();
    Ok(auth::new_session(&state, new).await)
}

struct FrameWriter {
    file: File,
    key: VaultKey,
    count: u64,
    hash: Sha256,
}
impl FrameWriter {
    async fn frame(&mut self, plain: &[u8]) -> Result<()> {
        if plain.len() + 28 > MAX_FRAME {
            return Err(AppError::bad("单条备份记录超过 16 MB"));
        }
        let sealed = crypto::encrypt(
            &self.key,
            plain,
            &format!("infohub-backup-1:{}", self.count),
        )?;
        self.file
            .write_u32_le(sealed.len() as u32)
            .await
            .map_err(io_error)?;
        self.file.write_all(&sealed).await.map_err(io_error)?;
        self.hash.update((plain.len() as u64).to_le_bytes());
        self.hash.update(plain);
        self.count += 1;
        Ok(())
    }
    async fn json(&mut self, value: Value) -> Result<()> {
        self.frame(&json_bytes(&value)?).await
    }
}
struct FrameReader {
    file: File,
    key: VaultKey,
    count: u64,
    hash: Sha256,
}
impl FrameReader {
    async fn frame(&mut self) -> Result<zeroize::Zeroizing<Vec<u8>>> {
        let size = self.file.read_u32_le().await.map_err(|_| invalid())? as usize;
        if !(28..=MAX_FRAME).contains(&size) {
            return Err(invalid());
        }
        let mut sealed = vec![0; size];
        self.file
            .read_exact(&mut sealed)
            .await
            .map_err(|_| invalid())?;
        let plain = crypto::decrypt(
            &self.key,
            &sealed,
            &format!("infohub-backup-1:{}", self.count),
        )
        .map_err(|_| invalid())?;
        self.hash.update((plain.len() as u64).to_le_bytes());
        self.hash.update(&plain);
        self.count += 1;
        Ok(plain)
    }
    async fn json(&mut self) -> Result<Value> {
        serde_json::from_slice(&self.frame().await?).map_err(|_| invalid())
    }
}

async fn audit_schema(state: &AppState) -> Result<()> {
    let actual: Vec<String> =
        sqlx::query_scalar("SELECT tablename FROM pg_tables WHERE schemaname=current_schema()")
            .fetch_all(&state.db)
            .await?;
    if actual.iter().any(|t| {
        !TABLES.contains(&t.as_str())
            && !["_sqlx_migrations", "file_objects", "backup_runs"].contains(&t.as_str())
    }) {
        return Err(AppError::bad(
            "数据库包含尚未纳入备份的业务表，请更新备份模块后重试",
        ));
    }
    Ok(())
}
async fn start_run(state: &AppState, operation: &str) -> Result<Uuid> {
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO backup_runs(id,operation,status) VALUES($1,$2,'running')")
        .bind(id)
        .bind(operation)
        .execute(&state.db)
        .await?;
    Ok(id)
}
async fn finish_run(state: &AppState, id: Uuid, success: bool, size: Option<i64>) -> Result<()> {
    sqlx::query(
        "UPDATE backup_runs SET status=$2,size=$3,message=$4,finished_at=now() WHERE id=$1",
    )
    .bind(id)
    .bind(if success { "success" } else { "failed" })
    .bind(size)
    .bind(if success {
        "已校验完成"
    } else {
        "操作未完成，原有数据保持不变"
    })
    .execute(&state.db)
    .await?;
    Ok(())
}
pub async fn runs(State(state): State<AppState>) -> Result<Json<Value>> {
    let rows: Vec<Value> = sqlx::query_scalar(
        "SELECT to_jsonb(r) FROM (SELECT * FROM backup_runs ORDER BY created_at DESC LIMIT 50) r",
    )
    .fetch_all(&state.db)
    .await?;
    Ok(Json(json!(rows)))
}
pub async fn export(
    State(state): State<AppState>,
    Extension(auth): Extension<Auth>,
    Json(input): Json<auth::Password>,
) -> Result<Response> {
    auth.vault()?;
    auth::verify(&state, input.password.clone()).await?;
    audit_schema(&state).await?;
    let run = start_run(&state, "backup").await?;
    let result = make_backup(&state, input.password).await;
    finish_run(
        &state,
        run,
        result.is_ok(),
        result.as_ref().ok().map(|(_, size)| *size as i64),
    )
    .await?;
    let (temp, _) = result?;
    let file = File::open(temp.path()).await.map_err(io_error)?;
    let stream = tokio_util::io::ReaderStream::new(file).map(move |chunk| {
        let _keep_file = &temp;
        chunk
    });
    let mut response = Response::new(Body::from_stream(stream));
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/octet-stream"),
    );
    response.headers_mut().insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_str(&format!(
            "attachment; filename=\"infohub-{}.infohub\"",
            chrono::Utc::now().format("%Y%m%d-%H%M%S")
        ))
        .map_err(io_error)?,
    );
    Ok(response)
}
async fn make_backup(state: &AppState, password: String) -> Result<(tempfile::NamedTempFile, u64)> {
    let temp = tempfile::NamedTempFile::new().map_err(io_error)?;
    let mut file = File::from_std(temp.reopen().map_err(io_error)?);
    let mut salt = vec![0; 16];
    rand::thread_rng().fill_bytes(&mut salt);
    file.write_all(MAGIC).await.map_err(io_error)?;
    file.write_all(&salt).await.map_err(io_error)?;
    let mut writer = FrameWriter {
        file,
        key: crypto::derive(password, salt).await?,
        count: 0,
        hash: Sha256::new(),
    };
    writer.json(json!({"type":"manifest","format":1,"schema":7,"tables":TABLES,"createdAt":chrono::Utc::now()})).await?;
    let mut counts = BTreeMap::new();
    for table in TABLES {
        let sql = format!("SELECT to_jsonb(t) FROM {table} t");
        let mut rows = sqlx::query_scalar::<_, Value>(&sql).fetch(&state.db);
        let mut count = 0u64;
        while let Some(row) = rows.try_next().await? {
            writer
                .json(json!({"type":"row","table":table,"row":row}))
                .await?;
            count += 1;
        }
        counts.insert(*table, count);
    }
    let mut rows=sqlx::query_as::<_,(String,i64,String)>("SELECT key,size,sha256 FROM file_objects f WHERE EXISTS(SELECT 1 FROM attachments a WHERE a.storage_key=f.key) OR EXISTS(SELECT 1 FROM media m WHERE m.storage_key=f.key) OR EXISTS(SELECT 1 FROM version_media v WHERE v.storage_key=f.key) ORDER BY key").fetch(&state.db);
    let mut files_count = 0u64;
    while let Some((key, size, sha)) = rows.try_next().await? {
        let bytes = files::read(&state.db, &state.storage, &key).await?;
        writer
            .json(json!({"type":"file","key":key,"size":size,"sha256":sha}))
            .await?;
        writer.frame(&bytes).await?;
        files_count += 1;
    }
    let checksum = hex::encode(writer.hash.clone().finalize());
    writer.json(json!({"type":"end","frames":writer.count,"sha256":checksum,"counts":counts,"files":files_count})).await?;
    writer.file.sync_all().await.map_err(io_error)?;
    let size = writer.file.metadata().await.map_err(io_error)?.len();
    drop(writer);
    Ok((temp, size))
}

pub async fn restore(
    State(state): State<AppState>,
    headers: HeaderMap,
    mut multipart: Multipart,
) -> Result<Json<Value>> {
    let mut password = zeroize::Zeroizing::new(String::new());
    let mut current_password = zeroize::Zeroizing::new(String::new());
    let mut confirm = String::new();
    let temp = tempfile::NamedTempFile::new().map_err(io_error)?;
    let mut file = File::from_std(temp.reopen().map_err(io_error)?);
    let mut size = 0u64;
    let mut seen_file = false;
    // Bounded streaming upload; configure for larger personal archives when needed.
    let max_size = std::env::var("MAX_BACKUP_BYTES")
        .ok()
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(2 * 1024 * 1024 * 1024);
    while let Some(mut field) = multipart.next_field().await.map_err(|_| invalid())? {
        let name = field.name().unwrap_or_default().to_owned();
        if name == "backup" {
            if seen_file {
                return Err(invalid());
            }
            seen_file = true;
            while let Some(chunk) = field.chunk().await.map_err(|_| invalid())? {
                size += chunk.len() as u64;
                if size > max_size {
                    return Err(AppError(
                        StatusCode::PAYLOAD_TOO_LARGE,
                        "备份超过服务端 MAX_BACKUP_BYTES 上限".into(),
                    ));
                }
                file.write_all(&chunk).await.map_err(io_error)?;
            }
        } else {
            let mut bytes = Vec::new();
            while let Some(chunk) = field.chunk().await.map_err(|_| invalid())? {
                if bytes.len() + chunk.len() > 2048 {
                    return Err(invalid());
                }
                bytes.extend_from_slice(&chunk);
            }
            let text = String::from_utf8(bytes).map_err(|_| invalid())?;
            match name.as_str() {
                "password" => *password = text,
                "currentPassword" => *current_password = text,
                "confirm" => confirm = text,
                _ => return Err(invalid()),
            }
        }
    }
    file.sync_all().await.map_err(io_error)?;
    drop(file);
    if !seen_file || password.is_empty() || password.len() > 1024 || confirm != "恢复并替换" {
        return Err(AppError::bad(
            "请选择备份、填写备份时的主密码，并确认恢复并替换",
        ));
    }
    let initialized: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM vault_config)")
        .fetch_one(&state.db)
        .await?;
    if initialized {
        let token = headers
            .get(header::AUTHORIZATION)
            .and_then(|h| h.to_str().ok())
            .and_then(|h| h.strip_prefix("Bearer "))
            .ok_or_else(AppError::unauthorized)?;
        let hash = digest(token.as_bytes());
        let valid = state
            .sessions
            .lock()
            .await
            .get(&hash)
            .is_some_and(|s| s.expires > std::time::Instant::now());
        if !valid {
            return Err(AppError::unauthorized());
        }
        auth::verify(&state, current_password.to_string()).await?;
    }
    audit_schema(&state).await?;
    let run = start_run(&state, "restore").await?;
    let result = load_backup(&state, temp.path(), password.to_string()).await;
    if result.is_ok() {
        state.sessions.lock().await.clear();
    }
    if finish_run(&state, run, result.is_ok(), Some(size as i64))
        .await
        .is_err()
    {
        tracing::warn!("Unable to update restore operation log");
    }
    state.file_cleanup.notify_one();
    result?;
    Ok(Json(
        json!({"restored":true,"message":"恢复完成，请使用备份时的主密码登录"}),
    ))
}

async fn load_backup(state: &AppState, path: &std::path::Path, password: String) -> Result<()> {
    let mut file = File::open(path).await.map_err(io_error)?;
    let mut magic = vec![0; MAGIC.len()];
    file.read_exact(&mut magic).await.map_err(|_| invalid())?;
    if magic != MAGIC {
        return Err(invalid());
    }
    let mut salt = vec![0; 16];
    file.read_exact(&mut salt).await.map_err(|_| invalid())?;
    let mut reader = FrameReader {
        file,
        key: crypto::derive(password.clone(), salt).await?,
        count: 0,
        hash: Sha256::new(),
    };
    let manifest = reader.json().await?;
    let source_tables: Vec<String> =
        serde_json::from_value(manifest["tables"].clone()).map_err(|_| invalid())?;
    if manifest["type"] != "manifest"
        || manifest["format"] != 1
        || !matches!(manifest["schema"].as_u64(), Some(3..=7))
        || source_tables.iter().any(|t| !TABLES.contains(&t.as_str()))
    {
        return Err(AppError::bad(
            "备份版本与当前应用不兼容，请使用匹配版本恢复",
        ));
    }
    let mut tx = state.db.begin().await?;
    for table in TABLES {
        sqlx::query(&format!(
            "CREATE TEMP TABLE restore_{table} (LIKE {table} INCLUDING DEFAULTS) ON COMMIT DROP"
        ))
        .execute(&mut *tx)
        .await?;
    }
    let mut counts: BTreeMap<String, u64> = source_tables.into_iter().map(|s| (s, 0)).collect();
    let mut objects = HashMap::new();
    loop {
        let prior_count = reader.count;
        let prior_hash = hex::encode(reader.hash.clone().finalize());
        let record = reader.json().await?;
        match record["type"].as_str() {
            Some("row") => {
                let table = record["table"]
                    .as_str()
                    .filter(|s| counts.contains_key(*s))
                    .ok_or_else(invalid)?;
                if !record["row"].is_object() {
                    return Err(invalid());
                }
                sqlx::query(&format!("INSERT INTO restore_{table} SELECT * FROM jsonb_populate_record(NULL::{table},$1)")).bind(&record["row"]).execute(&mut *tx).await?;
                *counts.get_mut(table).unwrap() += 1;
            }
            Some("file") => {
                let key = record["key"].as_str().ok_or_else(invalid)?;
                let (prefix, id) = key.split_once('/').ok_or_else(invalid)?;
                if !["media", "attachments"].contains(&prefix)
                    || Uuid::parse_str(id).is_err()
                    || objects.contains_key(key)
                {
                    return Err(invalid());
                }
                let bytes = reader.frame().await?;
                if record["size"].as_u64() != Some(bytes.len() as u64)
                    || record["sha256"] != digest(&bytes)
                {
                    return Err(invalid());
                }
                let new_key = format!("{prefix}/{}", Uuid::new_v4());
                files::stage(&state.db, &state.storage, &new_key, bytes.to_vec()).await?;
                files::read(&state.db, &state.storage, &new_key).await?;
                objects.insert(key.to_string(), new_key);
            }
            Some("end") => {
                if record["frames"].as_u64() != Some(prior_count)
                    || record["sha256"] != prior_hash
                    || record["counts"] != json!(counts)
                    || record["files"].as_u64() != Some(objects.len() as u64)
                {
                    return Err(invalid());
                }
                let mut extra = [0];
                if reader.file.read(&mut extra).await.map_err(|_| invalid())? != 0 {
                    return Err(invalid());
                }
                break;
            }
            _ => return Err(invalid()),
        }
    }
    if counts.get("vault_config") != Some(&1) {
        return Err(invalid());
    }
    let (salt, verifier): (Vec<u8>, Vec<u8>) =
        sqlx::query_as("SELECT salt,verifier FROM restore_vault_config WHERE id=1")
            .fetch_one(&mut *tx)
            .await?;
    let source_key = crypto::derive(password, salt).await?;
    crypto::decrypt(&source_key, &verifier, "infohub-vault-v1").map_err(|_| invalid())?;
    for table in ["attachments", "media", "version_media"] {
        let keys: Vec<String> =
            sqlx::query_scalar(&format!("SELECT DISTINCT storage_key FROM restore_{table}"))
                .fetch_all(&mut *tx)
                .await?;
        for key in keys {
            let new_key = objects.get(&key).ok_or_else(invalid)?;
            sqlx::query(&format!(
                "UPDATE restore_{table} SET storage_key=$2 WHERE storage_key=$1"
            ))
            .bind(key)
            .bind(new_key)
            .execute(&mut *tx)
            .await?;
        }
    }
    // Defer destructive work until the entire archive (including all bytes and
    // its final authentication frame) has passed validation. FK/unique errors
    // here roll the transaction back, leaving the original installation intact.
    sqlx::query("SELECT set_config('infohub.skip_snapshot','on',true)")
        .execute(&mut *tx)
        .await?;
    for table in TABLES.iter().rev() {
        sqlx::query(&format!("DELETE FROM {table}"))
            .execute(&mut *tx)
            .await?;
    }
    for table in TABLES {
        sqlx::query(&format!(
            "INSERT INTO {table} SELECT * FROM restore_{table}"
        ))
        .execute(&mut *tx)
        .await?;
    }
    sqlx::query(
        "UPDATE api_history SET status='interrupted',finished_at=now() WHERE status='running'",
    )
    .execute(&mut *tx)
    .await?;
    sqlx::query("UPDATE ingest_jobs SET status=CASE WHEN encrypted THEN 'waiting_unlock' ELSE 'queued' END,phase='恢复后等待继续' WHERE status='running'").execute(&mut *tx).await?;
    sqlx::query("INSERT INTO workbench_preferences(id) VALUES(1) ON CONFLICT DO NOTHING")
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE repo_subscriptions SET checking=false WHERE checking")
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}

#[derive(Serialize)]
struct ArticleManifest {
    title: String,
    source: String,
    exported_at: chrono::DateTime<chrono::Utc>,
}
pub async fn article_zip(State(state): State<AppState>, Path(id): Path<Uuid>) -> Result<Response> {
    let (title, url, data): (String, String, Value) = sqlx::query_as(
        "SELECT title,url,data FROM items WHERE id=$1 AND kind='knowledge' AND deleted_at IS NULL",
    )
    .bind(id)
    .fetch_one(&state.db)
    .await?;
    let mut content = data["content"].as_str().unwrap_or_default().to_string();
    let media_pattern = regex::Regex::new(r"/api/media/([0-9a-fA-F-]{36})").map_err(io_error)?;
    let referenced: std::collections::BTreeSet<Uuid> = media_pattern
        .captures_iter(&content)
        .filter_map(|c| Uuid::parse_str(&c[1]).ok())
        .collect();
    let mut writer = async_zip::base::write::ZipFileWriter::new(Vec::new());
    for id in referenced {
        let (mime,key):(String,String)=sqlx::query_as("SELECT mime,storage_key FROM media WHERE id=$1 UNION ALL SELECT mime,storage_key FROM version_media WHERE media_id=$1 LIMIT 1").bind(id).fetch_one(&state.db).await?;
        let extension = match mime.as_str() {
            "image/png" => "png",
            "image/jpeg" => "jpg",
            "image/gif" => "gif",
            _ => "webp",
        };
        let path = format!("images/{id}.{extension}");
        content = content.replace(&format!("/api/media/{id}"), &path);
        let bytes = files::read(&state.db, &state.storage, &key).await?;
        writer
            .write_entry_whole(
                async_zip::ZipEntryBuilder::new(path.into(), async_zip::Compression::Stored),
                &bytes,
            )
            .await
            .map_err(io_error)?;
    }
    writer
        .write_entry_whole(
            async_zip::ZipEntryBuilder::new("article.md".into(), async_zip::Compression::Stored),
            content.as_bytes(),
        )
        .await
        .map_err(io_error)?;
    let manifest = serde_json::to_vec_pretty(&ArticleManifest {
        title,
        source: url,
        exported_at: chrono::Utc::now(),
    })
    .map_err(io_error)?;
    writer
        .write_entry_whole(
            async_zip::ZipEntryBuilder::new("source.json".into(), async_zip::Compression::Stored),
            &manifest,
        )
        .await
        .map_err(io_error)?;
    let bytes = writer.close().await.map_err(io_error)?;
    let mut response = Response::new(Body::from(bytes));
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/zip"),
    );
    response.headers_mut().insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_static("attachment; filename=\"article.zip\""),
    );
    Ok(response)
}
