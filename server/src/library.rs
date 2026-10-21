use crate::{
    auth::Auth,
    crypto,
    error::{AppError, Result},
    model::{Item, ItemRow},
    routes, AppState,
};
use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    Extension, Json,
};
use futures_util::TryStreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{Postgres, QueryBuilder};
use uuid::Uuid;

#[derive(Default, Deserialize, Serialize)]
pub struct Filter {
    pub kind: Option<String>,
    pub q: Option<String>,
    pub category: Option<String>,
    pub project: Option<String>,
    pub favorite: Option<bool>,
    pub limit: Option<usize>,
    pub offset: Option<usize>,
    pub view: Option<String>,
    pub sort: Option<String>,
    pub tag: Option<String>,
}
fn filters<'a>(builder: &mut QueryBuilder<'a, Postgres>, filter: &'a Filter) {
    builder
        .push(" FROM items i LEFT JOIN item_state s ON s.item_id=i.id WHERE i.deleted_at IS NULL");
    for (column, value) in [
        ("kind", &filter.kind),
        ("category", &filter.category),
        ("project", &filter.project),
    ] {
        if let Some(value) = value {
            builder.push(format!(" AND i.{column}=")).push_bind(value);
        }
    }
    if let Some(value) = filter.favorite {
        builder.push(" AND i.favorite=").push_bind(value);
    }
    if let Some(tag) = &filter.tag {
        builder.push(" AND ").push_bind(tag).push("=ANY(i.tags)");
    }
    if filter.view.as_deref() == Some("archived") {
        builder.push(" AND COALESCE(s.archived,false)");
    } else {
        builder.push(" AND NOT COALESCE(s.archived,false)");
    }
    match filter.view.as_deref() {
        Some("later") => {
            builder.push(" AND COALESCE(s.later,false)");
        }
        Some("recent" | "frequent") => {
            builder.push(" AND s.last_opened_at IS NOT NULL");
        }
        _ => {}
    }
}
fn snippet(text: &str, query: &str) -> Option<String> {
    let lower = text.to_lowercase();
    let position = lower.find(query)?;
    let chars = lower[..position].chars().count();
    let start = chars.saturating_sub(40);
    let mut result = text.chars().skip(start).take(160).collect::<String>();
    if start > 0 {
        result.insert(0, '…');
    }
    if text.chars().count() > start + 160 {
        result.push('…');
    }
    Some(result)
}
fn data_snippet(data: &Value, query: &str) -> Option<String> {
    match data {
        Value::String(s) => snippet(s, query),
        Value::Array(v) => v.iter().find_map(|x| data_snippet(x, query)),
        Value::Object(v) => v.values().find_map(|x| data_snippet(x, query)),
        Value::Null => None,
        _ => snippet(&data.to_string(), query),
    }
}
#[derive(sqlx::FromRow)]
struct Candidate {
    #[sqlx(flatten)]
    item: ItemRow,
    annotation: String,
}
struct Hit {
    item: Item,
    score: i32,
    snippet: String,
}
fn compare(a: &Hit, b: &Hit) -> std::cmp::Ordering {
    b.score
        .cmp(&a.score)
        .then_with(|| b.item.updated_at.cmp(&a.item.updated_at))
        .then_with(|| a.item.id.cmp(&b.item.id))
}
fn score(row: &ItemRow, annotation: &str, q: &str, auth: &Auth) -> Option<(i32, String)> {
    let mut fields = vec![
        (&row.title, 80),
        (&row.project, 40),
        (&row.summary, 35),
        (&row.url, 20),
        (&row.category, 20),
    ];
    fields.extend(row.tags.iter().map(|t| (t, 50)));
    let best = fields
        .into_iter()
        .filter_map(|(s, weight)| {
            snippet(s, q).map(|text| {
                (
                    if s.to_lowercase() == q {
                        weight + 40
                    } else {
                        weight
                    },
                    text,
                )
            })
        })
        .max_by_key(|p| p.0);
    if best.is_some() {
        return best;
    }
    if let Some(s) = snippet(annotation, q) {
        return Some((25, s));
    }
    if row.kind == "credential" {
        if auth.key.as_ref().is_some_and(|key| {
            routes::credential_matches(key, &row.id.to_string(), row.secret.as_deref(), q)
        }) {
            return Some((10, "匹配加密连接内容，打开资产查看".into()));
        }
        None
    } else {
        data_snippet(&row.data, q).map(|s| (10, s))
    }
}
/// Characters indexed as CJK grams; must match `infohub_cjk_grams` in 0014_cjk_search.sql.
fn is_cjk(c: char) -> bool {
    matches!(c as u32, 0x3040..=0x30ff | 0x3400..=0x4dbf | 0x4e00..=0x9fff | 0xf900..=0xfaff | 0xac00..=0xd7af)
}
/// Grams a document must contain to match `term`: the character itself for a
/// single-character CJK run, otherwise every adjacent pair.
pub(crate) fn required_grams(term: &str) -> Vec<String> {
    let mut grams = Vec::new();
    let mut run: Vec<char> = Vec::new();
    let flush = |run: &mut Vec<char>, grams: &mut Vec<String>| {
        match run.len() {
            0 => {}
            1 => grams.push(run[0].to_string()),
            _ => grams.extend(run.windows(2).map(|w| w.iter().collect::<String>())),
        }
        run.clear();
    };
    for c in term.chars() {
        if is_cjk(c) {
            run.push(c);
        } else {
            flush(&mut run, &mut grams);
        }
    }
    flush(&mut run, &mut grams);
    grams.sort();
    grams.dedup();
    grams.truncate(64);
    grams
}
/// Splits a query into AND-ed terms; `"double quotes"` keep a phrase together.
pub(crate) fn terms(q: &str) -> Vec<String> {
    let mut out = Vec::new();
    for (i, part) in q.split('"').enumerate() {
        if i % 2 == 1 {
            let phrase = part.trim();
            if !phrase.is_empty() {
                out.push(phrase.to_string());
            }
        } else {
            out.extend(part.split_whitespace().map(str::to_string));
        }
    }
    out.dedup();
    out.truncate(8);
    out
}
/// Upper bound of rows scored per search request.
const SEARCH_CANDIDATES: usize = 2000;
/// SQL LIKE pattern for the PostgreSQL prefilter, or `None` when the query
/// cannot be matched safely against the JSON text (escaped characters) or
/// PostgreSQL's `lower()` might fold case differently from Rust.
fn like_pattern(q: &str) -> Option<String> {
    let unsafe_char = |c: char| {
        c == '"'
            || c == '\\'
            || c.is_control()
            || (!c.is_ascii() && c.to_uppercase().collect::<String>() != c.to_string())
    };
    if q.is_empty() || q.chars().any(unsafe_char) {
        return None;
    }
    let escaped = q
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_");
    Some(format!("%{escaped}%"))
}
pub async fn list(
    State(state): State<AppState>,
    Extension(auth): Extension<Auth>,
    Query(filter): Query<Filter>,
) -> Result<Json<Value>> {
    let q = filter
        .q
        .as_deref()
        .unwrap_or_default()
        .trim()
        .to_lowercase();
    if q.len() > 500 {
        return Err(AppError::bad("搜索词过长"));
    }
    let limit = filter.limit.unwrap_or(100).clamp(1, 200);
    let offset = filter.offset.unwrap_or(0).min(i64::MAX as usize);
    let sort = filter
        .sort
        .as_deref()
        .unwrap_or(if q.is_empty() { "updated" } else { "relevance" });
    let order = match sort {
        "updated" | "relevance" => "i.updated_at DESC,i.id",
        "created" => "i.created_at DESC,i.id",
        "title" => "i.title,i.id",
        "opened" => "s.last_opened_at DESC NULLS LAST,i.id",
        _ => return Err(AppError::bad("未知排序方式")),
    };
    let order = match filter.view.as_deref() {
        Some("recent") => "s.last_opened_at DESC,i.id",
        Some("frequent") => "s.visit_count DESC,s.last_opened_at DESC,i.id",
        _ => order,
    };
    let mut hits: Vec<Hit> = Vec::new();
    let total;
    if q.is_empty() {
        let mut count = QueryBuilder::new("SELECT count(*)");
        filters(&mut count, &filter);
        total = count
            .build_query_scalar::<i64>()
            .fetch_one(&state.db)
            .await? as usize;
        let mut select=QueryBuilder::new("SELECT i.id,i.kind,i.title,i.category,i.project,i.tags,i.summary,i.url,CASE WHEN i.kind='repo' THEN jsonb_build_object('stars',i.data->'stars') WHEN i.kind='knowledge' THEN jsonb_build_object('content',i.data->'content') ELSE '{}'::jsonb END AS data,NULL::bytea AS secret,i.favorite,i.revision,i.created_at,i.updated_at");
        filters(&mut select, &filter);
        select
            .push(format!(" ORDER BY {order} LIMIT "))
            .push_bind(limit as i64)
            .push(" OFFSET ")
            .push_bind(offset as i64);
        for row in select
            .build_query_as::<ItemRow>()
            .fetch_all(&state.db)
            .await?
        {
            let mut row = row;
            row.data = list_data(&row.kind, &row.data);
            hits.push(Hit {
                item: row.public(None, false)?,
                score: 0,
                snippet: String::new(),
            });
        }
    } else {
        let mut terms = terms(&q);
        if terms.is_empty() {
            terms.push(q.clone());
        }
        let mut select = QueryBuilder::new("SELECT i.*,COALESCE(s.annotation,'')||COALESCE((SELECT ' '||string_agg(h.quote||' '||h.note,' ') FROM highlights h WHERE h.item_id=i.id),'') AS annotation");
        filters(&mut select, &filter);
        for term in &terms {
            let Some(pattern) = like_pattern(term) else {
                continue;
            };
            let grams = required_grams(term);
            // Credentials keep their searchable fields encrypted, so they are
            // always candidates and matched after decryption in `score`.
            select
                .push(" AND (i.kind='credential' OR i.id IN (SELECT item_id FROM item_search WHERE text LIKE ")
                .push_bind(pattern.clone());
            if !grams.is_empty() {
                // Indexed CJK containment narrows 1–2 character terms that trigrams cannot.
                select
                    .push(" AND (grams @> ")
                    .push_bind(grams)
                    .push("::text[] OR grams @> '{*}'::text[])");
            }
            select
                .push(" UNION ALL SELECT item_id FROM item_state WHERE lower(annotation) LIKE ")
                .push_bind(pattern.clone())
                .push(
                    " UNION ALL SELECT item_id FROM highlights WHERE lower(quote||' '||note) LIKE ",
                )
                .push_bind(pattern)
                .push("))");
        }
        select.push(format!(" ORDER BY {order} LIMIT {SEARCH_CANDIDATES}"));
        // Unnamed statement: the LIKE pattern must be visible to the planner so the
        // trigram index is used (a cached generic plan would fall back to a scan).
        let query = select.build_query_as::<Candidate>().persistent(false);
        let mut rows = query.fetch(&state.db);
        let mut matches = 0;
        while let Some(Candidate {
            mut item,
            annotation,
        }) = rows.try_next().await?
        {
            // Every term must match; scores add up, the best-scoring snippet is shown.
            let mut total_score = 0;
            let mut best: Option<(i32, String)> = None;
            let mut all = true;
            for term in &terms {
                match score(&item, &annotation, term, &auth) {
                    Some((s, text)) => {
                        total_score += s;
                        if best.as_ref().is_none_or(|b| s > b.0) {
                            best = Some((s, text));
                        }
                    }
                    None => {
                        all = false;
                        break;
                    }
                }
            }
            let (true, Some((_, snippet))) = (all, best) else {
                continue;
            };
            let score = total_score;
            matches += 1;
            item.data = list_data(&item.kind, &item.data);
            let hit = Hit {
                item: item.public(None, false)?,
                score,
                snippet,
            };
            if sort == "relevance" {
                let index = hits
                    .binary_search_by(|existing| compare(existing, &hit))
                    .unwrap_or_else(|i| i);
                if index < offset.saturating_add(limit) {
                    hits.insert(index, hit);
                    if hits.len() > offset.saturating_add(limit) {
                        hits.pop();
                    }
                }
            } else if matches > offset && hits.len() < limit {
                hits.push(hit);
            }
        }
        total = matches;
        if sort == "relevance" {
            hits = hits.into_iter().skip(offset).collect();
        }
    }
    let ids: Vec<Uuid> = hits.iter().map(|h| h.item.id).collect();
    let states: Vec<(Uuid, Value)> = sqlx::query_as(
        "SELECT item_id,to_jsonb(s)-'annotation' FROM item_state s WHERE item_id=ANY($1)",
    )
    .bind(ids)
    .fetch_all(&state.db)
    .await?;
    let states: std::collections::HashMap<Uuid, Value> = states.into_iter().collect();
    let items: Vec<Value> = hits
        .into_iter()
        .map(|h| {
            let mut value = json!(h.item);
            value["matchSnippet"] = json!(h.snippet);
            value["matchScore"] = json!(h.score);
            value["state"] = states.get(&h.item.id).cloned().unwrap_or(json!({}));
            value
        })
        .collect();
    let dimensions:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('kind',i.kind,'category',i.category,'project',i.project,'count',count(*)) FROM items i LEFT JOIN item_state s ON s.item_id=i.id WHERE i.deleted_at IS NULL AND NOT COALESCE(s.archived,false) GROUP BY i.kind,i.category,i.project ORDER BY i.category,i.project").fetch_all(&state.db).await?;
    Ok(Json(
        json!({"items":items,"total":total,"dimensions":dimensions,"unlocked":auth.key.is_some()}),
    ))
}

