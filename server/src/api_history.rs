use crate::{
    auth::Auth,
    crypto,
    error::{AppError, Result},
    net::ProbeInput,
    routes, AppState,
};
use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    Extension, Json,
};
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackedProbe {
    #[serde(flatten)]
    pub request: ProbeInput,
    pub item_id: Option<Uuid>,
    pub request_id: Option<Uuid>,
    #[serde(default)]
    pub environment: String,
}
async fn check(state: &AppState, auth: &Auth, item: Uuid) -> Result<()> {
    auth.vault()?;
    let exists:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM items WHERE id=$1 AND kind='credential' AND category='http' AND deleted_at IS NULL)").bind(item).fetch_one(&state.db).await?;
    if !exists {
        return Err(sqlx::Error::RowNotFound.into());
    }
    Ok(())
}
fn sealed(auth: &Auth, id: Uuid, payload: &Value) -> Result<Vec<u8>> {
    let bytes = serde_json::to_vec(payload).map_err(|_| AppError::bad("请求历史无法编码"))?;
    crypto::encrypt(auth.vault()?, &bytes, &format!("request:{id}"))
}
fn opened(auth: &Auth, id: Uuid, payload: &[u8]) -> Result<Value> {
    let bytes = crypto::decrypt(auth.vault()?, payload, &format!("request:{id}"))?;
    serde_json::from_slice(&bytes).map_err(|_| AppError::bad("请求历史无法解码"))
}
fn cancelled() -> AppError {
    AppError(
        StatusCode::REQUEST_TIMEOUT,
        "请求已取消；已送达目标服务的操作无法撤回".into(),
    )
}

pub async fn probe(
    State(state): State<AppState>,
    Extension(auth): Extension<Auth>,
    Json(input): Json<TrackedProbe>,
) -> Result<Json<Value>> {
    auth.vault()?;
    let (item, id) = match (input.item_id, input.request_id) {
        (Some(item), Some(id)) => (item, id),
        (None, None) => return routes::perform_probe(&state, input.request).await.map(Json),
        _ => return Err(AppError::bad("记录请求需要资产及请求编号")),
    };
    check(&state, &auth, item).await?;
    if input.environment.len() > 500 {
        return Err(AppError::bad("环境名过长"));
    }
    let mut payload = json!({"request":input.request,"environment":input.environment});
    if serde_json::to_vec(&payload)
        .map_err(|_| AppError::bad("请求无效"))?
        .len()
        > 3 * 1024 * 1024
    {
        return Err(AppError::bad("请求及请求头总计最多 3 MB"));
    }
    let token = tokio_util::sync::CancellationToken::new();
    // Hold the registry lock until insertion so cancellation cannot miss a started request.
    let mut active = state.active_requests.lock().await;
    let inserted=sqlx::query("INSERT INTO api_history(id,item_id,payload,status) VALUES($1,$2,$3,'running') ON CONFLICT DO NOTHING").bind(id).bind(item).bind(sealed(&auth,id,&payload)?).execute(&state.db).await?;
    if inserted.rows_affected() == 0 {
        let status: Option<String> =
            sqlx::query_scalar("SELECT status FROM api_history WHERE id=$1 AND item_id=$2")
                .bind(id)
                .bind(item)
                .fetch_optional(&state.db)
                .await?;
        return Err(if status.as_deref() == Some("cancelled") {
            cancelled()
        } else {
            AppError(
                StatusCode::CONFLICT,
                "该请求编号已使用，请创建新请求".into(),
            )
        });
    }
    active.insert(id, token.clone());
    drop(active);
    let outcome = tokio::select! {
        biased;
        _=token.cancelled()=>Err(cancelled()),
        result=routes::perform_probe(&state,input.request)=>result,
    };
    let status = if token.is_cancelled() {
        "cancelled"
    } else if outcome.is_ok() {
        "completed"
    } else {
        "failed"
    };
    match &outcome {
        Ok(response) => {
            let mut saved = response.clone();
            // Keep history and backups bounded; the current response remains downloadable in full.
            for field in ["body", "bodyBase64"] {
                if let Some(value) = saved[field].as_str().filter(|v| v.len() > 1024 * 1024) {
                    if field == "bodyBase64" {
                        saved[field] = Value::Null;
                    } else {
                        let mut end = 1024 * 1024;
                        while !value.is_char_boundary(end) {
                            end -= 1;
                        }
                        saved[field] = json!(&value[..end]);
                    }
                    saved["truncated"] = json!(true);
                }
            }
            // JSON escaping can expand text substantially. Bound the encoded record too.
            while serde_json::to_vec(&saved).map_or(usize::MAX, |v| v.len()) > 2 * 1024 * 1024 {
                let body = saved["body"].as_str().unwrap_or_default();
                if body.is_empty() {
                    saved["headers"] = json!({});
                    saved["bodyBase64"] = Value::Null;
                } else {
                    let mut end = body.len() / 2;
                    while !body.is_char_boundary(end) {
                        end -= 1;
                    }
                    saved["body"] = json!(&body[..end]);
                }
                saved["truncated"] = json!(true);
            }
            payload["response"] = saved;
        }
        Err(error) => payload["error"] = json!(error.1),
    }
    let changed=sqlx::query("UPDATE api_history SET payload=$3,status=$4,finished_at=now() WHERE id=$1 AND item_id=$2 AND status='running'").bind(id).bind(item).bind(sealed(&auth,id,&payload)?).bind(status).execute(&state.db).await;
    state.active_requests.lock().await.remove(&id);
    if changed?.rows_affected() == 0 || status == "cancelled" {
        return Err(cancelled());
    }
    outcome.map(Json)
}

