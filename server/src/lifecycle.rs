use crate::{
    auth::Auth,
    crypto,
    error::{AppError, Result},
    model::{Item, ItemInput, ItemRow},
    routes, AppState,
};
use axum::{
    extract::{Path, Query, Request, State},
    http::StatusCode,
    middleware::Next,
    response::Response,
    Extension, Json,
};
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

// The existing deployment is single-process. Hold this gate through response
// generation, before authentication, so a password rotation cannot race a
// request that still holds a copy of the old key. Background workers use it too.
pub async fn maintenance_gate(
    State(state): State<AppState>,
    request: Request,
    next: Next,
) -> Response {
    let exclusive = matches!(
        request.uri().path(),
        "/api/vault/password" | "/api/backup/export" | "/api/backup/restore"
    );
    if exclusive {
        let _guard = state.maintenance.write().await;
        next.run(request).await
    } else {
        let _guard = state.maintenance.read().await;
        next.run(request).await
    }
}

pub(crate) async fn check(state: &AppState, auth: &Auth, id: Uuid) -> Result<()> {
    let kind: String = sqlx::query_scalar("SELECT kind FROM items WHERE id=$1")
        .bind(id)
        .fetch_one(&state.db)
        .await?;
    if kind == "credential" {
        auth.vault()?;
    }
    Ok(())
}

pub async fn trash(
    State(state): State<AppState>,
    Extension(auth): Extension<Auth>,
) -> Result<Json<Value>> {
    let rows = sqlx::query_as::<_, ItemRow>(
        "SELECT * FROM items WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC",
    )
    .fetch_all(&state.db)
    .await?;
    let items = rows
        .into_iter()
        .map(|r| r.public(auth.key.as_ref(), false))
        .collect::<Result<Vec<_>>>()?;
    Ok(Json(json!(items)))
}

pub async fn restore_item(
    State(state): State<AppState>,
    Extension(auth): Extension<Auth>,
    Path(id): Path<Uuid>,
) -> Result<Json<Item>> {
    check(&state, &auth, id).await?;
    let mut tx = state.db.begin().await?;
    sqlx::query("SELECT set_config('infohub.change_reason','restore-trash',true)")
        .execute(&mut *tx)
        .await?;
    let row = sqlx::query_as::<_, ItemRow>("UPDATE items SET deleted_at=NULL,revision=revision+1,updated_at=now() WHERE id=$1 AND deleted_at IS NOT NULL RETURNING *")
        .bind(id).fetch_one(&mut *tx).await?;
    tx.commit().await?;
    Ok(Json(row.public(auth.key.as_ref(), true)?))
}

#[derive(Deserialize)]
pub struct Confirmation {
    pub confirm: String,
}
pub async fn purge(
    State(state): State<AppState>,
    Extension(auth): Extension<Auth>,
    Path(id): Path<Uuid>,
    Json(input): Json<Confirmation>,
) -> Result<StatusCode> {
    check(&state, &auth, id).await?;
    if input.confirm != "永久删除" {
        return Err(AppError::bad("请输入永久删除确认"));
    }
    let result = sqlx::query("DELETE FROM items WHERE id=$1 AND deleted_at IS NOT NULL")
        .bind(id)
        .execute(&state.db)
        .await?;
    if result.rows_affected() == 0 {
        return Err(AppError::bad("只能永久删除回收站中的资产"));
    }
    state.file_cleanup.notify_one();
    Ok(StatusCode::NO_CONTENT)
}

pub async fn versions(
    State(state): State<AppState>,
    Extension(auth): Extension<Auth>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    check(&state, &auth, id).await?;
    let rows: Vec<Value> = sqlx::query_scalar("SELECT jsonb_build_object('id',id,'revision',revision,'title',snapshot->>'title','reason',reason,'createdAt',created_at) FROM item_versions WHERE item_id=$1 ORDER BY revision DESC")
        .bind(id).fetch_all(&state.db).await?;
    Ok(Json(json!(rows)))
}