#[derive(Deserialize)]
pub struct ViewInput {
    pub name: String,
    pub filters: Filter,
}
pub async fn save_view(
    State(state): State<AppState>,
    Extension(auth): Extension<Auth>,
    Json(input): Json<ViewInput>,
) -> Result<Json<Value>> {
    if input.name.trim().is_empty()
        || input.name.chars().count() > 200
        || input.filters.q.as_ref().is_some_and(|q| q.len() > 500)
    {
        return Err(AppError::bad("筛选名称或搜索词过长"));
    }
    let id = Uuid::new_v4();
    let plain = serde_json::to_vec(&input.filters).map_err(|_| AppError::bad("筛选条件无效"))?;
    if plain.len() > 16000 {
        return Err(AppError::bad("筛选条件过长"));
    }
    let sealed = crypto::encrypt(auth.vault()?, &plain, &format!("view:{id}"))?;
    sqlx::query("INSERT INTO saved_views(id,name,filters) VALUES($1,$2,$3)")
        .bind(id)
        .bind(input.name.trim())
        .bind(sealed)
        .execute(&state.db)
        .await?;
    Ok(Json(json!({"id":id})))
}
pub async fn views(
    State(state): State<AppState>,
    Extension(auth): Extension<Auth>,
) -> Result<Json<Value>> {
    let rows: Vec<(Uuid, String, Vec<u8>)> =
        sqlx::query_as("SELECT id,name,filters FROM saved_views ORDER BY created_at DESC")
            .fetch_all(&state.db)
            .await?;
    let mut views = Vec::new();
    for (id, name, filters) in rows {
        let value = if let Some(key) = &auth.key {
            let plain = crypto::decrypt(key, &filters, &format!("view:{id}"))?;
            serde_json::from_slice::<Value>(&plain).map_err(|_| AppError::bad("筛选条件损坏"))?
        } else {
            Value::Null
        };
        views.push(json!({"id":id,"name":name,"filters":value}));
    }
    Ok(Json(json!(views)))
}
pub async fn delete_view(
    State(state): State<AppState>,
    Extension(auth): Extension<Auth>,
    Path(id): Path<Uuid>,
) -> Result<StatusCode> {
    auth.vault()?;
    sqlx::query("DELETE FROM saved_views WHERE id=$1")
        .bind(id)
        .execute(&state.db)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}
