//! In-article highlights. Anchors are text quotes with surrounding context plus
//! the offset in the rendered article text, so the client can re-locate them
//! after the article is edited or re-synced.
use crate::{
    error::{AppError, Result},
    AppState,
};
use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

const COLORS: &[&str] = &["yellow", "green", "blue", "pink", "purple"];
const SELECT: &str = "SELECT jsonb_build_object('id',id,'itemId',item_id,'quote',quote,'prefix',prefix,'suffix',suffix,'startOffset',start_offset,'color',color,'note',note,'revision',revision,'createdAt',created_at,'updatedAt',updated_at) FROM highlights";

async fn article(state: &AppState, id: Uuid) -> Result<()> {
    let found: Option<String> =
        sqlx::query_scalar("SELECT kind FROM items WHERE id=$1 AND deleted_at IS NULL")
            .bind(id)
            .fetch_optional(&state.db)
            .await?;
    match found.as_deref() {
        Some("knowledge") => Ok(()),
        Some(_) => Err(AppError::bad("只有知识与文章可以划线")),
        None => Err(AppError(StatusCode::NOT_FOUND, "资料不存在".into())),
    }
}
pub async fn list(State(state): State<AppState>, Path(id): Path<Uuid>) -> Result<Json<Value>> {
    article(&state, id).await?;
    let rows: Vec<Value> = sqlx::query_scalar(&format!(
        "{SELECT} WHERE item_id=$1 ORDER BY start_offset,created_at"
    ))
    .bind(id)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(json!(rows)))
}
/// Recent highlights across all articles (for the 划线笔记 overview).
pub async fn recent(State(state): State<AppState>) -> Result<Json<Value>> {
    let rows: Vec<Value> = sqlx::query_scalar(
        "SELECT jsonb_build_object('id',h.id,'itemId',h.item_id,'itemTitle',i.title,'quote',h.quote,'color',h.color,'note',h.note,'updatedAt',h.updated_at) FROM highlights h JOIN items i ON i.id=h.item_id WHERE i.deleted_at IS NULL ORDER BY h.updated_at DESC LIMIT 200",
    )
    .fetch_all(&state.db)
    .await?;
    Ok(Json(json!(rows)))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewHighlight {
    pub quote: String,
    #[serde(default)]
    pub prefix: String,
    #[serde(default)]
    pub suffix: String,
    pub start_offset: i32,
    #[serde(default = "yellow")]
    pub color: String,
    #[serde(default)]
    pub note: String,
}
fn yellow() -> String {
    "yellow".into()
}
fn check(color: &str, note: &str) -> Result<()> {
    if !COLORS.contains(&color) {
        return Err(AppError::bad("不支持的划线颜色"));
    }
    if note.chars().count() > 20000 {
        return Err(AppError::bad("笔记超过 20000 字"));
    }
    Ok(())
}
fn clip(value: &str, max: usize) -> String {
    value.chars().take(max).collect()
}
pub async fn create(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Json(input): Json<NewHighlight>,
) -> Result<(StatusCode, Json<Value>)> {
    article(&state, id).await?;
    check(&input.color, &input.note)?;
    let count = input.quote.chars().count();
    if input.quote.trim().is_empty() || count > 5000 || input.start_offset < 0 {
        return Err(AppError::bad("划线内容需为 1–5000 字"));
    }
    let total: i64 = sqlx::query_scalar("SELECT count(*) FROM highlights WHERE item_id=$1")
        .bind(id)
        .fetch_one(&state.db)
        .await?;
    if total >= 1000 {
        return Err(AppError::bad("单篇文章最多 1000 条划线"));
    }
    let hid = Uuid::new_v4();
    sqlx::query("INSERT INTO highlights(id,item_id,quote,prefix,suffix,start_offset,color,note) VALUES($1,$2,$3,$4,$5,$6,$7,$8)")
        .bind(hid)
        .bind(id)
        .bind(&input.quote)
        .bind(clip(&input.prefix, 64))
        .bind(clip(&input.suffix, 64))
        .bind(input.start_offset)
        .bind(&input.color)
        .bind(&input.note)
        .execute(&state.db)
        .await?;
    let row: Value = sqlx::query_scalar(&format!("{SELECT} WHERE id=$1"))
        .bind(hid)
        .fetch_one(&state.db)
        .await?;
    Ok((StatusCode::CREATED, Json(row)))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HighlightUpdate {
    pub color: String,
    pub note: String,
    pub revision: i64,
    /// Re-anchored position after the article text changed (optional).
    pub start_offset: Option<i32>,
}
pub async fn update(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Json(input): Json<HighlightUpdate>,
) -> Result<Json<Value>> {
    check(&input.color, &input.note)?;
    let changed = sqlx::query("UPDATE highlights SET color=$2,note=$3,start_offset=COALESCE($5,start_offset),revision=revision+1,updated_at=now() WHERE id=$1 AND revision=$4 AND ($5::int IS NULL OR $5>=0)")
        .bind(id)
        .bind(&input.color)
        .bind(&input.note)
        .bind(input.revision)
        .bind(input.start_offset)
        .execute(&state.db)
        .await?;
    if changed.rows_affected() == 0 {
        let exists: bool =
            sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM highlights WHERE id=$1)")
                .bind(id)
                .fetch_one(&state.db)
                .await?;
        return Err(if exists {
            AppError(
                StatusCode::CONFLICT,
                "划线已在别处修改，请刷新后重试".into(),
            )
        } else {
            AppError(StatusCode::NOT_FOUND, "划线不存在".into())
        });
    }
    let row: Value = sqlx::query_scalar(&format!("{SELECT} WHERE id=$1"))
        .bind(id)
        .fetch_one(&state.db)
        .await?;
    Ok(Json(row))
}
pub async fn delete(State(state): State<AppState>, Path(id): Path<Uuid>) -> Result<StatusCode> {
    let removed = sqlx::query("DELETE FROM highlights WHERE id=$1")
        .bind(id)
        .execute(&state.db)
        .await?;
    if removed.rows_affected() == 0 {
        return Err(AppError(StatusCode::NOT_FOUND, "划线不存在".into()));
    }
    Ok(StatusCode::NO_CONTENT)
}
