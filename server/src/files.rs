//! PostgreSQL stores references and a durable cleanup queue; file bytes live in
//! FileStorage. Pending uploads expire so cancellation or transaction rollback
//! cannot leave permanent untracked objects.
use crate::{
    error::{AppError, Result},
    storage::{digest, FileStorage},
};
use sqlx::PgPool;
use uuid::Uuid;

pub async fn stage(db: &PgPool, storage: &FileStorage, key: &str, bytes: Vec<u8>) -> Result<()> {
    let size = bytes.len() as i64;
    let hash = digest(&bytes);
    let reserved: Option<String> = sqlx::query_scalar(
        "INSERT INTO file_objects(key,storage_id,size,sha256) VALUES ($1,$2,$3,$4)
         ON CONFLICT (key) DO UPDATE SET delete_after=now()+INTERVAL '1 hour'
         WHERE file_objects.storage_id=$2 AND file_objects.size=$3 AND file_objects.sha256=$4
         RETURNING key",
    )
    .bind(key)
    .bind(&storage.id)
    .bind(size)
    .bind(&hash)
    .fetch_optional(db)
    .await?;
    if reserved.is_none() {
        return Err(AppError::bad("文件迁移存在冲突，请检查存储配置和备份"));
    }
    if let Err(error) = storage.put(key, bytes).await {
        sqlx::query("UPDATE file_objects SET delete_after=now() WHERE key=$1")
            .bind(key)
            .execute(db)
            .await?;
        return Err(error);
    }
    Ok(())
}

pub async fn read(db: &PgPool, storage: &FileStorage, key: &str) -> Result<Vec<u8>> {
    let (storage_id, size, hash): (String, i64, String) =
        sqlx::query_as("SELECT storage_id,size,sha256 FROM file_objects WHERE key=$1")
            .bind(key)
            .fetch_one(db)
            .await?;
    if storage_id != storage.id {
        return Err(AppError::bad(
            "文件所在存储与当前配置不一致，请恢复原存储配置",
        ));
    }
    storage.read(key, size, &hash).await
}

pub async fn initialize(db: &PgPool, storage: &FileStorage) -> Result<()> {
    // Transaction-scoped lock is released even if migration returns an error.
    let mut lock = db.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(724611830029)")
        .execute(&mut *lock)
        .await?;
    let other_ids: Vec<String> =
        // Failed readiness probes contain no user data and must not prevent
        // correcting a mistyped endpoint/bucket on an otherwise empty setup.
        sqlx::query_scalar("SELECT DISTINCT storage_id FROM file_objects WHERE storage_id<>$1 AND key NOT LIKE 'checks/%'")
            .bind(&storage.id)
            .fetch_all(db)
            .await?;
    if other_ids.iter().any(|id| !storage.is_legacy_local_id(id)) {
        return Err(AppError::bad("已有文件使用不同的存储位置。请恢复原存储及 .infohub-storage-id 标识文件，或恢复 R2 配置（参见 docs/file-storage.md）"));
    }
    if !other_ids.is_empty() {
        // Upgrade the former path-based local ID only after every live file is
        // read and verified. An empty replacement volume must never be adopted.
        let rows: Vec<(String, i64, String)> = sqlx::query_as(
            "SELECT key,size,sha256 FROM file_objects f WHERE storage_id<>$1 AND
             (EXISTS(SELECT 1 FROM attachments a WHERE a.storage_key=f.key) OR
              EXISTS(SELECT 1 FROM media m WHERE m.storage_key=f.key) OR
              EXISTS(SELECT 1 FROM version_media v WHERE v.storage_key=f.key))",
        )
        .bind(&storage.id)
        .fetch_all(db)
        .await?;
        for (key, size, hash) in rows {
            storage.read(&key, size, &hash).await?;
        }
        sqlx::query("UPDATE file_objects SET storage_id=$1 WHERE storage_id=ANY($2)")
            .bind(&storage.id)
            .bind(&other_ids)
            .execute(db)
            .await?;
        tracing::info!("Verified local files; upgraded path-based storage identity");
    }
    verify_access(db, storage).await?;
    for (table, prefix) in [("attachments", "attachments"), ("media", "media")] {
        let legacy: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=$1 AND column_name='legacy_content')")
            .bind(table).fetch_one(db).await?;
        if !legacy {
            continue;
        }
        let mut migrated = 0;
        loop {
            let row: Option<(Uuid, Vec<u8>)> = sqlx::query_as(&format!(
                "SELECT id,legacy_content FROM {table} WHERE legacy_content IS NOT NULL ORDER BY id LIMIT 1"))
                .fetch_optional(db).await?;
            let Some((id, bytes)) = row else {
                break;
            };
            let key = format!("{prefix}/{id}");
            stage(db, storage, &key, bytes).await?;
            // Read back and verify before discarding ANY original bytes. Encrypted
            // attachments are copied verbatim, keeping their original UUID/AAD.
            read(db, storage, &key).await?;
            sqlx::query(&format!(
                "UPDATE {table} SET storage_key=$2,legacy_content=NULL WHERE id=$1"
            ))
            .bind(id)
            .bind(&key)
            .execute(db)
            .await?;
            migrated += 1;
        }
        // This finalization is intentionally after the resumable external export,
        // rather than in a SQL migration that cannot verify external storage.
        let mut finish = db.begin().await?;
        sqlx::query(&format!(
            "ALTER TABLE {table} ALTER COLUMN storage_key SET NOT NULL"
        ))
        .execute(&mut *finish)
        .await?;
        sqlx::query(&format!("ALTER TABLE {table} DROP COLUMN legacy_content"))
            .execute(&mut *finish)
            .await?;
        finish.commit().await?;
        tracing::info!(
            table,
            migrated,
            "Database file export verified; legacy byte column removed"
        );
    }
    lock.commit().await?;
    Ok(())
}