pub async fn tags(State(state): State<AppState>) -> Result<Json<Value>> {
    let rows:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('name',tag,'count',count(*)) FROM items CROSS JOIN LATERAL unnest(tags) tag WHERE deleted_at IS NULL GROUP BY tag ORDER BY tag").fetch_all(&state.db).await?;
    Ok(Json(json!(rows)))
}
#[derive(Deserialize)]
pub struct MergeTags {
    pub from: Vec<String>,
    pub to: String,
}
pub async fn merge_tags(
    State(state): State<AppState>,
    Extension(auth): Extension<Auth>,
    Json(input): Json<MergeTags>,
) -> Result<StatusCode> {
    if input.from.is_empty()
        || input.from.len() > 50
        || input.to.trim().is_empty()
        || input.to.chars().count() > 100
    {
        return Err(AppError::bad("请选择标签并填写合并后的名称（最多 100 字）"));
    }
    let mut tx = state.db.begin().await?;
    let credential: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM items WHERE tags&&$1 AND kind='credential')",
    )
    .bind(&input.from)
    .fetch_one(&mut *tx)
    .await?;
    if credential {
        auth.vault()?;
    }
    sqlx::query("UPDATE items SET tags=ARRAY(SELECT DISTINCT t FROM unnest(array_append(ARRAY(SELECT t FROM unnest(tags) t WHERE NOT t=ANY($1)), $2)) t ORDER BY t),revision=revision+1,updated_at=now() WHERE tags&&$1").bind(input.from).bind(input.to.trim()).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    #[test]
    fn like_pattern_escapes_wildcards_and_skips_unsafe_queries() {
        assert_eq!(super::like_pattern("a_b%").as_deref(), Some("%a\\_b\\%%"));
        assert_eq!(super::like_pattern("中文").as_deref(), Some("%中文%"));
        assert!(super::like_pattern("say \"hi\"").is_none());
        assert!(super::like_pattern("c:\\x").is_none());
        assert!(super::like_pattern("é").is_none());
        assert!(super::like_pattern("").is_none());
    }
    use super::*;
    #[test]
    fn snippet_handles_unicode_case_expansion_and_late_matches() {
        assert!(snippet("İ中文资料 hello", "i").is_some());
        let text = format!("{}重要资料{}", "前".repeat(100), "后".repeat(200));
        let excerpt = snippet(&text, "重要").unwrap();
        assert!(excerpt.contains("重要资料"));
        assert!(excerpt.starts_with('…'));
        assert!(excerpt.ends_with('…'));
        assert_eq!(
            data_snippet(&json!({"nested":["D:\\work\n中文"]}), "\\work\n中").unwrap(),
            "D:\\work\n中文"
        );
    }
}

