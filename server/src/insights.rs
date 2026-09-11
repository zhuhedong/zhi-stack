//! Local workbench measurements. Only fixed event names, timestamps and optional
//! opaque asset IDs are retained. Request content and search strings are never logged.
use crate::{
    auth::Auth,
    crypto,
    error::{AppError, Result},
    AppState,
};
use axum::{
    extract::{Path, Request, State},
    http::StatusCode,
    middleware::Next,
    response::Response,
    Extension, Json,
};
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

pub async fn record(state: &AppState, event: &str, item: Option<Uuid>) -> Result<()> {
    let mut tx = state.db.begin().await?;
    let enabled: bool =
        sqlx::query_scalar("SELECT usage_enabled FROM workbench_preferences WHERE id=1 FOR SHARE")
            .fetch_one(&mut *tx)
            .await?;
    if enabled {
        sqlx::query("INSERT INTO usage_events(id,event,item_id) VALUES($1,$2,$3)")
            .bind(Uuid::new_v4())
            .bind(event)
            .bind(item)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(())
}
pub async fn track(State(state): State<AppState>, request: Request, next: Next) -> Response {
    let path = request.uri().path();
    let method = request.method().as_str();
    let parts: Vec<&str> = path.trim_matches('/').split('/').collect();
    let item = parts.get(2).and_then(|id| Uuid::parse_str(id).ok());
    let event = match (method, parts.as_slice()) {
        ("POST", ["api", "auth", "setup" | "login"]) => Some("session_started"),
        ("POST", ["api", "items"]) => Some("item_created"),
        ("POST", ["api", "items", _, "visit"]) => Some("item_opened"),
        ("POST", ["api", "probe"]) => Some("request_sent"),
        ("POST", ["api", "jobs"]) => Some("ingest_queued"),
        ("GET", ["api", "items"]) => {
            let query: std::collections::HashMap<_, _> =
                url::form_urlencoded::parse(request.uri().query().unwrap_or_default().as_bytes())
                    .into_owned()
                    .collect();
            (query.get("q").is_some_and(|q| !q.trim().is_empty())
                && query.get("offset").is_none_or(|offset| offset == "0"))
            .then_some("search")
        }
        _ => None,
    };
    let response = next.run(request).await;
    if response.status().is_success() {
        if let Some(event) = event {
            if record(&state, event, item).await.is_err() {
                tracing::warn!("local usage event could not be recorded");
            }
        }
    }
    response
}
pub async fn usage(State(state): State<AppState>) -> Result<Json<Value>> {
    let preferences: Value =
        sqlx::query_scalar("SELECT to_jsonb(p) FROM workbench_preferences p WHERE id=1")
            .fetch_one(&state.db)
            .await?;
    let totals:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('event',event,'count',count(*)) FROM usage_events WHERE created_at>=now()-interval '30 days' GROUP BY event ORDER BY event").fetch_all(&state.db).await?;
    let daily:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('date',(created_at AT TIME ZONE 'UTC')::date,'count',count(*)) FROM usage_events WHERE created_at>=now()-interval '30 days' GROUP BY (created_at AT TIME ZONE 'UTC')::date ORDER BY (created_at AT TIME ZONE 'UTC')::date").fetch_all(&state.db).await?;
    let active_days:i64=sqlx::query_scalar("SELECT count(DISTINCT (created_at AT TIME ZONE 'UTC')::date) FROM usage_events WHERE created_at>=(date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')-interval '6 days'").fetch_one(&state.db).await?;
    let reused:i64=sqlx::query_scalar("SELECT count(*) FROM (SELECT item_id FROM usage_events WHERE event='item_opened' AND created_at>=now()-interval '30 days' AND item_id IS NOT NULL GROUP BY item_id HAVING count(*)>1) t").fetch_one(&state.db).await?;
    let first_value_seconds:Option<f64>=sqlx::query_scalar("SELECT CASE WHEN first_value>=started THEN EXTRACT(EPOCH FROM (first_value-started))::double precision END FROM (SELECT min(created_at) FILTER(WHERE event='session_started') AS started,min(created_at) FILTER(WHERE event IN ('item_created','ingest_completed')) AS first_value FROM usage_events) t").fetch_one(&state.db).await?;
    Ok(Json(
        json!({"preferences":preferences,"totals":totals,"daily":daily,"activeDays7":active_days,"reusedAssets30":reused,"firstValueSeconds":first_value_seconds,"windowDays":30,"retentionDays":180,"dateTimezone":"UTC"}),
    ))
}
#[derive(Deserialize)]
pub struct UsageSettings {
    pub enabled: bool,
}
pub async fn settings(
    State(state): State<AppState>,
    Json(input): Json<UsageSettings>,
) -> Result<StatusCode> {
    sqlx::query("UPDATE workbench_preferences SET usage_enabled=$1 WHERE id=1")
        .bind(input.enabled)
        .execute(&state.db)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}
#[derive(Deserialize)]
pub struct Confirmation {
    pub confirm: String,
}
pub async fn clear(
    State(state): State<AppState>,
    Json(input): Json<Confirmation>,
) -> Result<StatusCode> {
    if input.confirm != "清空统计" {
        return Err(AppError::bad("请确认清空统计"));
    }
    let mut tx = state.db.begin().await?;
    sqlx::query("UPDATE workbench_preferences SET usage_since=now() WHERE id=1")
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM usage_events")
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}
pub async fn onboarding(State(state): State<AppState>) -> Result<Json<Value>> {
    let hidden: bool =
        sqlx::query_scalar("SELECT onboarding_hidden FROM workbench_preferences WHERE id=1")
            .fetch_one(&state.db)
            .await?;
    let created: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM items WHERE deleted_at IS NULL)")
            .fetch_one(&state.db)
            .await?;
    let organized: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM items WHERE deleted_at IS NULL AND project<>'')",
    )
    .fetch_one(&state.db)
    .await?;
    let reused:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM item_state s JOIN items i ON i.id=s.item_id WHERE i.deleted_at IS NULL AND s.visit_count>=2)").fetch_one(&state.db).await?;
    Ok(Json(
        json!({"hidden":hidden,"created":created,"organized":organized,"reused":reused}),
    ))
}
#[derive(Deserialize)]
pub struct OnboardingSettings {
    pub hidden: bool,
}
pub async fn set_onboarding(
    State(state): State<AppState>,
    Json(input): Json<OnboardingSettings>,
) -> Result<StatusCode> {
    sqlx::query("UPDATE workbench_preferences SET onboarding_hidden=$1 WHERE id=1")
        .bind(input.hidden)
        .execute(&state.db)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}
