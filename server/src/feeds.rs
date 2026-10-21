//! RSS/Atom subscriptions. A periodic checker fetches each feed through the
//! SSRF-guarded network client and queues new entries as ordinary ingest jobs.
use crate::{
    error::{AppError, Result},
    ingest,
    routes::IngestInput,
    AppState,
};
use axum::{
    extract::{Path, State},
    http::{header, StatusCode},
    response::IntoResponse,
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::time::Duration;
use url::Url;
use uuid::Uuid;

const MAX_FEEDS: i64 = 500;
const MAX_NEW_PER_CHECK: usize = 20;
const KEEP_ENTRIES: i64 = 2000;
const ACTIVE_JOB_LIMIT: i64 = 100;

#[derive(Debug, PartialEq)]
pub struct Entry {
    pub key: String,
    pub link: String,
    pub title: String,
}
#[derive(Debug, PartialEq)]
pub struct Parsed {
    pub title: String,
    pub site_url: String,
    /// Newest first, as feeds conventionally list them.
    pub entries: Vec<Entry>,
}

fn child<'a>(node: roxmltree::Node<'a, 'a>, name: &str) -> Option<roxmltree::Node<'a, 'a>> {
    node.children()
        .find(|c| c.is_element() && c.tag_name().name() == name)
}
fn text(node: Option<roxmltree::Node>) -> String {
    let value: String = node
        .map(|n| {
            n.descendants()
                .filter(|d| d.is_text())
                .filter_map(|d| d.text())
                .collect()
        })
        .unwrap_or_default();
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}
fn resolve(base: &Url, href: &str) -> Option<String> {
    let url = base.join(href.trim()).ok()?;
    matches!(url.scheme(), "http" | "https").then(|| url.to_string())
}
fn atom_link(node: roxmltree::Node, base: &Url) -> Option<String> {
    node.children()
        .filter(|c| c.is_element() && c.tag_name().name() == "link")
        .find(|c| matches!(c.attribute("rel"), None | Some("alternate")))
        .and_then(|c| c.attribute("href"))
        .and_then(|href| resolve(base, href))
}

/// Parse RSS 2.0, RSS 1.0 (RDF) or Atom. Entries without an http(s) link are skipped.
pub fn parse(xml: &str, feed_url: &str) -> Result<Parsed> {
    let base = Url::parse(feed_url).map_err(|_| AppError::bad("订阅地址无效"))?;
    let options = roxmltree::ParsingOptions {
        allow_dtd: false,
        ..Default::default()
    };
    let document =
        roxmltree::Document::parse_with_options(xml.trim_start_matches('\u{feff}'), options)
            .map_err(|_| AppError::bad("该地址返回的不是有效的 RSS/Atom 订阅源"))?;
    let root = document.root_element();
    let (title, site_url, items): (String, String, Vec<roxmltree::Node>) =
        match root.tag_name().name() {
            "feed" => (
                text(child(root, "title")),
                atom_link(root, &base).unwrap_or_default(),
                root.children()
                    .filter(|c| c.is_element() && c.tag_name().name() == "entry")
                    .collect(),
            ),
            "rss" | "RDF" => {
                let channel =
                    child(root, "channel").ok_or_else(|| AppError::bad("RSS 缺少 channel"))?;
                let scope = if root.tag_name().name() == "rss" {
                    channel
                } else {
                    root
                };
                (
                    text(child(channel, "title")),
                    child(channel, "link")
                        .and_then(|n| resolve(&base, &text(Some(n))))
                        .unwrap_or_default(),
                    scope
                        .children()
                        .filter(|c| c.is_element() && c.tag_name().name() == "item")
                        .collect(),
                )
            }
            _ => return Err(AppError::bad("该地址返回的不是有效的 RSS/Atom 订阅源")),
        };
    let mut entries = Vec::new();
    for item in items {
        let link = if root.tag_name().name() == "feed" {
            atom_link(item, &base)
        } else {
            child(item, "link")
                .and_then(|n| resolve(&base, &text(Some(n))))
                .or_else(|| {
                    child(item, "guid")
                        .filter(|g| g.attribute("isPermaLink") != Some("false"))
                        .and_then(|g| resolve(&base, &text(Some(g))))
                        .filter(|_| {
                            child(item, "guid").is_some_and(|g| text(Some(g)).starts_with("http"))
                        })
                })
        };
        let Some(link) = link else { continue };
        let id = text(child(
            item,
            if root.tag_name().name() == "feed" {
                "id"
            } else {
                "guid"
            },
        ));
        let key: String = if id.is_empty() { link.clone() } else { id };
        entries.push(Entry {
            key: key.chars().take(1000).collect(),
            title: text(child(item, "title")).chars().take(500).collect(),
            link,
        });
    }
    Ok(Parsed {
        title: title.chars().take(300).collect(),
        site_url,
        entries,
    })
}