/// Reading speed: ~400 CJK characters or ~200 English words per minute
/// (mirrors `src/lib/readingTime.ts`).
pub fn reading_minutes(markdown: &str) -> u64 {
    use std::sync::LazyLock;
    static STRIP: LazyLock<regex::Regex> =
        LazyLock::new(|| regex::Regex::new(r"!\[[^\]]*\]\([^)]*\)|<[^>]+>").unwrap());
    static LINK: LazyLock<regex::Regex> =
        LazyLock::new(|| regex::Regex::new(r"\]\([^)]*\)").unwrap());
    static CJK: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(r"[\x{3400}-\x{4dbf}\x{4e00}-\x{9fff}\x{f900}-\x{faff}\x{3040}-\x{30ff}\x{ac00}-\x{d7af}]").unwrap()
    });
    static WORD: LazyLock<regex::Regex> =
        LazyLock::new(|| regex::Regex::new(r"[A-Za-z0-9][A-Za-z0-9'’_-]*").unwrap());
    let text = STRIP.replace_all(markdown, " ");
    let text = LINK.replace_all(&text, "]");
    let cjk = CJK.find_iter(&text).count() as f64;
    let words = WORD.find_iter(&CJK.replace_all(&text, " ")).count() as f64;
    let minutes = cjk / 400.0 + words / 200.0;
    if minutes == 0.0 {
        0
    } else {
        (minutes.round() as u64).max(1)
    }
}
/// The small `data` object list rows carry instead of full bodies.
fn list_data(kind: &str, data: &Value) -> Value {
    match kind {
        "repo" => json!({"stars":data["stars"]}),
        "knowledge" => {
            json!({"readingMinutes":reading_minutes(data["content"].as_str().unwrap_or_default())})
        }
        _ => json!({}),
    }
}
#[cfg(test)]
mod reading_tests {
    use super::reading_minutes;
    #[test]
    fn reading_time_mixes_scripts() {
        assert_eq!(reading_minutes(""), 0);
        assert_eq!(reading_minutes("短"), 1);
        assert_eq!(reading_minutes(&"字".repeat(800)), 2);
        assert_eq!(reading_minutes(&vec!["word"; 600].join(" ")), 3);
        assert_eq!(
            reading_minutes(&format!("![图](/api/media/abc-123) {}", "字".repeat(400))),
            1
        );
    }
}