#[derive(Deserialize)]
pub struct FeedbackInput {
    pub category: String,
    pub message: String,
    pub rating: Option<i32>,
}
pub async fn add_feedback(
    State(state): State<AppState>,
    Extension(auth): Extension<Auth>,
    Json(input): Json<FeedbackInput>,
) -> Result<(StatusCode, Json<Value>)> {
    auth.vault()?;
    if !["bug", "usability", "idea"].contains(&input.category.as_str())
        || input.message.trim().is_empty()
        || input.message.len() > 8192
        || input
            .rating
            .is_some_and(|rating| !(1..=5).contains(&rating))
    {
        return Err(AppError::bad(
            "请填写问题类型和最多 8 KB 的反馈，评分范围 1–5",
        ));
    }
    let id = Uuid::new_v4();
    let value =
        json!({"category":input.category,"message":input.message.trim(),"rating":input.rating});
    let payload = crypto::encrypt(
        auth.vault()?,
        value.to_string().as_bytes(),
        &format!("feedback:{id}"),
    )?;
    sqlx::query("INSERT INTO feedback(id,payload) VALUES($1,$2)")
        .bind(id)
        .bind(payload)
        .execute(&state.db)
        .await?;
    Ok((StatusCode::CREATED, Json(json!({"id":id}))))
}
pub async fn feedback(
    State(state): State<AppState>,
    Extension(auth): Extension<Auth>,
) -> Result<Json<Value>> {
    auth.vault()?;
    let rows: Vec<(Uuid, Vec<u8>, bool, chrono::DateTime<chrono::Utc>)> = sqlx::query_as(
        "SELECT id,payload,resolved,created_at FROM feedback ORDER BY created_at DESC",
    )
    .fetch_all(&state.db)
    .await?;
    let mut result = vec![];
    for (id, bytes, resolved, created) in rows {
        let bytes = crypto::decrypt(auth.vault()?, &bytes, &format!("feedback:{id}"))?;
        let mut value: Value =
            serde_json::from_slice(&bytes).map_err(|_| AppError::bad("反馈无法解码"))?;
        value["id"] = json!(id);
        value["resolved"] = json!(resolved);
        value["createdAt"] = json!(created);
        result.push(value);
    }
    Ok(Json(json!(result)))
}
#[derive(Deserialize)]
pub struct FeedbackState {
    pub resolved: bool,
}
pub async fn update_feedback(
    State(state): State<AppState>,
    Extension(auth): Extension<Auth>,
    Path(id): Path<Uuid>,
    Json(input): Json<FeedbackState>,
) -> Result<StatusCode> {
    auth.vault()?;
    sqlx::query("UPDATE feedback SET resolved=$2 WHERE id=$1")
        .bind(id)
        .bind(input.resolved)
        .execute(&state.db)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}
pub async fn delete_feedback(
    State(state): State<AppState>,
    Extension(auth): Extension<Auth>,
    Path(id): Path<Uuid>,
) -> Result<StatusCode> {
    auth.vault()?;
    sqlx::query("DELETE FROM feedback WHERE id=$1")
        .bind(id)
        .execute(&state.db)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}
pub async fn activity(State(state): State<AppState>) -> Result<Json<Value>> {
    let value:Value=sqlx::query_scalar("SELECT jsonb_build_object('active',(SELECT count(*) FROM ingest_jobs WHERE status IN ('queued','running','waiting_unlock')),'failed',(SELECT count(*) FROM ingest_jobs WHERE status='failed'),'completed',(SELECT count(*) FROM ingest_jobs WHERE status='succeeded'),'unread',(SELECT count(*) FROM repo_subscriptions s JOIN items i ON i.id=s.item_id WHERE i.deleted_at IS NULL AND s.signature<>s.seen_signature))").fetch_one(&state.db).await?;
    Ok(Json(value))
}