async fn fetch(state: &AppState, url: &str) -> Result<Parsed> {
    let response = state.network.get(url).await?;
    let body = String::from_utf8_lossy(&response.bytes);
    parse(&body, response.url.as_str())
}

/// Queue new entries (oldest first). Returns how many jobs were created.
async fn collect(state: &AppState, feed: Uuid, parsed: &Parsed, enqueue: usize) -> Result<usize> {
    let (project, tags): (String, Value) =
        sqlx::query_as("SELECT project,tags FROM feeds WHERE id=$1")
            .bind(feed)
            .fetch_one(&state.db)
            .await?;
    let tags: Vec<String> = serde_json::from_value(tags).unwrap_or_default();
    let mut tx = state.db.begin().await?;
    sqlx::query("LOCK TABLE ingest_jobs IN SHARE ROW EXCLUSIVE MODE")
        .execute(&mut *tx)
        .await?;
    let mut active: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM ingest_jobs WHERE status IN ('queued','waiting_unlock','running')",
    )
    .fetch_one(&mut *tx)
    .await?;
    let mut queued = 0;
    let fresh = parsed.entries.len().min(enqueue);
    for (index, entry) in parsed.entries.iter().enumerate().rev() {
        let wanted = index < fresh;
        if wanted && (queued >= MAX_NEW_PER_CHECK || active >= ACTIVE_JOB_LIMIT) {
            // Leave it unrecorded so the next check picks it up.
            continue;
        }
        let job = wanted.then(Uuid::new_v4);
        let inserted = sqlx::query(
            "INSERT INTO feed_entries(feed_id,entry_key,link,title,job_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
        )
        .bind(feed)
        .bind(&entry.key)
        .bind(&entry.link)
        .bind(&entry.title)
        .bind(job)
        .execute(&mut *tx)
        .await?;
        let (Some(job), 1) = (job, inserted.rows_affected()) else {
            continue;
        };
        let Ok(url) = ingest::canonical_source_url(&entry.link) else {
            continue;
        };
        let input = IngestInput {
            url,
            kind: "knowledge".into(),
            project: project.clone(),
            tags: tags.clone(),
        };
        let payload = serde_json::to_vec(&input).map_err(|_| AppError::bad("任务内容无法编码"))?;
        sqlx::query("INSERT INTO ingest_jobs(id,payload,encrypted) VALUES($1,$2,false)")
            .bind(job)
            .bind(payload)
            .execute(&mut *tx)
            .await?;
        queued += 1;
        active += 1;
    }
    sqlx::query("UPDATE feeds SET collected=collected+$2,primed=true WHERE id=$1")
        .bind(feed)
        .bind(queued as i32)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM feed_entries WHERE feed_id=$1 AND entry_key NOT IN (SELECT entry_key FROM feed_entries WHERE feed_id=$1 ORDER BY created_at DESC LIMIT $2)")
        .bind(feed)
        .bind(KEEP_ENTRIES)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    if queued > 0 {
        state.jobs_notify.notify_one();
    }
    Ok(queued)
}

const LIST: &str = "SELECT jsonb_build_object('id',id,'url',url,'title',title,'siteUrl',site_url,'project',project,'tags',tags,'enabled',enabled,'intervalMinutes',interval_minutes,'nextCheckAt',next_check_at,'lastCheckedAt',last_checked_at,'checking',checking,'lastError',last_error,'collected',collected,'createdAt',created_at) FROM feeds";

