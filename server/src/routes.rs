use crate::{
    auth::Auth,
    crypto,
    error::{AppError, Result},
    files,
    ingest::{self as ingestion, Collected},
    model::{Item, ItemInput, ItemRow},
    net::{request_headers, ProbeInput},
    AppState,
};
use axum::{
    body::Body,
    extract::{Multipart, Path, State},
    http::{header, HeaderValue, StatusCode},
    response::Response,
    Extension, Json,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use reqwest::Method;
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::{Postgres, Transaction};
use uuid::Uuid;

fn search_data(data: &Value, query: &str) -> bool {
    match data {
        Value::String(value) => value.to_lowercase().contains(query),
        Value::Array(values) => values.iter().any(|value| search_data(value, query)),
        Value::Object(values) => values.values().any(|value| search_data(value, query)),
        Value::Null => false,
        _ => data.to_string().contains(query),
    }
}

pub(crate) fn credential_matches(
    key: &crypto::VaultKey,
    id: &str,
    secret: Option<&[u8]>,
    query: &str,
) -> bool {
    let Ok(bytes) = crypto::decrypt(key, secret.unwrap_or_default(), id) else {
        return false;
    };
    let Ok(data) = serde_json::from_slice::<Value>(&bytes) else {
        return false;
    };
    search_data(&data, query)
}

fn rest_credential(input: &ItemInput) -> bool {
    let type_key = input.data["typeKey"].as_str().unwrap_or("");
    type_key == "rest_api"
        || (type_key.is_empty() && (input.category == "http" || input.category.is_empty()))
}

#[cfg(test)]
mod business_tests {
    use super::*;

    #[test]
    fn synchronization_preserves_optional_resources_only_on_failure() {
        let previous = Item {
            id: Uuid::new_v4(),
            kind: "repo".into(),
            title: "repo".into(),
            category: "Rust".into(),
            project: String::new(),
            tags: vec![],
            summary: String::new(),
            url: String::new(),
            favorite: false,
            revision: 1,
            created_at: chrono::Utc::now(),
            updated_at: chrono::Utc::now(),
            data: json!({"readme":"last successful README","latestRelease":"v1","releaseNotes":"last release"}),
        };
        let mut collected = Collected {
            input: ItemInput {
                data: json!({}),
                ..Default::default()
            },
            images: vec![],
            warnings: vec!["upstream unavailable".into()],
        };
        preserve_sync_data(&previous, &mut collected);
        assert_eq!(collected.input.data["readme"], "last successful README");
        assert_eq!(collected.input.data["latestRelease"], "v1");
        collected.input.data = json!({"readme":"", "latestRelease":null,"releaseNotes":null});
        preserve_sync_data(&previous, &mut collected);
        assert_eq!(collected.input.data["readme"], "");
        assert_eq!(collected.input.data["latestRelease"], Value::Null);
    }

    #[test]
    fn search_matches_stored_values_not_json_field_names() {
        let credential = json!({"password":"secret-value","host":"db.internal","fields":{"password":"","host":"pg.example"}});
        assert!(!search_data(&credential, "password"));
        assert!(!search_data(&credential, "host"));
        assert!(!search_data(&credential, "fields"));
        assert!(search_data(&credential, "secret-value"));
        assert!(search_data(&credential, "pg.example"));
        let article = json!({"content":"unique-body-keyword","readme":"not-the-query","stars":12});
        assert!(!search_data(&article, "content"));
        assert!(!search_data(&article, "readme"));
        assert!(!search_data(&article, "stars"));
        assert!(search_data(&article, "unique-body-keyword"));
    }

    #[test]
    fn corrupt_credential_ciphertext_does_not_fail_search() {
        let key = zeroize::Zeroizing::new([7u8; 32]);
        assert!(!credential_matches(
            &key,
            "item-a",
            Some(&[1, 2, 3]),
            "anything"
        ));
        let sealed = crypto::encrypt(
            &key,
            br#"{"password":"hidden","host":"unique-host-value"}"#,
            "item-a",
        )
        .unwrap();
        assert!(!credential_matches(
            &key,
            "item-a",
            Some(&sealed),
            "password"
        ));
        assert!(credential_matches(
            &key,
            "item-a",
            Some(&sealed),
            "unique-host-value"
        ));
        assert!(!credential_matches(
            &key,
            "item-b",
            Some(&sealed),
            "unique-host-value"
        ));
    }

    #[test]
    fn inline_spec_skips_non_rest_protocols_and_does_not_invent_example_com() {
        let spec = r#"{"openapi":"3.0.3","info":{"title":"T"},"paths":{"/x":{"get":{}}}}"#;
        let mut postgres = ItemInput {
            kind: "credential".into(),
            title: "db".into(),
            category: "sql".into(),
            data: json!({"typeKey":"postgresql","fields":{"host":"db.example"},"importSpec":spec}),
            ..Default::default()
        };
        parse_inline_spec(&mut postgres).unwrap();
        assert_eq!(postgres.category, "sql");
        assert_eq!(postgres.data["typeKey"], "postgresql");
        assert!(postgres.data.get("swaggerEndpoints").is_none());
        assert!(postgres.data.get("importSpec").is_none());

        let mut inline = ItemInput {
            kind: "credential".into(),
            title: "api".into(),
            data: json!({"importSpec":spec}),
            ..Default::default()
        };
        parse_inline_spec(&mut inline).unwrap();
        assert_eq!(inline.category, "http");
        assert_eq!(inline.data["typeKey"], "rest_api");
        assert_eq!(inline.data["swaggerEndpoints"].as_array().unwrap().len(), 1);
        assert_eq!(inline.data["fields"]["baseUrl"].as_str().unwrap_or(""), "");
        assert!(!inline.data.to_string().contains("example.com"));

        let relative = r#"{"openapi":"3.0.3","info":{"title":"T"},"servers":[{"url":"/v1"}],"paths":{"/x":{"get":{}}}}"#;
        let mut relative_import = ItemInput {
            kind: "credential".into(),
            title: "api".into(),
            data: json!({"importSpec":relative}),
            ..Default::default()
        };
        parse_inline_spec(&mut relative_import).unwrap();
        assert_eq!(
            relative_import.data["fields"]["baseUrl"]
                .as_str()
                .unwrap_or(""),
            ""
        );
        assert!(!relative_import.data.to_string().contains("example.com"));
    }

    #[test]
    fn inline_spec_update_keeps_saved_parameter_values_for_matching_operations() {
        let spec = json!({
            "openapi":"3.0.3",
            "info":{"title":"Orders"},
            "paths":{"/echo/{id}":{"patch":{
                "parameters":[
                    {"in":"path","name":"id","required":true,"schema":{"type":"string"}},
                    {"in":"query","name":"channel","schema":{"type":"string"}},
                    {"in":"query","name":"tenant","schema":{"type":"string","example":"default-tenant"}}
                ]
            }}}
        });
        let mut input = ItemInput {
            kind: "credential".into(),
            title: "api".into(),
            category: "http".into(),
            data: json!({
                "typeKey":"rest_api",
                "fields":{"baseUrl":"https://api.example/v1"},
                "swaggerEndpoints":[{
                    "method":"PATCH",
                    "path":"/echo/{id}",
                    "summary":"old",
                    "tag":"自定义",
                    "baseUrl":"https://custom.example",
                    "customHeaders":[{"key":"X-Old","value":"keep","enabled":true,"desc":""}],
                    "queryParams":[{"key":"channel","value":"user-custom-value","enabled":true,"desc":""}],
                    "pathParams":[{"key":"id","value":"order-1001","enabled":true,"desc":""}],
                    "requestBody":"{\"kept\":true}"
                }],
                "importSpec": serde_json::to_string(&spec).unwrap()
            }),
            ..Default::default()
        };
        parse_inline_spec(&mut input).unwrap();
        let ep = &input.data["swaggerEndpoints"][0];
        assert_eq!(ep["pathParams"][0]["value"], "order-1001");
        assert_eq!(
            ep["queryParams"]
                .as_array()
                .unwrap()
                .iter()
                .find(|p| p["key"] == "channel")
                .unwrap()["value"],
            "user-custom-value"
        );
        assert_eq!(
            ep["queryParams"]
                .as_array()
                .unwrap()
                .iter()
                .find(|p| p["key"] == "tenant")
                .unwrap()["value"],
            "default-tenant"
        );
        assert_eq!(ep["baseUrl"], "https://custom.example");
        assert_eq!(ep["requestBody"], "{\"kept\":true}");
        assert!(ep["customHeaders"]
            .as_array()
            .unwrap()
            .iter()
            .any(|h| h["key"] == "X-Old" && h["value"] == "keep"));
    }

    #[test]
    fn merge_keeps_user_added_operations_absent_from_the_new_spec() {
        let mut current = json!([{
            "method":"GET",
            "path":"/from-spec",
            "summary":"n",
            "tag":"t",
            "customHeaders":[],
            "queryParams":[{"key":"q","value":"example","enabled":true,"desc":""}],
            "pathParams":[],
            "requestBody":""
        }]);
        let previous = json!([
            {
                "method":"GET",
                "path":"/from-spec",
                "summary":"old",
                "tag":"t",
                "customHeaders":[],
                "queryParams":[{"key":"q","value":"kept","enabled":true,"desc":""}],
                "pathParams":[],
                "requestBody":""
            },
            {
                "method":"POST",
                "path":"/custom",
                "summary":"hand-built",
                "tag":"自定义",
                "customHeaders":[{"key":"X-Custom","value":"1","enabled":true,"desc":""}],
                "queryParams":[],
                "pathParams":[],
                "requestBody":"{\"a\":1}"
            }
        ]);
        merge_saved_endpoints(&mut current, &previous, None);
        assert_eq!(current.as_array().unwrap().len(), 2);
        assert_eq!(current[0]["queryParams"][0]["value"], "kept");
        assert_eq!(current[1]["path"], "/custom");
        assert_eq!(current[1]["requestBody"], "{\"a\":1}");
    }

    #[test]
    fn kind_mismatch_is_not_reported_as_a_concurrent_edit() {
        let mismatch = update_conflict_message("knowledge", "credential");
        assert_ne!(mismatch.1, "条目已在其他窗口修改或删除，请重新加载后再保存");
        assert_eq!(
            update_conflict_message("knowledge", "knowledge").1,
            "条目已在其他窗口修改或删除，请重新加载后再保存"
        );
    }
}
pub async fn detail(
    State(state): State<AppState>,
    Extension(auth): Extension<Auth>,
    Path(id): Path<Uuid>,
) -> Result<Json<Item>> {
    let row =
        sqlx::query_as::<_, ItemRow>("SELECT * FROM items WHERE id=$1 AND deleted_at IS NULL")
            .bind(id)
            .fetch_one(&state.db)
            .await?;
    Ok(Json(row.public(auth.key.as_ref(), true)?))
}

pub(crate) async fn insert(
    tx: &mut Transaction<'_, Postgres>,
    id: Uuid,
    input: &mut ItemInput,
    auth: &Auth,
) -> Result<Item> {
    input.validate()?;
    let (data, secret) = seal(id, input, auth)?;
    let row = sqlx::query_as::<_,ItemRow>("INSERT INTO items (id,kind,title,category,project,tags,summary,url,data,secret,favorite) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *")
        .bind(id).bind(&input.kind).bind(&input.title).bind(&input.category).bind(&input.project).bind(&input.tags).bind(&input.summary).bind(&input.url).bind(data).bind(secret).bind(input.favorite).fetch_one(&mut **tx).await?;
    row.public(auth.key.as_ref(), true)
}
fn seal(id: Uuid, input: &ItemInput, auth: &Auth) -> Result<(Value, Option<Vec<u8>>)> {
    if input.kind == "credential" {
        let encoded = zeroize::Zeroizing::new(input.data.to_string());
        Ok((
            json!({}),
            Some(crypto::encrypt(
                auth.vault()?,
                encoded.as_bytes(),
                &id.to_string(),
            )?),
        ))
    } else {
        Ok((input.data.clone(), None))
    }
}
pub(crate) async fn save(
    tx: &mut Transaction<'_, Postgres>,
    id: Uuid,
    input: &mut ItemInput,
    auth: &Auth,
) -> Result<Item> {
    input.validate()?;
    let revision = input
        .revision
        .ok_or_else(|| AppError::bad("更新必须携带 revision，请重新加载条目"))?;
    let stored_kind: Option<String> =
        sqlx::query_scalar("SELECT kind FROM items WHERE id=$1 AND deleted_at IS NULL")
            .bind(id)
            .fetch_optional(&mut **tx)
            .await?;
    let Some(stored_kind) = stored_kind else {
        return Err(sqlx::Error::RowNotFound.into());
    };
    if stored_kind != input.kind {
        return Err(update_conflict_message(&stored_kind, &input.kind));
    }
    let (data, secret) = seal(id, input, auth)?;
    let row = sqlx::query_as::<_,ItemRow>("UPDATE items SET title=$2,category=$3,project=$4,tags=$5,summary=$6,url=$7,data=$8,secret=$9,favorite=$10,revision=revision+1,updated_at=now() WHERE id=$1 AND revision=$11 AND kind=$12 AND deleted_at IS NULL RETURNING *")
        .bind(id).bind(&input.title).bind(&input.category).bind(&input.project).bind(&input.tags).bind(&input.summary).bind(&input.url).bind(data).bind(secret).bind(input.favorite).bind(revision).bind(&input.kind).fetch_optional(&mut **tx).await?;
    row.ok_or_else(|| update_conflict_message(&stored_kind, &input.kind))?
        .public(auth.key.as_ref(), true)
}

pub(crate) fn update_conflict_message(stored_kind: &str, requested_kind: &str) -> AppError {
    if stored_kind != requested_kind {
        AppError::bad("不能更改已有资产的类型")
    } else {
        AppError(
            StatusCode::CONFLICT,
            "条目已在其他窗口修改或删除，请重新加载后再保存".into(),
        )
    }
}
pub async fn create(
    State(state): State<AppState>,
    Extension(auth): Extension<Auth>,
    Json(mut input): Json<ItemInput>,
) -> Result<(StatusCode, Json<Item>)> {
    parse_inline_spec(&mut input)?;
    let mut tx = state.db.begin().await?;
    let item = insert(&mut tx, Uuid::new_v4(), &mut input, &auth).await?;
    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(item)))
}
pub async fn update(
    State(state): State<AppState>,
    Extension(auth): Extension<Auth>,
    Path(id): Path<Uuid>,
    Json(mut input): Json<ItemInput>,
) -> Result<Json<Item>> {
    parse_inline_spec(&mut input)?;
    let mut tx = state.db.begin().await?;
    let item = save(&mut tx, id, &mut input, &auth).await?;
    tx.commit().await?;
    Ok(Json(item))
}
fn parse_inline_spec(input: &mut ItemInput) -> Result<()> {
    if input.kind == "credential" {
        if rest_credential(input) {
            if let Some(spec) = input.data["importSpec"]
                .as_str()
                .filter(|s| !s.trim().is_empty())
            {
                let doc: Value = serde_yaml::from_str(spec)
                    .map_err(|_| AppError::bad("OpenAPI JSON / YAML 语法错误"))?;
                let source = input.data["fields"]["swaggerUrl"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .or_else(|| {
                        input.data["fields"]["baseUrl"]
                            .as_str()
                            .filter(|s| !s.is_empty())
                    })
                    .unwrap_or("");
                let previous_endpoints = input.data.get("swaggerEndpoints").cloned();
                let previous_import = input
                    .data
                    .get("spec")
                    .and_then(|doc| ingestion::openapi(doc, source).ok());
                let parsed = ingestion::openapi(&doc, source)?;
                input.data["swaggerEndpoints"] = parsed.data["swaggerEndpoints"].clone();
                if let Some(old) = previous_endpoints.as_ref() {
                    merge_saved_endpoints(
                        &mut input.data["swaggerEndpoints"],
                        old,
                        previous_import
                            .as_ref()
                            .map(|item| &item.data["swaggerEndpoints"]),
                    );
                }
                input.data["spec"] = doc;
                if input.data.get("fields").is_none() {
                    input.data["fields"] = json!({});
                }
                let fields = input.data["fields"]
                    .as_object_mut()
                    .ok_or_else(|| AppError::bad("连接属性必须为文本键值对"))?;
                if fields
                    .get("baseUrl")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .is_empty()
                {
                    if let Some(base) = parsed.data["fields"]["baseUrl"].as_str() {
                        if !base.is_empty() {
                            fields.insert("baseUrl".into(), base.into());
                        }
                    }
                }
                input.category = "http".into();
                input.data["typeKey"] = "rest_api".into();
            }
        }
        input.data.as_object_mut().map(|v| v.remove("importSpec"));
    }
    Ok(())
}
pub async fn delete(
    State(state): State<AppState>,
    Extension(auth): Extension<Auth>,
    Path(id): Path<Uuid>,
) -> Result<StatusCode> {
    let kind: String = sqlx::query_scalar("SELECT kind FROM items WHERE id=$1")
        .bind(id)
        .fetch_one(&state.db)
        .await?;
    if kind == "credential" {
        auth.vault()?;
    }
    let mut tx = state.db.begin().await?;
    sqlx::query("SELECT set_config('infohub.change_reason','trash',true)")
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE items SET deleted_at=now(),updated_at=now(),revision=revision+1 WHERE id=$1 AND deleted_at IS NULL")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize, serde::Serialize)]
pub struct IngestInput {
    pub url: String,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub project: String,
    #[serde(default)]
    pub tags: Vec<String>,
}
pub(crate) async fn persist_images(
    tx: &mut Transaction<'_, Postgres>,
    item_id: Uuid,
    collected: &Collected,
) -> Result<()> {
    for image in &collected.images {
        sqlx::query("INSERT INTO media(id,item_id,source_url,mime,storage_key,sha256) VALUES ($1,$2,$3,$4,$5,$6)")
            .bind(image.id).bind(item_id).bind(&image.source).bind(&image.mime).bind(format!("media/{}", image.id)).bind(&image.hash).execute(&mut **tx).await?;
    }
    Ok(())
}
pub(crate) async fn stage_images(state: &AppState, collected: &Collected) -> Result<()> {
    for image in &collected.images {
        files::stage(
            &state.db,
            &state.storage,
            &format!("media/{}", image.id),
            image.bytes.clone(),
        )
        .await?;
    }
    Ok(())
}
pub async fn ingest(
    State(state): State<AppState>,
    Extension(auth): Extension<Auth>,
    Json(input): Json<IngestInput>,
) -> Result<(StatusCode, Json<Value>)> {
    let mut collected = ingestion::collect(&state, &input.url, &input.kind).await?;
    collected.input.project = input.project;
    collected.input.tags.extend(input.tags);
    collected.input.validate()?;
    stage_images(&state, &collected).await?;
    let mut tx = state.db.begin().await?;
    let id = Uuid::new_v4();
    let item = insert(&mut tx, id, &mut collected.input, &auth).await?;
    persist_images(&mut tx, id, &collected).await?;
    tx.commit().await?;
    ingest_linked_repos(&state, &auth, &item, &mut collected.warnings).await;
    Ok((
        StatusCode::CREATED,
        Json(json!({"item":item,"warnings":collected.warnings})),
    ))
}
pub async fn refresh(
    State(state): State<AppState>,
    Extension(auth): Extension<Auth>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    let previous =
        sqlx::query_as::<_, ItemRow>("SELECT * FROM items WHERE id=$1 AND deleted_at IS NULL")
            .bind(id)
            .fetch_one(&state.db)
            .await?
            .public(auth.key.as_ref(), true)?;
    let url = if previous.kind == "credential" {
        previous.data["fields"]["swaggerUrl"]
            .as_str()
            .unwrap_or_default()
    } else {
        &previous.url
    };
    if url.is_empty() {
        return Err(AppError::bad("请先在编辑属性中填写来源链接"));
    }
    let previous_import = previous
        .data
        .get("spec")
        .and_then(|doc| ingestion::openapi(doc, url).ok());
    let mut collected = ingestion::collect(&state, url, &previous.kind).await?;
    if collected.input.kind != previous.kind {
        return Err(AppError::bad("来源类型发生变化，请作为新条目收录"));
    }
    preserve_sync_data(&previous, &mut collected);
    collected.input.project = previous.project;
    collected.input.tags = previous.tags;
    collected.input.favorite = previous.favorite;
    collected.input.revision = Some(previous.revision);
    for field in [
        "cookbookNotes",
        "localWorkspacePath",
        "readerMode",
        "globalHeaders",
        "environments",
        "activeEnvironment",
    ] {
        if let Some(value) = previous.data.get(field) {
            collected.input.data[field] = value.clone();
        }
    }
    if let Some(endpoints) = collected.input.data.get_mut("swaggerEndpoints") {
        merge_saved_endpoints(
            endpoints,
            &previous.data["swaggerEndpoints"],
            previous_import
                .as_ref()
                .map(|item| &item.data["swaggerEndpoints"]),
        );
    }
    collected.input.validate()?;
    stage_images(&state, &collected).await?;
    let mut tx = state.db.begin().await?;
    sqlx::query("SELECT set_config('infohub.change_reason','sync',true)")
        .execute(&mut *tx)
        .await?;
    let item = save(&mut tx, id, &mut collected.input, &auth).await?;
    sqlx::query("DELETE FROM media WHERE item_id=$1")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    persist_images(&mut tx, id, &collected).await?;
    tx.commit().await?;
    state.file_cleanup.notify_one();
    ingest_linked_repos(&state, &auth, &item, &mut collected.warnings).await;
    Ok(Json(json!({"item":item,"warnings":collected.warnings})))
}

pub(crate) async fn ingest_linked_repos(
    state: &AppState,
    auth: &Auth,
    item: &Item,
    warnings: &mut Vec<String>,
) {
    if item.kind != "knowledge" {
        return;
    }
    let content = item.data["content"].as_str().unwrap_or_default();
    for url in ingestion::github_repo_urls(&format!("{}\n{content}", item.url)) {
        match persist_linked_repo(state, auth, item, &url).await {
            Ok(Some(title)) => warnings.push(format!("已同时收录 GitHub 项目 {title}")),
            Ok(None) => {}
            Err(error) => warnings.push(format!("文中 GitHub 项目 {url} 未能收录：{error}")),
        }
    }
}

async fn persist_linked_repo(
    state: &AppState,
    auth: &Auth,
    article: &Item,
    url: &str,
) -> Result<Option<String>> {
    let exists: Option<Uuid> = sqlx::query_scalar(
        "SELECT id FROM items WHERE kind='repo' AND url=$1 AND deleted_at IS NULL",
    )
    .bind(url)
    .fetch_optional(&state.db)
    .await?;
    if let Some(existing) = exists {
        sqlx::query("INSERT INTO item_relations(source_id,target_id,label) VALUES($1,$2,'文中引用') ON CONFLICT DO NOTHING").bind(article.id).bind(existing).execute(&state.db).await?;
        return Ok(None);
    }
    let mut collected = ingestion::collect(state, url, "repo").await?;
    collected.input.project = article.project.clone();
    collected.input.tags = article.tags.clone();
    collected.input.validate()?;
    let mut tx = state.db.begin().await?;
    let saved = match insert(&mut tx, Uuid::new_v4(), &mut collected.input, auth).await {
        Ok(item) => item,
        Err(error) if error.0 == StatusCode::CONFLICT => {
            let _ = tx.rollback().await;
            return Ok(None);
        }
        Err(error) => {
            let _ = tx.rollback().await;
            return Err(error);
        }
    };
    tx.commit().await?;
    sqlx::query("INSERT INTO item_relations(source_id,target_id,label) VALUES($1,$2,'文中引用') ON CONFLICT DO NOTHING").bind(article.id).bind(saved.id).execute(&state.db).await?;
    Ok(Some(saved.title))
}

fn preserve_sync_data(previous: &Item, collected: &mut Collected) {
    if previous.kind == "credential" {
        if let Some(fields) = previous.data["fields"].as_object() {
            for (key, value) in fields {
                // Keep user connection properties; the collector owns the resolved spec location.
                if key != "swaggerUrl"
                    && (key != "baseUrl" || value.as_str().is_some_and(|v| !v.is_empty()))
                {
                    collected.input.data["fields"][key] = value.clone();
                }
            }
        }
        for key in ["description", "sourceUrl"] {
            if let Some(value) = previous.data.get(key) {
                collected.input.data[key] = value.clone();
            }
        }
    }
    // An unavailable optional GitHub resource must not erase its last successful capture.
    if previous.kind == "repo" {
        for field in [
            "readme",
            "latestRelease",
            "releaseDate",
            "releaseUrl",
            "releaseNotes",
        ] {
            if collected.input.data.get(field).is_none() {
                if let Some(value) = previous.data.get(field) {
                    collected.input.data[field] = value.clone();
                }
            }
        }
    }
}

fn merge_saved_endpoints(current: &mut Value, previous: &Value, previous_import: Option<&Value>) {
    let Some(endpoints) = current.as_array_mut() else {
        return;
    };
    for endpoint in endpoints.iter_mut() {
        let Some(old) = previous.as_array().and_then(|list| {
            list.iter()
                .find(|p| p["method"] == endpoint["method"] && p["path"] == endpoint["path"])
        }) else {
            continue;
        };
        if let Some(address) = old.get("baseUrl") {
            let imported = previous_import
                .and_then(Value::as_array)
                .and_then(|list| {
                    list.iter()
                        .find(|p| p["method"] == old["method"] && p["path"] == old["path"])
                })
                .and_then(|endpoint| endpoint.get("baseUrl"));
            if imported != Some(address) {
                endpoint["baseUrl"] = address.clone();
            }
        }
        for field in ["customHeaders", "queryParams", "pathParams"] {
            if let Some(v) = old.get(field) {
                merge_parameters(&mut endpoint[field], v, field == "customHeaders");
            }
        }
        if let Some(v) = old.get("requestBody") {
            endpoint["requestBody"] = v.clone();
        }
    }
    if let Some(previous) = previous.as_array() {
        for old in previous {
            let exists = endpoints
                .iter()
                .any(|ep| ep["method"] == old["method"] && ep["path"] == old["path"]);
            if !exists {
                endpoints.push(old.clone());
            }
        }
    }
}

fn merge_parameters(current: &mut Value, previous: &Value, headers: bool) {
    let (Some(current), Some(previous)) = (current.as_array_mut(), previous.as_array()) else {
        return;
    };
    for old in previous {
        let matching = current.iter_mut().find(|new| {
            if headers {
                new["key"]
                    .as_str()
                    .unwrap_or_default()
                    .eq_ignore_ascii_case(old["key"].as_str().unwrap_or_default())
            } else {
                new["key"] == old["key"]
            }
        });
        if let Some(new) = matching {
            new["value"] = old["value"].clone();
            new["enabled"] = old["enabled"].clone();
        } else {
            current.push(old.clone());
        }
    }
}

pub(crate) async fn perform_probe(state: &AppState, input: ProbeInput) -> Result<Value> {
    if input
        .body
        .as_ref()
        .is_some_and(|b| b.len() > 2 * 1024 * 1024)
    {
        return Err(AppError::bad("请求正文最多 2 MB"));
    }
    if ![
        "GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "TRACE",
    ]
    .contains(&input.method.as_str())
    {
        return Err(AppError::bad("不支持该 HTTP 方法"));
    }
    let method =
        Method::from_bytes(input.method.as_bytes()).map_err(|_| AppError::bad("HTTP 方法无效"))?;
    let start = std::time::Instant::now();
    let response = state
        .network
        .fetch(
            &input.url,
            method,
            request_headers(&input.headers)?,
            if matches!(input.method.as_str(), "GET" | "HEAD") {
                None
            } else {
                input.body
            },
            false,
        )
        .await?;
    let text = std::str::from_utf8(&response.bytes)
        .ok()
        .filter(|text| !text.contains('\0'));
    Ok(json!({
        "status":response.status, "headers":response.headers,
        "body":text.unwrap_or_default(),
        "bodyBase64": if text.is_none() { Some(STANDARD.encode(&response.bytes)) } else { None },
        "durationMs":start.elapsed().as_millis(), "size":response.bytes.len()
    }))
}

async fn check_item(state: &AppState, auth: &Auth, id: Uuid) -> Result<String> {
    let kind: String =
        sqlx::query_scalar("SELECT kind FROM items WHERE id=$1 AND deleted_at IS NULL")
            .bind(id)
            .fetch_one(&state.db)
            .await?;
    if kind == "credential" {
        auth.vault()?;
    }
    Ok(kind)
}
pub async fn attachments(
    State(state): State<AppState>,
    Extension(auth): Extension<Auth>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    check_item(&state, &auth, id).await?;
    let rows: Vec<(Uuid, String, String, i64)> = sqlx::query_as(
        "SELECT id,name,mime,size FROM attachments WHERE item_id=$1 ORDER BY created_at DESC",
    )
    .bind(id)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(json!(rows
        .into_iter()
        .map(|(id, name, mime, size)| json!({"id":id,"name":name,"mime":mime,"size":size}))
        .collect::<Vec<_>>())))
}
pub async fn upload(
    State(state): State<AppState>,
    Extension(auth): Extension<Auth>,
    Path(item_id): Path<Uuid>,
    mut multipart: Multipart,
) -> Result<(StatusCode, Json<Value>)> {
    let kind = check_item(&state, &auth, item_id).await?;
    let field = multipart
        .next_field()
        .await
        .map_err(|_| AppError::bad("附件上传格式无效"))?
        .ok_or_else(|| AppError::bad("请选择文件"))?;
    let name = field
        .file_name()
        .unwrap_or("attachment")
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("attachment")
        .chars()
        .filter(|c| !c.is_control())
        .take(200)
        .collect::<String>();
    let mime = field
        .content_type()
        .unwrap_or("application/octet-stream")
        .to_string();
    let bytes = field
        .bytes()
        .await
        .map_err(|_| AppError::bad("无法读取附件，单个文件最多 10 MB"))?;
    if bytes.len() > 10 * 1024 * 1024 {
        return Err(AppError::bad("单个附件最多 10 MB"));
    }
    let id = Uuid::new_v4();
    let size = bytes.len() as i64;
    let encrypted = kind == "credential";
    let content = if encrypted {
        crypto::encrypt(auth.vault()?, &bytes, &format!("attachment:{id}"))?
    } else {
        bytes.to_vec()
    };
    let storage_key = format!("attachments/{id}");
    files::stage(&state.db, &state.storage, &storage_key, content).await?;
    sqlx::query("INSERT INTO attachments(id,item_id,name,mime,size,storage_key,encrypted) VALUES ($1,$2,$3,$4,$5,$6,$7)").bind(id).bind(item_id).bind(&name).bind(&mime).bind(size).bind(&storage_key).bind(encrypted).execute(&state.db).await?;
    Ok((
        StatusCode::CREATED,
        Json(json!({"id":id,"name":name,"mime":mime,"size":size})),
    ))
}
pub async fn download(
    State(state): State<AppState>,
    Extension(auth): Extension<Auth>,
    Path(id): Path<Uuid>,
) -> Result<Response> {
    let (name, storage_key, encrypted): (String, String, bool) =
        sqlx::query_as("SELECT name,storage_key,encrypted FROM attachments WHERE id=$1")
            .bind(id)
            .fetch_one(&state.db)
            .await?;
    if encrypted {
        auth.vault()?;
    }
    let content = files::read(&state.db, &state.storage, &storage_key).await?;
    let bytes = if encrypted {
        crypto::decrypt(auth.vault()?, &content, &format!("attachment:{id}"))?.to_vec()
    } else {
        content
    };
    let encoded: String = url::form_urlencoded::byte_serialize(name.as_bytes())
        .collect::<String>()
        .replace('+', "%20");
    let mut response = Response::new(Body::from(bytes));
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/octet-stream"),
    );
    response.headers_mut().insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_str(&format!(
            "attachment; filename=\"attachment\"; filename*=UTF-8''{encoded}"
        ))
        .map_err(|_| AppError::bad("文件名无效"))?,
    );
    Ok(response)
}
pub async fn delete_attachment(
    State(state): State<AppState>,
    Extension(auth): Extension<Auth>,
    Path(id): Path<Uuid>,
) -> Result<StatusCode> {
    let encrypted: bool = sqlx::query_scalar("SELECT encrypted FROM attachments WHERE id=$1")
        .bind(id)
        .fetch_one(&state.db)
        .await?;
    if encrypted {
        auth.vault()?;
    }
    sqlx::query("DELETE FROM attachments WHERE id=$1")
        .bind(id)
        .execute(&state.db)
        .await?;
    state.file_cleanup.notify_one();
    Ok(StatusCode::NO_CONTENT)
}
pub async fn media(State(state): State<AppState>, Path(id): Path<Uuid>) -> Result<Response> {
    let (mime, storage_key): (String, String) =
        sqlx::query_as("SELECT mime,storage_key FROM media WHERE id=$1 UNION ALL SELECT mime,storage_key FROM version_media WHERE media_id=$1 LIMIT 1")
            .bind(id)
            .fetch_one(&state.db)
            .await?;
    let content = files::read(&state.db, &state.storage, &storage_key).await?;
    let mut response = Response::new(Body::from(content));
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_str(&mime).map_err(|_| AppError::bad("图片类型无效"))?,
    );
    Ok(response)
}
