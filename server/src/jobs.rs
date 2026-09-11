//! Durable ingestion. A committed item and the job's continuation point share
//! one transaction; a restart resumes link collection without inserting again.
use crate::{
    auth::Auth,
    crypto,
    error::{AppError, Result},
    ingest,
    model::ItemRow,
    routes, AppState,
};
use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    Extension, Json,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::time::{Duration, Instant};
use uuid::Uuid;

#[derive(sqlx::FromRow)]
struct Job {
    id: Uuid,
    payload: Vec<u8>,
    encrypted: bool,
    output: Option<Vec<u8>>,
    item_id: Option<Uuid>,
}
#[derive(sqlx::FromRow)]
struct JobSummary {
    id: Uuid,
    payload: Vec<u8>,
    encrypted: bool,
    output: Option<Vec<u8>>,
    status: String,
    phase: String,
    item_id: Option<Uuid>,
    attempts: i32,
    created_at: chrono::DateTime<chrono::Utc>,
}
#[derive(Deserialize)]
pub struct Page {
    pub offset: Option<i64>,
}
fn encode(auth: &Auth, id: Uuid, value: &Value, encrypted: bool, output: bool) -> Result<Vec<u8>> {
    let bytes = serde_json::to_vec(value).map_err(|_| AppError::bad("任务内容无法编码"))?;
    if encrypted {
        crypto::encrypt(
            auth.vault()?,
            &bytes,
            &format!("job{}:{id}", if output { "-output" } else { "" }),
        )
    } else {
        Ok(bytes)
    }
}
fn decode(auth: &Auth, id: Uuid, bytes: &[u8], encrypted: bool, output: bool) -> Result<Value> {
    if encrypted {
        let bytes = crypto::decrypt(
            auth.vault()?,
            bytes,
            &format!("job{}:{id}", if output { "-output" } else { "" }),
        )?;
        serde_json::from_slice(&bytes).map_err(|_| AppError::bad("任务内容无法解码"))
    } else {
        serde_json::from_slice(bytes).map_err(|_| AppError::bad("任务内容无法解码"))
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Enqueue {
    #[serde(flatten)]
    pub input: routes::IngestInput,
    pub request_id: Uuid,
}
pub async fn create(
    State(state): State<AppState>,
    Extension(auth): Extension<Auth>,
    Json(mut request): Json<Enqueue>,
) -> Result<(StatusCode, Json<Value>)> {
    let input = &mut request.input;
    input.url = ingest::canonical_source_url(input.url.trim())?;
    if !["", "knowledge", "repo", "credential"].contains(&input.kind.as_str())
        || input.url.len() > 8000
        || input.project.len() > 500
        || input.tags.len() > 50
        || input.tags.iter().any(|tag| tag.chars().count() > 100)
    {
        return Err(AppError::bad("收录类型、项目或标签超出限制"));
    }
    let encrypted = !["knowledge", "repo"].contains(&input.kind.as_str());
    if encrypted {
        auth.vault()?;
    }
    let value = json!(input);
    let mut tx = state.db.begin().await?;
    // Limit active work, but retain the history until the user explicitly removes it.
    sqlx::query("LOCK TABLE ingest_jobs IN SHARE ROW EXCLUSIVE MODE")
        .execute(&mut *tx)
        .await?;
    let count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM ingest_jobs WHERE status IN ('queued','waiting_unlock','running')",
    )
    .fetch_one(&mut *tx)
    .await?;
    if count >= 100 {
        return Err(AppError::bad(
            "待执行收录已达 100 条，请等待完成或取消部分任务",
        ));
    }
    let inserted = sqlx::query(
        "INSERT INTO ingest_jobs(id,payload,encrypted) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
    )
    .bind(request.request_id)
    .bind(encode(&auth, request.request_id, &value, encrypted, false)?)
    .bind(encrypted)
    .execute(&mut *tx)
    .await?;
    if inserted.rows_affected() == 0 {
        let job: Job = sqlx::query_as(
            "SELECT id,payload,encrypted,output,item_id FROM ingest_jobs WHERE id=$1",
        )
        .bind(request.request_id)
        .fetch_one(&mut *tx)
        .await?;
        if decode(&auth, job.id, &job.payload, job.encrypted, false)? != value {
            return Err(AppError(
                StatusCode::CONFLICT,
                "任务编号已用于其他收录，请重新打开收录窗口".into(),
            ));
        }
    }
    tx.commit().await?;
    state.jobs_notify.notify_one();
    Ok((StatusCode::ACCEPTED, Json(json!({"id":request.request_id}))))
}
pub async fn list(
    State(state): State<AppState>,
    Extension(auth): Extension<Auth>,
    Query(page): Query<Page>,
) -> Result<Json<Value>> {
    let rows:Vec<JobSummary>=sqlx::query_as("SELECT id,payload,encrypted,output,status,phase,item_id,attempts,created_at FROM ingest_jobs ORDER BY created_at DESC,id DESC LIMIT 200 OFFSET $1").bind(page.offset.unwrap_or(0).max(0)).fetch_all(&state.db).await?;
    let mut result = vec![];
    for JobSummary {
        id,
        payload,
        encrypted,
        output,
        status,
        phase,
        item_id,
        attempts,
        created_at: created,
    } in rows
    {
        let readable = !encrypted || auth.key.is_some();
        let input = if readable {
            decode(&auth, id, &payload, encrypted, false)?
        } else {
            Value::Null
        };
        let output = if readable {
            output
                .map(|bytes| decode(&auth, id, &bytes, encrypted, true))
                .transpose()?
        } else {
            None
        };
        result.push(json!({"id":id,"input":input,"output":output,"encrypted":encrypted,"status":status,"phase":phase,"itemId":item_id,"attempts":attempts,"createdAt":created}));
    }
    Ok(Json(json!(result)))
}
async fn job_access(state: &AppState, auth: &Auth, id: Uuid) -> Result<()> {
    let encrypted: bool = sqlx::query_scalar("SELECT encrypted FROM ingest_jobs WHERE id=$1")
        .bind(id)
        .fetch_one(&state.db)
        .await?;
    if encrypted {
        auth.vault()?;
    }
    Ok(())
}
pub async fn cancel(
    State(state): State<AppState>,
    Extension(auth): Extension<Auth>,
    Path(id): Path<Uuid>,
) -> Result<StatusCode> {
    job_access(&state, &auth, id).await?;
    sqlx::query("UPDATE ingest_jobs SET status='cancelled',phase='已取消',updated_at=now() WHERE id=$1 AND status IN ('queued','waiting_unlock','running')").bind(id).execute(&state.db).await?;
    if let Some(token) = state.active_jobs.lock().await.get(&id) {
        token.cancel();
    }
    Ok(StatusCode::NO_CONTENT)
}
pub async fn retry(
    State(state): State<AppState>,
    Extension(auth): Extension<Auth>,
    Path(id): Path<Uuid>,
) -> Result<StatusCode> {
    job_access(&state, &auth, id).await?;
    if state.active_jobs.lock().await.contains_key(&id) {
        return Err(AppError(
            StatusCode::CONFLICT,
            "上一次执行仍在停止，请稍后重试".into(),
        ));
    }
    let changed=sqlx::query("UPDATE ingest_jobs SET status='queued',phase='等待重试',updated_at=now() WHERE id=$1 AND status IN ('failed','cancelled')").bind(id).execute(&state.db).await?;
    if changed.rows_affected() == 0 {
        return Err(AppError::bad("只有失败或已取消的任务可以重试"));
    }
    state.jobs_notify.notify_one();
    Ok(StatusCode::NO_CONTENT)
}
pub async fn delete(
    State(state): State<AppState>,
    Extension(auth): Extension<Auth>,
    Path(id): Path<Uuid>,
) -> Result<StatusCode> {
    job_access(&state, &auth, id).await?;
    if state.active_jobs.lock().await.contains_key(&id) {
        return Err(AppError::bad("请等待执行停止后再移除记录"));
    }
    let changed = sqlx::query(
        "DELETE FROM ingest_jobs WHERE id=$1 AND status IN ('succeeded','failed','cancelled')",
    )
    .bind(id)
    .execute(&state.db)
    .await?;
    if changed.rows_affected() == 0 {
        return Err(AppError::bad("请先取消任务"));
    }
    Ok(StatusCode::NO_CONTENT)
}
pub async fn initialize(state: &AppState) -> Result<()> {
    sqlx::query("UPDATE ingest_jobs SET status=CASE WHEN encrypted THEN 'waiting_unlock' ELSE 'queued' END,phase='服务中断，等待继续',updated_at=now() WHERE status='running'").execute(&state.db).await?;
    Ok(())
}
pub async fn worker(state: AppState) {
    let mut recovery_needed = false;
    loop {
        tokio::select! {_=state.jobs_notify.notified()=>{},_=tokio::time::sleep(Duration::from_secs(1))=>{}}
        loop {
            let _guard = state.maintenance.read().await;
            if recovery_needed {
                state.active_jobs.lock().await.clear();
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
                    tracing::warn!(status=%error.0,"background ingestion encountered a storage error");
                    break;
                }
            }
        }
    }
}
async fn next(state: &AppState) -> Result<bool> {
    let auth = {
        let sessions = state.sessions.lock().await;
        let key = sessions
            .values()
            .filter(|session| {
                session.expires > Instant::now()
                    && session.touched.elapsed() < Duration::from_secs(15 * 60)
            })
            .find_map(|session| session.key.clone());
        Auth {
            token: String::new(),
            key,
        }
    };
    if auth.key.is_none() {
        sqlx::query("UPDATE ingest_jobs SET status='waiting_unlock',phase='等待解锁密码库' WHERE encrypted AND status='queued'").execute(&state.db).await?;
    }
    let mut tx = state.db.begin().await?;
    let job:Option<Job>=sqlx::query_as("SELECT id,payload,encrypted,output,item_id FROM ingest_jobs WHERE status IN ('queued','waiting_unlock') AND (NOT encrypted OR $1) ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1").bind(auth.key.is_some()).fetch_optional(&mut *tx).await?;
    let Some(job) = job else { return Ok(false) };
    sqlx::query("UPDATE ingest_jobs SET status='running',phase='获取来源与资源',attempts=attempts+1,updated_at=now() WHERE id=$1").bind(job.id).execute(&mut *tx).await?;
    let token = tokio_util::sync::CancellationToken::new();
    state.active_jobs.lock().await.insert(job.id, token.clone());
    tx.commit().await?;
    let outcome = tokio::select! {biased;_=token.cancelled()=>Err(AppError::bad("任务已取消")),result=run(state,&auth,&job)=>result};
    let completed = outcome.is_ok();
    let result=match outcome {
        Ok(output)=>sqlx::query("UPDATE ingest_jobs SET status='succeeded',phase='收录完成',output=$2,updated_at=now() WHERE id=$1 AND status='running'").bind(job.id).bind(encode(&auth,job.id,&output,job.encrypted,true)?).execute(&state.db).await,
        Err(error)=>sqlx::query("UPDATE ingest_jobs SET status='failed',phase='收录失败',output=$2,updated_at=now() WHERE id=$1 AND status='running'").bind(job.id).bind(encode(&auth,job.id,&json!({"error":error.1}),job.encrypted,true)?).execute(&state.db).await,
    };
    state.active_jobs.lock().await.remove(&job.id);
    if result?.rows_affected() > 0
        && completed
        && crate::insights::record(state, "ingest_completed", job.item_id)
            .await
            .is_err()
    {
        tracing::warn!("local ingestion completion could not be recorded");
    }
    Ok(true)
}
async fn run(state: &AppState, auth: &Auth, job: &Job) -> Result<Value> {
    let input: routes::IngestInput =
        serde_json::from_value(decode(auth, job.id, &job.payload, job.encrypted, false)?)
            .map_err(|_| AppError::bad("收录参数无法读取"))?;
    let mut warnings: Vec<String> = job
        .output
        .as_ref()
        .and_then(|bytes| decode(auth, job.id, bytes, job.encrypted, true).ok())
        .and_then(|value| serde_json::from_value(value["warnings"].clone()).ok())
        .unwrap_or_default();
    let item = if let Some(id) = job.item_id {
        sqlx::query_as::<_, ItemRow>("SELECT * FROM items WHERE id=$1 AND deleted_at IS NULL")
            .bind(id)
            .fetch_one(&state.db)
            .await?
            .public(auth.key.as_ref(), true)?
    } else {
        let mut collected = ingest::collect(state, &input.url, &input.kind).await?;
        collected.input.project = input.project;
        collected.input.tags.extend(input.tags);
        collected.input.validate()?;
        warnings.extend(collected.warnings.iter().cloned());
        routes::stage_images(state, &collected).await?;
        let mut tx = state.db.begin().await?;
        let status: String =
            sqlx::query_scalar("SELECT status FROM ingest_jobs WHERE id=$1 FOR UPDATE")
                .bind(job.id)
                .fetch_one(&mut *tx)
                .await?;
        if status != "running" {
            return Err(AppError::bad("任务已取消"));
        }
        let existing: Option<ItemRow> =
            sqlx::query_as("SELECT * FROM items WHERE kind=$1 AND url=$2 AND deleted_at IS NULL")
                .bind(&collected.input.kind)
                .bind(&collected.input.url)
                .fetch_optional(&mut *tx)
                .await?;
        let item = if let Some(row) = existing {
            warnings.push("来源已收录，保留已有内容与项目归属".into());
            row.public(auth.key.as_ref(), true)?
        } else {
            let item = routes::insert(&mut tx, job.id, &mut collected.input, auth).await?;
            routes::persist_images(&mut tx, item.id, &collected).await?;
            item
        };
        sqlx::query("UPDATE ingest_jobs SET item_id=$2,phase='关联文中仓库',output=$3,updated_at=now() WHERE id=$1").bind(job.id).bind(item.id).bind(encode(auth,job.id,&json!({"warnings":warnings}),job.encrypted,true)?).execute(&mut *tx).await?;
        tx.commit().await?;
        item
    };
    routes::ingest_linked_repos(state, auth, &item, &mut warnings).await;
    Ok(json!({"title":item.title,"kind":item.kind,"warnings":warnings}))
}