async fn version_item(state: &AppState, auth: &Auth, id: Uuid, version: Uuid) -> Result<Item> {
    check(state, auth, id).await?;
    let (snapshot, secret): (Value, Option<Vec<u8>>) =
        sqlx::query_as("SELECT snapshot,secret FROM item_versions WHERE id=$1 AND item_id=$2")
            .bind(version)
            .bind(id)
            .fetch_one(&state.db)
            .await?;
    let mut row: ItemRow =
        serde_json::from_value(snapshot).map_err(|_| AppError::bad("历史记录格式错误"))?;
    row.secret = secret;
    row.public(auth.key.as_ref(), true)
}
pub async fn version(
    State(state): State<AppState>,
    Extension(auth): Extension<Auth>,
    Path((id, version)): Path<(Uuid, Uuid)>,
) -> Result<Json<Item>> {
    Ok(Json(version_item(&state, &auth, id, version).await?))
}
#[derive(Deserialize)]
pub struct Revision {
    pub revision: i64,
}
pub async fn restore_version(
    State(state): State<AppState>,
    Extension(auth): Extension<Auth>,
    Path((id, version)): Path<(Uuid, Uuid)>,
    Json(input): Json<Revision>,
) -> Result<Json<Item>> {
    let historical = version_item(&state, &auth, id, version).await?;
    let mut restored: ItemInput =
        serde_json::from_value(json!(historical)).map_err(|_| AppError::bad("无法恢复此版本"))?;
    restored.revision = Some(input.revision);
    let mut tx = state.db.begin().await?;
    sqlx::query("SELECT set_config('infohub.change_reason','restore-version',true)")
        .execute(&mut *tx)
        .await?;
    let item = routes::save(&mut tx, id, &mut restored, &auth).await?;
    sqlx::query("DELETE FROM media WHERE item_id=$1")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("INSERT INTO media(id,item_id,source_url,mime,sha256,storage_key) SELECT media_id,$1,source_url,mime,sha256,storage_key FROM version_media WHERE version_id=$2")
        .bind(id).bind(version).execute(&mut *tx).await?;
    tx.commit().await?;
    state.file_cleanup.notify_one();
    Ok(Json(item))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftInput {
    pub kind: String,
    pub item_id: Option<Uuid>,
    pub base_revision: Option<i64>,
    pub payload: Value,
    pub generation: Option<i64>,
}
pub async fn drafts(
    State(state): State<AppState>,
    Extension(auth): Extension<Auth>,
) -> Result<Json<Value>> {
    let rows: Vec<Value> = sqlx::query_scalar("SELECT jsonb_build_object('id',id,'kind',kind,'itemId',item_id,'baseRevision',base_revision,'generation',generation,'updatedAt',updated_at) FROM drafts WHERE (NOT encrypted OR $1) ORDER BY updated_at DESC")
        .bind(auth.key.is_some()).fetch_all(&state.db).await?;
    Ok(Json(json!(rows)))
}
pub async fn draft(
    State(state): State<AppState>,
    Extension(auth): Extension<Auth>,
    Path(id): Path<String>,
) -> Result<Json<Value>> {
    let (payload, encrypted, revision, generation, updated_at): (
        Vec<u8>,
        bool,
        Option<i64>,
        i64,
        chrono::DateTime<chrono::Utc>,
    ) = sqlx::query_as(
        "SELECT payload,encrypted,base_revision,generation,updated_at FROM drafts WHERE id=$1",
    )
    .bind(&id)
    .fetch_one(&state.db)
    .await?;
    let bytes = if encrypted {
        crypto::decrypt(auth.vault()?, &payload, &format!("draft:{id}"))?
    } else {
        zeroize::Zeroizing::new(payload)
    };
    let payload: Value =
        serde_json::from_slice(&bytes).map_err(|_| AppError::bad("草稿数据损坏"))?;
    Ok(Json(
        json!({"payload":payload,"baseRevision":revision,"generation":generation,"updatedAt":updated_at}),
    ))
}
pub async fn save_draft(
    State(state): State<AppState>,
    Extension(auth): Extension<Auth>,
    Path(id): Path<String>,
    Json(input): Json<DraftInput>,
) -> Result<Json<Value>> {
    if id.is_empty()
        || id.len() > 200
        || !["knowledge", "repo", "credential"].contains(&input.kind.as_str())
    {
        return Err(AppError::bad("草稿类型或标识无效"));
    }
    if let Some(item_id) = input.item_id {
        let kind: String =
            sqlx::query_scalar("SELECT kind FROM items WHERE id=$1 AND deleted_at IS NULL")
                .bind(item_id)
                .fetch_one(&state.db)
                .await?;
        if kind != input.kind {
            return Err(AppError::bad("草稿类型与资产不一致"));
        }
    }
    let bytes = zeroize::Zeroizing::new(
        serde_json::to_vec(&input.payload).map_err(|_| AppError::bad("草稿无效"))?,
    );
    if bytes.len() > 4 * 1024 * 1024 {
        return Err(AppError::bad("草稿最多 4 MB"));
    }
    let encrypted = input.kind == "credential";
    let payload = if encrypted {
        crypto::encrypt(auth.vault()?, &bytes, &format!("draft:{id}"))?
    } else {
        bytes.to_vec()
    };
    let generation: Option<i64> = sqlx::query_scalar("INSERT INTO drafts(id,kind,item_id,base_revision,payload,encrypted) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO UPDATE SET payload=$5,base_revision=$4,updated_at=now(),generation=drafts.generation+1 WHERE drafts.kind=$2 AND drafts.item_id IS NOT DISTINCT FROM $3 AND drafts.generation=$7 RETURNING generation")
        .bind(&id).bind(input.kind).bind(input.item_id).bind(input.base_revision).bind(payload).bind(encrypted).bind(input.generation.unwrap_or(0)).fetch_optional(&state.db).await?;
    let generation = generation.ok_or_else(|| {
        AppError(
            StatusCode::CONFLICT,
            "草稿已在其他窗口修改，请重新读取后保存".into(),
        )
    })?;
    Ok(Json(json!({"generation":generation})))
}
#[derive(Deserialize)]
pub struct DraftGeneration {
    pub generation: Option<i64>,
}
pub async fn delete_draft(
    State(state): State<AppState>,
    Extension(auth): Extension<Auth>,
    Path(id): Path<String>,
    Query(query): Query<DraftGeneration>,
) -> Result<StatusCode> {
    let encrypted: Option<bool> = sqlx::query_scalar("SELECT encrypted FROM drafts WHERE id=$1")
        .bind(&id)
        .fetch_optional(&state.db)
        .await?;
    if encrypted == Some(true) {
        auth.vault()?;
    }
    let result =
        sqlx::query("DELETE FROM drafts WHERE id=$1 AND ($2::bigint IS NULL OR generation=$2)")
            .bind(id)
            .bind(query.generation)
            .execute(&state.db)
            .await?;
    if encrypted.is_some() && result.rows_affected() == 0 {
        return Err(AppError(
            StatusCode::CONFLICT,
            "其他窗口的草稿已更新，未删除新草稿".into(),
        ));
    }
    Ok(StatusCode::NO_CONTENT)
}