#[derive(Deserialize)]
pub struct ExistingQuery {
    #[serde(default)]
    pub urls: Vec<String>,
}
fn host_of(url: &str) -> String {
    let candidate = if url.contains("://") {
        url.to_string()
    } else {
        format!("https://{url}")
    };
    url::Url::parse(&candidate)
        .ok()
        .and_then(|u| u.host_str().map(str::to_lowercase))
        .unwrap_or_default()
}
/// Dedupe keys for the import preview: which article URLs already exist, and
/// (when the vault is unlocked) `vault|title|host|username` / `api|title` keys
/// of existing credentials. Decryption stays on the server; only keys return.
pub async fn import_existing(
    State(state): State<AppState>,
    axum::Extension(auth): axum::Extension<Auth>,
    Json(input): Json<ExistingQuery>,
) -> Result<Json<Value>> {
    if input.urls.len() > 20000 {
        return Err(AppError::bad("一次最多检查 20000 个地址"));
    }
    let urls: Vec<String> = sqlx::query_scalar(
        "SELECT DISTINCT url FROM items WHERE kind='knowledge' AND deleted_at IS NULL AND url=ANY($1)",
    )
    .bind(&input.urls)
    .fetch_all(&state.db)
    .await?;
    let mut vault = Vec::new();
    if let Some(key) = auth.key.as_ref() {
        let rows: Vec<ItemRow> =
            sqlx::query_as("SELECT * FROM items WHERE kind='credential' AND deleted_at IS NULL")
                .fetch_all(&state.db)
                .await?;
        for row in rows {
            let title = row.title.to_lowercase();
            let Ok(item) = row.public(Some(key), true) else {
                continue;
            };
            if item.category == "http" {
                vault.push(format!("api|{title}"));
            }
            let fields = &item.data["fields"];
            let text = |k: &str| fields[k].as_str().unwrap_or_default().to_string();
            vault.push(format!(
                "vault|{title}|{}|{}",
                host_of(&text("url")),
                text("username").to_lowercase()
            ));
        }
    }
    Ok(Json(
        json!({"urls":urls,"vault":vault,"unlocked":auth.key.is_some()}),
    ))
}
#[cfg(test)]
mod cjk_tests {
    use super::*;
    #[test]
    fn grams_for_short_and_long_terms() {
        assert_eq!(required_grams("调"), vec!["调"]);
        assert_eq!(required_grams("调度"), vec!["调度"]);
        let mut g = required_grams("调度器");
        g.sort();
        assert_eq!(g, vec!["度器", "调度"]);
        assert_eq!(required_grams("tokio"), Vec::<String>::new());
        let mut mixed = required_grams("rust异步io运行时");
        mixed.sort();
        assert_eq!(mixed, vec!["异步", "行时", "运行"]);
        assert_eq!(required_grams("カタカナ").len(), 3);
        assert_eq!(required_grams("한국어").len(), 2);
    }
    #[test]
    fn query_terms() {
        assert_eq!(terms("调度  原理"), vec!["调度", "原理"]);
        assert_eq!(
            terms("\"work stealing\" 调度"),
            vec!["work stealing", "调度"]
        );
        assert_eq!(terms("a b c d e f g h i j").len(), 8);
        assert!(terms("\"\"").is_empty());
    }
}