pub async fn list(State(state): State<AppState>) -> Result<Json<Value>> {
    let rows: Vec<Value> = sqlx::query_scalar(&format!("{LIST} ORDER BY created_at DESC"))
        .fetch_all(&state.db)
        .await?;
    Ok(Json(json!(rows)))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewFeed {
    pub url: String,
    #[serde(default)]
    pub project: String,
    #[serde(default)]
    pub tags: Vec<String>,
    pub interval_minutes: Option<i32>,
    /// Also collect this many of the newest existing entries (0–20).
    #[serde(default)]
    pub backfill: usize,
}
fn validate(project: &str, tags: &[String], interval: i32) -> Result<()> {
    if project.chars().count() > 500
        || tags.len() > 50
        || tags.iter().any(|t| t.chars().count() > 100)
    {
        return Err(AppError::bad("项目或标签超出限制"));
    }
    if !(15..=10080).contains(&interval) {
        return Err(AppError::bad("检查间隔为 15 分钟至 7 天"));
    }
    Ok(())
}
async fn insert(
    state: &AppState,
    url: &str,
    title: &str,
    site: &str,
    project: &str,
    tags: &[String],
    interval: i32,
) -> Result<Option<Uuid>> {
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM feeds")
        .fetch_one(&state.db)
        .await?;
    if count >= MAX_FEEDS {
        return Err(AppError::bad("订阅源已达 500 个上限"));
    }
    let id = Uuid::new_v4();
    let inserted = sqlx::query("INSERT INTO feeds(id,url,title,site_url,project,tags,interval_minutes) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(url) DO NOTHING")
        .bind(id)
        .bind(url)
        .bind(title)
        .bind(site)
        .bind(project.trim())
        .bind(json!(tags))
        .bind(interval)
        .execute(&state.db)
        .await?;
    Ok((inserted.rows_affected() == 1).then_some(id))
}
pub async fn add(
    State(state): State<AppState>,
    Json(input): Json<NewFeed>,
) -> Result<(StatusCode, Json<Value>)> {
    let url = crate::net::parse_url(input.url.trim())?.to_string();
    let interval = input.interval_minutes.unwrap_or(60);
    validate(&input.project, &input.tags, interval)?;
    if url.len() > 2000 {
        return Err(AppError::bad("订阅地址过长"));
    }
    let parsed = fetch(&state, &url).await?;
    let Some(id) = insert(
        &state,
        &url,
        &parsed.title,
        &parsed.site_url,
        &input.project,
        &input.tags,
        interval,
    )
    .await?
    else {
        return Err(AppError(StatusCode::CONFLICT, "已订阅该地址".into()));
    };
    let queued = collect(&state, id, &parsed, input.backfill.min(MAX_NEW_PER_CHECK)).await?;
    sqlx::query("UPDATE feeds SET last_checked_at=now(),next_check_at=now()+make_interval(mins=>interval_minutes) WHERE id=$1")
        .bind(id)
        .execute(&state.db)
        .await?;
    state.feeds_notify.notify_one();
    let feed: Value = sqlx::query_scalar(&format!("{LIST} WHERE id=$1"))
        .bind(id)
        .fetch_one(&state.db)
        .await?;
    Ok((
        StatusCode::CREATED,
        Json(json!({"feed":feed,"entries":parsed.entries.len(),"queued":queued})),
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedSettings {
    pub enabled: bool,
    pub interval_minutes: i32,
    #[serde(default)]
    pub project: String,
    #[serde(default)]
    pub tags: Vec<String>,
}
pub async fn update(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Json(input): Json<FeedSettings>,
) -> Result<StatusCode> {
    validate(&input.project, &input.tags, input.interval_minutes)?;
    let changed = sqlx::query("UPDATE feeds SET enabled=$2,interval_minutes=$3,project=$4,tags=$5,next_check_at=CASE WHEN $2 AND NOT enabled THEN now() ELSE next_check_at END WHERE id=$1")
        .bind(id)
        .bind(input.enabled)
        .bind(input.interval_minutes)
        .bind(input.project.trim())
        .bind(json!(input.tags))
        .execute(&state.db)
        .await?;
    if changed.rows_affected() == 0 {
        return Err(AppError(StatusCode::NOT_FOUND, "订阅源不存在".into()));
    }
    state.feeds_notify.notify_one();
    Ok(StatusCode::NO_CONTENT)
}
pub async fn remove(State(state): State<AppState>, Path(id): Path<Uuid>) -> Result<StatusCode> {
    let removed = sqlx::query("DELETE FROM feeds WHERE id=$1")
        .bind(id)
        .execute(&state.db)
        .await?;
    if removed.rows_affected() == 0 {
        return Err(AppError(StatusCode::NOT_FOUND, "订阅源不存在".into()));
    }
    Ok(StatusCode::NO_CONTENT)
}
pub async fn request_check(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<StatusCode> {
    let changed = sqlx::query("UPDATE feeds SET next_check_at=now() WHERE id=$1 AND enabled")
        .bind(id)
        .execute(&state.db)
        .await?;
    if changed.rows_affected() == 0 {
        return Err(AppError::bad("请先启用该订阅源"));
    }
    state.feeds_notify.notify_one();
    Ok(StatusCode::ACCEPTED)
}

fn escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}
pub async fn export_opml(State(state): State<AppState>) -> Result<impl IntoResponse> {
    let rows: Vec<(String, String, String)> =
        sqlx::query_as("SELECT url,title,site_url FROM feeds ORDER BY created_at")
            .fetch_all(&state.db)
            .await?;
    let mut body = String::from("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<opml version=\"2.0\">\n  <head><title>InfoHub 订阅</title></head>\n  <body>\n");
    for (url, title, site) in rows {
        let title = escape(if title.is_empty() { &url } else { &title });
        body += &format!(
            "    <outline type=\"rss\" text=\"{title}\" title=\"{title}\" xmlUrl=\"{}\"{} />\n",
            escape(&url),
            if site.is_empty() {
                String::new()
            } else {
                format!(" htmlUrl=\"{}\"", escape(&site))
            }
        );
    }
    body += "  </body>\n</opml>\n";
    Ok((
        [
            (header::CONTENT_TYPE, "text/x-opml; charset=utf-8"),
            (
                header::CONTENT_DISPOSITION,
                "attachment; filename=\"infohub-feeds.opml\"",
            ),
        ],
        body,
    ))
}
/// Feed URLs listed in an OPML document.
pub fn parse_opml(xml: &str) -> Result<Vec<(String, String)>> {
    let options = roxmltree::ParsingOptions {
        allow_dtd: false,
        ..Default::default()
    };
    let document =
        roxmltree::Document::parse_with_options(xml.trim_start_matches('\u{feff}'), options)
            .map_err(|_| AppError::bad("不是有效的 OPML 文件"))?;
    if document.root_element().tag_name().name() != "opml" {
        return Err(AppError::bad("不是有效的 OPML 文件"));
    }
    Ok(document
        .descendants()
        .filter(|n| n.tag_name().name() == "outline")
        .filter_map(|n| {
            let url = n.attribute("xmlUrl")?.trim().to_string();
            let title = n
                .attribute("title")
                .or(n.attribute("text"))
                .unwrap_or("")
                .trim();
            Some((url, title.chars().take(300).collect()))
        })
        .collect())
}
pub async fn import_opml(State(state): State<AppState>, body: String) -> Result<Json<Value>> {
    if body.len() > 1024 * 1024 {
        return Err(AppError::bad("OPML 文件超过 1 MB"));
    }
    let (mut added, mut skipped, mut invalid) = (0, 0, 0);
    for (url, title) in parse_opml(&body)? {
        let Ok(url) = crate::net::parse_url(&url).map(|u| u.to_string()) else {
            invalid += 1;
            continue;
        };
        if url.len() > 2000 {
            invalid += 1;
            continue;
        }
        // Imported feeds are primed on their first check: existing entries are not collected.
        match insert(&state, &url, &title, "", "", &[], 60).await? {
            Some(_) => added += 1,
            None => skipped += 1,
        }
    }
    state.feeds_notify.notify_one();
    Ok(Json(
        json!({"added":added,"skipped":skipped,"invalid":invalid}),
    ))
}

pub async fn initialize(state: &AppState) -> Result<()> {
    sqlx::query("UPDATE feeds SET checking=false,next_check_at=now() WHERE checking")
        .execute(&state.db)
        .await?;
    Ok(())
}
pub async fn worker(state: AppState) {
    loop {
        tokio::select! {_=state.feeds_notify.notified()=>{},_=tokio::time::sleep(Duration::from_secs(60))=>{}}
        loop {
            let _guard = state.maintenance.read().await;
            match next(&state).await {
                Ok(true) => {}
                Ok(false) => break,
                Err(error) => {
                    tracing::warn!(status=%error.0, "feed check encountered a storage error");
                    let _ = initialize(&state).await;
                    break;
                }
            }
        }
    }
}
async fn next(state: &AppState) -> Result<bool> {
    let mut tx = state.db.begin().await?;
    let row: Option<(Uuid, String, bool)> = sqlx::query_as("SELECT id,url,primed FROM feeds WHERE enabled AND NOT checking AND next_check_at<=now() ORDER BY next_check_at FOR UPDATE SKIP LOCKED LIMIT 1")
        .fetch_optional(&mut *tx)
        .await?;
    let Some((id, url, primed)) = row else {
        return Ok(false);
    };
    sqlx::query("UPDATE feeds SET checking=true,next_check_at=now()+make_interval(mins=>interval_minutes) WHERE id=$1")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    let error = match fetch(state, &url).await {
        Ok(parsed) => {
            let enqueue = if primed { usize::MAX } else { 0 };
            match collect(state, id, &parsed, enqueue).await {
                Ok(_) => {
                    if !parsed.title.is_empty() {
                        sqlx::query("UPDATE feeds SET title=$2 WHERE id=$1 AND title=''")
                            .bind(id)
                            .bind(&parsed.title)
                            .execute(&state.db)
                            .await?;
                    }
                    String::new()
                }
                Err(error) if error.0.is_server_error() => return Err(error),
                Err(error) => error.1,
            }
        }
        Err(error) => error.1,
    };
    sqlx::query("UPDATE feeds SET checking=false,last_checked_at=now(),last_error=$2 WHERE id=$1")
        .bind(id)
        .bind(error)
        .execute(&state.db)
        .await?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_rss() {
        let xml = r#"<?xml version="1.0"?><rss version="2.0"><channel><title> 示例 博客 </title><link>https://blog.example.com/</link>
            <item><title>新文章</title><link>/posts/2</link><guid isPermaLink="false">post-2</guid></item>
            <item><title>旧文章</title><guid>https://blog.example.com/posts/1</guid></item>
            <item><title>no link</title><link>javascript:alert(1)</link></item>
            </channel></rss>"#;
        let parsed = parse(xml, "https://blog.example.com/feed.xml").unwrap();
        assert_eq!(parsed.title, "示例 博客");
        assert_eq!(parsed.site_url, "https://blog.example.com/");
        assert_eq!(parsed.entries.len(), 2);
        assert_eq!(parsed.entries[0].link, "https://blog.example.com/posts/2");
        assert_eq!(parsed.entries[0].key, "post-2");
        assert_eq!(parsed.entries[1].link, "https://blog.example.com/posts/1");
    }
    #[test]
    fn parses_atom_and_rdf() {
        let atom = r#"<feed xmlns="http://www.w3.org/2005/Atom"><title>Atom</title><link rel="self" href="/atom.xml"/><link href="https://a.example/"/>
            <entry><id>tag:a,1</id><title type="html">Hi</title><link rel="alternate" href="https://a.example/1"/></entry></feed>"#;
        let parsed = parse(atom, "https://a.example/atom.xml").unwrap();
        assert_eq!(parsed.site_url, "https://a.example/");
        assert_eq!(
            parsed.entries,
            vec![Entry {
                key: "tag:a,1".into(),
                link: "https://a.example/1".into(),
                title: "Hi".into()
            }]
        );
        let rdf = r#"<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/"><channel><title>R</title><link>https://r.example/</link></channel><item><title>x</title><link>https://r.example/x</link></item></rdf:RDF>"#;
        assert_eq!(
            parse(rdf, "https://r.example/rss").unwrap().entries[0].key,
            "https://r.example/x"
        );
    }
    #[test]
    fn rejects_non_feeds_and_entities() {
        assert!(parse("<html><body/></html>", "https://x.example/").is_err());
        assert!(parse("not xml", "https://x.example/").is_err());
        let bomb =
            r#"<!DOCTYPE r [<!ENTITY a "aaaa">]><rss><channel><title>&a;</title></channel></rss>"#;
        assert!(parse(bomb, "https://x.example/").is_err());
    }
    #[test]
    fn opml_roundtrip_fields() {
        let opml = r#"<opml version="2.0"><body><outline text="Tech"><outline type="rss" text="A &amp; B" xmlUrl="https://a.example/feed"/></outline><outline text="no url"/></body></opml>"#;
        assert_eq!(
            parse_opml(opml).unwrap(),
            vec![("https://a.example/feed".to_string(), "A & B".to_string())]
        );
        assert_eq!(escape("a&<\""), "a&amp;&lt;&quot;");
    }
}