#[derive(Deserialize)]
pub struct Page {
    pub offset: Option<i64>,
}
pub async fn list(
    State(state): State<AppState>,
    Extension(auth): Extension<Auth>,
    Path(item): Path<Uuid>,
    Query(page): Query<Page>,
) -> Result<Json<Value>> {
    check(&state, &auth, item).await?;
    let offset = page.offset.unwrap_or(0).max(0);
    let rows:Vec<(Uuid,Vec<u8>,String,chrono::DateTime<chrono::Utc>)>=sqlx::query_as("SELECT id,payload,status,created_at FROM api_history WHERE item_id=$1 ORDER BY created_at DESC,id DESC LIMIT 50 OFFSET $2").bind(item).bind(offset).fetch_all(&state.db).await?;
    let total: i64 = sqlx::query_scalar("SELECT count(*) FROM api_history WHERE item_id=$1")
        .bind(item)
        .fetch_one(&state.db)
        .await?;
    let mut items = vec![];
    for (id, bytes, status, created) in rows {
        let data = opened(&auth, id, &bytes)?;
        items.push(json!({"id":id,"status":status,"createdAt":created,"method":data["request"]["method"],"url":data["request"]["url"],"environment":data["environment"],"httpStatus":data["response"]["status"],"durationMs":data["response"]["durationMs"]}));
    }
    Ok(Json(json!({"items":items,"total":total})))
}
pub async fn detail(
    State(state): State<AppState>,
    Extension(auth): Extension<Auth>,
    Path((item, id)): Path<(Uuid, Uuid)>,
) -> Result<Json<Value>> {
    check(&state, &auth, item).await?;
    let (bytes, status): (Vec<u8>, String) =
        sqlx::query_as("SELECT payload,status FROM api_history WHERE id=$1 AND item_id=$2")
            .bind(id)
            .bind(item)
            .fetch_one(&state.db)
            .await?;
    let mut payload = opened(&auth, id, &bytes)?;
    payload["id"] = json!(id);
    payload["status"] = json!(status);
    Ok(Json(payload))
}
pub async fn cancel(
    State(state): State<AppState>,
    Extension(auth): Extension<Auth>,
    Path((item, id)): Path<(Uuid, Uuid)>,
) -> Result<StatusCode> {
    check(&state, &auth, item).await?;
    let active = state.active_requests.lock().await;
    // A cancellation arriving before /probe creates a tombstone. It prevents the late start.
    sqlx::query("INSERT INTO api_history(id,item_id,payload,status,finished_at) VALUES($1,$2,$3,'cancelled',now()) ON CONFLICT(id) DO UPDATE SET status='cancelled',finished_at=now() WHERE api_history.item_id=$2 AND api_history.status='running'").bind(id).bind(item).bind(sealed(&auth,id,&json!({}))?).execute(&state.db).await?;
    if let Some(token) = active.get(&id) {
        token.cancel();
    }
    Ok(StatusCode::NO_CONTENT)
}
pub async fn delete(
    State(state): State<AppState>,
    Extension(auth): Extension<Auth>,
    Path((item, id)): Path<(Uuid, Uuid)>,
) -> Result<StatusCode> {
    check(&state, &auth, item).await?;
    let active = state.active_requests.lock().await;
    if let Some(token) = active.get(&id) {
        token.cancel();
    }
    sqlx::query("DELETE FROM api_history WHERE id=$1 AND item_id=$2")
        .bind(id)
        .bind(item)
        .execute(&state.db)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}