pub async fn collect_garbage(db: &PgPool, storage: &FileStorage) -> Result<()> {
    for _ in 0..100 {
        let mut tx = db.begin().await?;
        let key: Option<String> = sqlx::query_scalar(
            "SELECT key FROM file_objects f WHERE storage_id=$1 AND delete_after<=now()
             AND NOT EXISTS(SELECT 1 FROM attachments a WHERE a.storage_key=f.key)
             AND NOT EXISTS(SELECT 1 FROM media m WHERE m.storage_key=f.key)
             AND NOT EXISTS(SELECT 1 FROM version_media v WHERE v.storage_key=f.key)
             ORDER BY delete_after LIMIT 1 FOR UPDATE OF f SKIP LOCKED",
        )
        .bind(&storage.id)
        .fetch_optional(&mut *tx)
        .await?;
        let Some(key) = key else {
            return Ok(());
        };
        match storage.delete(&key).await {
            Ok(()) => {
                sqlx::query("DELETE FROM file_objects WHERE key=$1")
                    .bind(&key)
                    .execute(&mut *tx)
                    .await?;
            }
            Err(_) => {
                sqlx::query("UPDATE file_objects SET delete_after=now()+INTERVAL '1 minute',cleanup_attempts=cleanup_attempts+1 WHERE key=$1")
                    .bind(&key).execute(&mut *tx).await?;
                tracing::warn!(key, "File deletion queued for retry");
            }
        }
        tx.commit().await?;
    }
    Ok(())
}

async fn verify_access(db: &PgPool, storage: &FileStorage) -> Result<()> {
    let key = format!("checks/{}", Uuid::new_v4());
    let result = async {
        stage(
            db,
            storage,
            &key,
            b"InfoHub storage readiness check".to_vec(),
        )
        .await?;
        read(db, storage, &key).await?;
        storage.delete(&key).await?;
        sqlx::query("DELETE FROM file_objects WHERE key=$1")
            .bind(&key)
            .execute(db)
            .await?;
        Ok(())
    }
    .await;
    if result.is_err() {
        // Keep failed probes in the same durable queue as failed uploads.
        let _ = sqlx::query("UPDATE file_objects SET delete_after=now() WHERE key=$1")
            .bind(&key)
            .execute(db)
            .await;
    }
    result
}

pub async fn cleanup(db: &PgPool, storage: &FileStorage) {
    // Only the dedicated worker calls this. Allow each SDK request its own
    // timeout; a short batch deadline used to cancel every slow deletion.
    if collect_garbage(db, storage).await.is_err() {
        tracing::warn!("File cleanup deferred; the persistent queue will be retried");
    }
}
