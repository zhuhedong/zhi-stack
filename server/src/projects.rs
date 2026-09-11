use crate::{
    auth::Auth,
    error::{AppError, Result},
    lifecycle,
    model::ItemRow,
    AppState,
};
use axum::{
    extract::{Path, State},
    http::StatusCode,
    Extension, Json,
};
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

pub async fn list(State(state): State<AppState>) -> Result<Json<Value>> {
    let rows:Vec<Value>=sqlx::query_scalar("SELECT to_jsonb(p)||jsonb_build_object('count',(SELECT count(*) FROM items i WHERE i.project=p.name AND i.deleted_at IS NULL)) FROM projects p ORDER BY p.archived,p.updated_at DESC,p.name").fetch_all(&state.db).await?;
    Ok(Json(json!(rows)))
}
#[derive(Deserialize)]
pub struct ProjectInput {
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub archived: bool,
    pub revision: Option<i64>,
}
fn validate(input: &mut ProjectInput) -> Result<()> {
    input.name = input.name.trim().to_string();
    if input.name.is_empty() || input.name.len() > 500 || input.description.len() > 16000 {
        return Err(AppError::bad(
            "项目名称不能为空或超过 500 字节，说明最多 16 KB",
        ));
    }
    Ok(())
}
pub async fn create(
    State(state): State<AppState>,
    Json(mut input): Json<ProjectInput>,
) -> Result<Json<Value>> {
    validate(&mut input)?;
    let row:Value=sqlx::query_scalar("INSERT INTO projects(name,description,archived) VALUES($1,$2,$3) RETURNING to_jsonb(projects)").bind(input.name).bind(input.description).bind(input.archived).fetch_one(&state.db).await?;
    Ok(Json(row))
}
pub async fn update(
    State(state): State<AppState>,
    Extension(auth): Extension<Auth>,
    Path(id): Path<Uuid>,
    Json(mut input): Json<ProjectInput>,
) -> Result<Json<Value>> {
    validate(&mut input)?;
    let mut tx = state.db.begin().await?;
    let (old, revision): (String, i64) =
        sqlx::query_as("SELECT name,revision FROM projects WHERE id=$1 FOR UPDATE")
            .bind(id)
            .fetch_one(&mut *tx)
            .await?;
    if input.revision != Some(revision) {
        return Err(AppError(
            StatusCode::CONFLICT,
            "项目已被修改，请重新加载".into(),
        ));
    }
    if old != input.name {
        let has_credentials: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM items WHERE project=$1 AND kind='credential')",
        )
        .bind(&old)
        .fetch_one(&mut *tx)
        .await?;
        if has_credentials {
            auth.vault()?;
        }
    }
    let project:Value=sqlx::query_scalar("UPDATE projects SET name=$2,description=$3,archived=$4,revision=revision+1,updated_at=now() WHERE id=$1 RETURNING to_jsonb(projects)").bind(id).bind(&input.name).bind(input.description).bind(input.archived).fetch_one(&mut *tx).await?;
    if old != input.name {
        sqlx::query(
            "UPDATE items SET project=$2,revision=revision+1,updated_at=now() WHERE project=$1",
        )
        .bind(old)
        .bind(input.name)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(Json(project))
}
pub async fn detail(
    State(state): State<AppState>,
    Extension(auth): Extension<Auth>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    let project: Value = sqlx::query_scalar("SELECT to_jsonb(p) FROM projects p WHERE id=$1")
        .bind(id)
        .fetch_one(&state.db)
        .await?;
    let rows=sqlx::query_as::<_,ItemRow>("SELECT id,kind,title,category,project,tags,summary,url,CASE WHEN kind='repo' THEN jsonb_build_object('stars',data->'stars') ELSE '{}'::jsonb END AS data,NULL::bytea AS secret,favorite,revision,created_at,updated_at FROM items WHERE project=$1 AND deleted_at IS NULL ORDER BY updated_at DESC").bind(project["name"].as_str()).fetch_all(&state.db).await?;
    let items = rows
        .into_iter()
        .map(|row| row.public(auth.key.as_ref(), false))
        .collect::<Result<Vec<_>>>()?;
    Ok(Json(json!({"project":project,"items":items})))
}
pub async fn relations(
    State(state): State<AppState>,
    Extension(auth): Extension<Auth>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    lifecycle::check(&state, &auth, id).await?;
    let rows:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('sourceId',r.source_id,'targetId',r.target_id,'label',r.label,'id',i.id,'kind',i.kind,'title',i.title,'project',i.project) FROM item_relations r JOIN items i ON i.id=CASE WHEN r.source_id=$1 THEN r.target_id ELSE r.source_id END WHERE (r.source_id=$1 OR r.target_id=$1) AND i.deleted_at IS NULL ORDER BY r.created_at DESC").bind(id).fetch_all(&state.db).await?;
    Ok(Json(json!(rows)))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelationInput {
    pub target_id: Uuid,
    pub label: String,
}
pub async fn link(
    State(state): State<AppState>,
    Extension(auth): Extension<Auth>,
    Path(id): Path<Uuid>,
    Json(input): Json<RelationInput>,
) -> Result<StatusCode> {
    lifecycle::check(&state, &auth, id).await?;
    lifecycle::check(&state, &auth, input.target_id).await?;
    if id == input.target_id || input.label.trim().is_empty() || input.label.chars().count() > 100 {
        return Err(AppError::bad("请选择其他资产，关联说明需要 1–100 字"));
    }
    sqlx::query("INSERT INTO item_relations(source_id,target_id,label) VALUES($1,$2,$3) ON CONFLICT(source_id,target_id) DO UPDATE SET label=$3").bind(id).bind(input.target_id).bind(input.label.trim()).execute(&state.db).await?;
    Ok(StatusCode::NO_CONTENT)
}
pub async fn unlink(
    State(state): State<AppState>,
    Extension(auth): Extension<Auth>,
    Path((id, target)): Path<(Uuid, Uuid)>,
) -> Result<StatusCode> {
    lifecycle::check(&state, &auth, id).await?;
    lifecycle::check(&state, &auth, target).await?;
    sqlx::query("DELETE FROM item_relations WHERE (source_id=$1 AND target_id=$2) OR (source_id=$2 AND target_id=$1)").bind(id).bind(target).execute(&state.db).await?;
    Ok(StatusCode::NO_CONTENT)
}
pub async fn state(State(state): State<AppState>, Path(id): Path<Uuid>) -> Result<Json<Value>> {
    let exists: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM items WHERE id=$1 AND deleted_at IS NULL)")
            .bind(id)
            .fetch_one(&state.db)
            .await?;
    if !exists {
        return Err(sqlx::Error::RowNotFound.into());
    }
    let value: Option<Value> =
        sqlx::query_scalar("SELECT to_jsonb(s) FROM item_state s WHERE item_id=$1")
            .bind(id)
            .fetch_optional(&state.db)
            .await?;
    Ok(Json(value.unwrap_or(json!({"archived":false,"later":false,"progress":0,"annotation":"","visit_count":0,"revision":0}))))
}
#[derive(Deserialize)]
pub struct StateInput {
    pub archived: Option<bool>,
    pub later: Option<bool>,
    pub progress: Option<i32>,
    pub annotation: Option<String>,
    pub revision: Option<i64>,
}
pub async fn update_state(
    State(state): State<AppState>,
    Extension(auth): Extension<Auth>,
    Path(id): Path<Uuid>,
    Json(input): Json<StateInput>,
) -> Result<StatusCode> {
    lifecycle::check(&state, &auth, id).await?;
    if input.progress.is_some_and(|p| !(0..=100).contains(&p))
        || input
            .annotation
            .as_ref()
            .is_some_and(|s| s.len() > 128 * 1024)
    {
        return Err(AppError::bad("进度范围为 0–100，批注最多 128 KB"));
    }
    let kind: String =
        sqlx::query_scalar("SELECT kind FROM items WHERE id=$1 AND deleted_at IS NULL")
            .bind(id)
            .fetch_one(&state.db)
            .await?;
    if kind == "credential" && input.annotation.as_ref().is_some_and(|s| !s.is_empty()) {
        return Err(AppError::bad("凭证说明请在加密属性中填写"));
    }
    if input.annotation.is_some() && input.revision.is_none() {
        return Err(AppError::bad("批注保存需要版本号，请重新读取阅读记录"));
    }
    let changed=sqlx::query("INSERT INTO item_state(item_id,archived,later,progress,annotation) VALUES($1,COALESCE($2,false),COALESCE($3,false),COALESCE($4,0),COALESCE($5,'')) ON CONFLICT(item_id) DO UPDATE SET archived=COALESCE($2,item_state.archived),later=COALESCE($3,item_state.later),progress=COALESCE($4,item_state.progress),annotation=COALESCE($5,item_state.annotation),updated_at=now(),revision=item_state.revision+1 WHERE $6::bigint IS NULL OR item_state.revision=$6")
        .bind(id).bind(input.archived).bind(input.later).bind(input.progress).bind(input.annotation).bind(input.revision).execute(&state.db).await?;
    if changed.rows_affected() == 0 {
        return Err(AppError(
            StatusCode::CONFLICT,
            "阅读记录已在其他窗口修改，请重新加载后合并批注".into(),
        ));
    }
    Ok(StatusCode::NO_CONTENT)
}
pub async fn visit(State(state): State<AppState>, Path(id): Path<Uuid>) -> Result<StatusCode> {
    sqlx::query("INSERT INTO item_state(item_id,last_opened_at,visit_count) SELECT id,now(),1 FROM items WHERE id=$1 AND deleted_at IS NULL ON CONFLICT(item_id) DO UPDATE SET last_opened_at=now(),visit_count=item_state.visit_count+1,updated_at=now()")
        .bind(id).execute(&state.db).await?;
    Ok(StatusCode::NO_CONTENT)
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchInput {
    pub ids: Vec<Uuid>,
    pub project: Option<String>,
    pub archived: Option<bool>,
    pub add_tags: Option<Vec<String>>,
    pub remove_tags: Option<Vec<String>>,
}
pub async fn batch(
    State(state): State<AppState>,
    Extension(auth): Extension<Auth>,
    Json(input): Json<BatchInput>,
) -> Result<Json<Value>> {
    if input.ids.is_empty() || input.ids.len() > 200 {
        return Err(AppError::bad("每次选择 1–200 条资产"));
    }
    if input.project.as_ref().is_some_and(|p| p.len() > 500) {
        return Err(AppError::bad("项目名过长"));
    }
    let mut tx = state.db.begin().await?;
    let rows = sqlx::query_as::<_, ItemRow>(
        "SELECT * FROM items WHERE id=ANY($1) AND deleted_at IS NULL ORDER BY id FOR UPDATE",
    )
    .bind(&input.ids)
    .fetch_all(&mut *tx)
    .await?;
    if rows.len()
        != input
            .ids
            .iter()
            .collect::<std::collections::HashSet<_>>()
            .len()
    {
        return Err(AppError(
            StatusCode::CONFLICT,
            "部分资产已删除，请刷新列表".into(),
        ));
    }
    for row in rows {
        if row.kind == "credential" {
            auth.vault()?;
        }
        let mut tags = row.tags;
        if let Some(remove) = &input.remove_tags {
            tags.retain(|t| !remove.contains(t));
        }
        if let Some(add) = &input.add_tags {
            tags.extend(
                add.iter()
                    .map(|t| t.trim().to_string())
                    .filter(|t| !t.is_empty()),
            );
        }
        tags.sort();
        tags.dedup();
        if tags.len() > 50 || tags.iter().any(|t| t.chars().count() > 100) {
            return Err(AppError::bad("每条资产最多 50 个标签，每项最多 100 字"));
        }
        if input.project.is_some() || input.add_tags.is_some() || input.remove_tags.is_some() {
            sqlx::query("UPDATE items SET project=COALESCE($2,project),tags=$3,revision=revision+1,updated_at=now() WHERE id=$1").bind(row.id).bind(input.project.as_ref().map(|p|p.trim())).bind(tags).execute(&mut *tx).await?;
        }
        if let Some(archived) = input.archived {
            sqlx::query("INSERT INTO item_state(item_id,archived) VALUES($1,$2) ON CONFLICT(item_id) DO UPDATE SET archived=$2,updated_at=now(),revision=item_state.revision+1").bind(row.id).bind(archived).execute(&mut *tx).await?;
        }
    }
    tx.commit().await?;
    Ok(Json(json!({"updated":input.ids.len()})))
}
