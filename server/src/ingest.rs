use crate::{
    error::{AppError, Result},
    model::ItemInput,
    net::parse_url,
    AppState,
};
use reqwest::{
    header::{HeaderMap, HeaderValue, ACCEPT, AUTHORIZATION},
    Method,
};
use scraper::{Html, Selector};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use uuid::Uuid;

pub struct Image {
    pub id: Uuid,
    pub source: String,
    pub mime: String,
    pub bytes: Vec<u8>,
    pub hash: String,
}
pub struct Collected {
    pub input: ItemInput,
    pub images: Vec<Image>,
    pub warnings: Vec<String>,
}

pub async fn collect(state: &AppState, url: &str, kind: &str) -> Result<Collected> {
    if !["", "knowledge", "repo", "credential"].contains(&kind) {
        return Err(AppError::bad("未知收录类型"));
    }
    let url = canonical_source_url(url)?;
    let parsed = parse_url(&url)?;
    if (kind.is_empty() && is_github_host(parsed.host_str())) || kind == "repo" {
        return github(state, &url).await;
    }
    let fetched = state.network.get(&url).await?;
    let text = String::from_utf8(fetched.bytes).map_err(|_| {
        AppError::bad("页面不是 UTF-8 文本，请使用 UTF-8 导出文件或 Markdown 手动收录")
    })?;
    let document: Option<Value> = serde_json::from_str(&text)
        .ok()
        .or_else(|| serde_yaml::from_str(&text).ok());
    if kind != "knowledge"
        && document
            .as_ref()
            .is_some_and(|v| v.get("openapi").is_some() || v.get("swagger").is_some())
    {
        return Ok(Collected {
            input: openapi(document.as_ref().unwrap(), fetched.url.as_str())?,
            images: vec![],
            warnings: vec![],
        });
    }
    if scrape_blocked(fetched.url.as_str(), "", &text) {
        return Err(blocked_scrape_error());
    }
    if kind == "credential" || (kind.is_empty() && looks_like_swagger_ui(&text)) {
        if let Some(collected) =
            discover_swagger(state, &fetched.url, &text, swagger_discovery_required(kind)).await?
        {
            return Ok(collected);
        }
        if swagger_discovery_required(kind) {
            return Err(AppError::bad(
                "未找到 OpenAPI 定义，请直接填写 JSON / YAML 规范地址，或在新建资产中粘贴规范",
            ));
        }
    }
    article(state, fetched.url.as_str(), &text).await
}

pub(crate) fn canonical_source_url(url: &str) -> Result<String> {
    let mut parsed = parse_url(url)?;
    if parsed
        .host_str()
        .is_some_and(|h| h.eq_ignore_ascii_case("mp.weixin.qq.com"))
    {
        parsed.set_query(None);
        parsed.set_fragment(None);
    }
    Ok(parsed.to_string())
}

pub(crate) fn scrape_blocked(url: &str, title: &str, html: &str) -> bool {
    let lower_url = url.to_ascii_lowercase();
    title.contains("环境异常")
        || title.contains("安全验证")
        || title.contains("Just a moment")
        || title.contains("Access Denied")
        || title.contains("验证码")
        || title.trim() == "未知错误"
        || lower_url.contains("appmsgcaptcha")
        || lower_url.contains("wappoc")
        || html.contains("失效的验证页面")
        || html.contains("你暂无权限查看此页面内容")
}

fn blocked_scrape_error() -> AppError {
    AppError::bad("目标站点要求登录或人机验证，无法直接采集。可将正文粘贴为 Markdown 收录")
}

pub(crate) fn is_github_host(host: Option<&str>) -> bool {
    host.is_some_and(|h| {
        let h = h.trim_end_matches('.');
        h.eq_ignore_ascii_case("github.com") || h.eq_ignore_ascii_case("www.github.com")
    })
}

pub(crate) fn looks_like_swagger_ui(text: &str) -> bool {
    text.contains("SwaggerUIBundle") || text.contains("swagger-ui")
}

pub(crate) fn swagger_discovery_required(kind: &str) -> bool {
    kind == "credential"
}

pub(crate) fn swagger_spec_candidates(page: &url::Url, html: &str, include_well_known: bool) -> Vec<String> {
    let pattern = regex::Regex::new(r#"(?:url|configUrl)\s*:\s*["']([^"']+)["']"#).unwrap();
    let mut ranked = Vec::new();
    let mut push = |candidate: url::Url| {
        if !["http", "https"].contains(&candidate.scheme()) || candidate.host_str().is_none() {
            return;
        }
        let host = candidate.host_str().unwrap_or_default();
        if host.eq_ignore_ascii_case("petstore.swagger.io") {
            return;
        }
        let path = candidate.path().to_ascii_lowercase();
        let spec_like = path.contains("openapi")
            || path.contains("swagger")
            || path.contains("api-docs")
            || path.ends_with(".json")
            || path.ends_with(".yaml")
            || path.ends_with(".yml");
        let same_origin = candidate.origin() == page.origin();
        let score = if same_origin && spec_like {
            0u8
        } else if same_origin {
            1
        } else if spec_like {
            2
        } else {
            3
        };
        ranked.push((score, candidate.to_string()));
    };
    for cap in pattern.captures_iter(html) {
        if let Ok(candidate) = page.join(&cap[1]) {
            push(candidate);
        }
    }
    if include_well_known {
        for path in ["/v3/api-docs", "/openapi.json", "/swagger.json"] {
            if let Ok(candidate) = page.join(path) {
                push(candidate);
            }
        }
    }
    ranked.sort_by_key(|(score, _)| *score);
    let mut seen = std::collections::HashSet::new();
    ranked
        .into_iter()
        .filter_map(|(_, url)| seen.insert(url.clone()).then_some(url))
        .collect()
}

async fn discover_swagger(
    state: &AppState,
    page: &url::Url,
    html: &str,
    include_well_known: bool,
) -> Result<Option<Collected>> {
    for candidate in swagger_spec_candidates(page, html, include_well_known)
        .into_iter()
        .take(8)
    {
        if let Ok(f) = state.network.get(&candidate).await {
            if let Ok(doc) = serde_yaml::from_slice::<Value>(&f.bytes) {
                if doc.get("openapi").is_some() || doc.get("swagger").is_some() {
                    return Ok(Some(Collected {
                        input: openapi(&doc, f.url.as_str())?,
                        images: vec![],
                        warnings: vec![],
                    }));
                }
                if let Some(spec_url) = doc["url"].as_str().and_then(|u| f.url.join(u).ok()) {
                    if let Ok(spec) = state.network.get(spec_url.as_str()).await {
                        if let Ok(doc) = serde_yaml::from_slice::<Value>(&spec.bytes) {
                            if let Ok(input) = openapi(&doc, spec.url.as_str()) {
                                return Ok(Some(Collected {
                                    input,
                                    images: vec![],
                                    warnings: vec![],
                                }));
                            }
                        }
                    }
                }
            }
        }
    }
    Ok(None)
}

fn selector(s: &str) -> Selector {
    Selector::parse(s).expect("static CSS selector")
}
fn meta(doc: &Html, query: &str) -> String {
    doc.select(&selector(query))
        .next()
        .and_then(|n| n.value().attr("content"))
        .unwrap_or_default()
        .trim()
        .to_string()
}
async fn article(state: &AppState, url: &str, text: &str) -> Result<Collected> {
    // Keep non-Send scraper nodes out of the async image downloading phase.
    let (title, author, summary, source, content, image_sources) = {
        let clean = regex::Regex::new(r"(?is)<(script|style|noscript|nav|footer)[\s>].*?</(?:script|style|noscript|nav|footer)\s*>").unwrap().replace_all(text, "");
        let doc = Html::parse_document(&clean);
        let title = [
            meta(&doc, "meta[property='og:title']"),
            doc.select(&selector("h1, title"))
                .next()
                .map(|e| e.text().collect::<String>())
                .unwrap_or_default(),
        ]
        .into_iter()
        .find(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "未命名文章".into());
        if scrape_blocked(url, &title, text) {
            return Err(blocked_scrape_error());
        }
        let content = [
            "#js_content",
            "article",
            "[itemprop='articleBody']",
            ".article-content",
            ".markdown-body",
            "main",
            "body",
        ]
        .iter()
        .find_map(|s| {
            doc.select(&selector(s))
                .max_by_key(|e| e.text().collect::<String>().len())
                .filter(|e| e.text().collect::<String>().trim().len() > 40)
        })
        .ok_or_else(|| AppError::bad("未识别到文章正文，可手动粘贴 Markdown 收录"))?;
        let images: Vec<(String, String)> = content
            .select(&selector("img"))
            .filter_map(|img| {
                let src = img
                    .value()
                    .attr("data-src")
                    .or_else(|| img.value().attr("data-original"))
                    .or_else(|| img.value().attr("src"))?;
                Some((img.html(), src.to_string()))
            })
            .collect();
        (
            title.trim().chars().take(500).collect::<String>(),
            meta(&doc, "meta[name='author']"),
            meta(&doc, "meta[name='description']"),
            meta(&doc, "meta[property='og:site_name']"),
            content.inner_html(),
            images,
        )
    };
    let base = parse_url(url)?;
    let mut html = content;
    let mut images = vec![];
    let mut warnings = vec![];
    let mut cached = HashMap::<String, String>::new();
    for (index, (tag, src)) in image_sources.iter().enumerate() {
        let resolved = base
            .join(src)
            .ok()
            .filter(|u| ["http", "https"].contains(&u.scheme()));
        if index >= 30 {
            html = html.replace(tag, "<p>[图片数量超过单次 30 张限制]</p>");
            continue;
        }
        if let Some(resolved) = resolved {
            if let Some(path) = cached.get(resolved.as_str()) {
                html = html.replace(tag, &format!("<img src=\"{path}\" alt=\"文章插图\">"));
                continue;
            }
            match state.network.get(resolved.as_str()).await {
                Ok(f) if is_image(&f.bytes).is_some() => {
                    let id = Uuid::new_v4();
                    let path = format!("/api/media/{id}");
                    html = html.replace(tag, &format!("<img src=\"{path}\" alt=\"文章插图\">"));
                    cached.insert(resolved.to_string(), path);
                    images.push(Image {
                        id,
                        source: resolved.to_string(),
                        mime: is_image(&f.bytes).unwrap().into(),
                        hash: hex::encode(Sha256::digest(&f.bytes)),
                        bytes: f.bytes,
                    });
                }
                _ => {
                    warnings.push(format!("第 {} 张图片未能保存", index + 1));
                    html = html.replace(tag, "<p>[图片未能离线保存，请查看原文]</p>");
                }
            }
        } else {
            html = html.replace(tag, "");
        }
    }
    if image_sources.len() > 30 {
        warnings.push("仅下载前 30 张图片".into());
    }
    let markdown = html2md::parse_html(&html);
    let host = base.host_str().unwrap_or_default();
    let category = if host == "mp.weixin.qq.com" {
        "wechat"
    } else if ["v2ex.com", "juejin.cn", "zhihu.com", "stackoverflow.com"]
        .iter()
        .any(|d| host == *d || host.ends_with(&format!(".{d}")))
    {
        "forum"
    } else {
        "blog"
    };
    let summary = if summary.is_empty() {
        markdown.chars().take(180).collect()
    } else {
        summary.chars().take(1000).collect()
    };
    Ok(Collected {
        input: ItemInput {
            kind: "knowledge".into(),
            title,
            url: url.into(),
            category: category.into(),
            summary,
            data: json!({"content": markdown, "author": author, "sourceName": if source.is_empty() {host} else {&source}, "imagesCount": images.len(), "readerMode":"flow"}),
            ..Default::default()
        },
        images,
        warnings,
    })
}

pub fn is_image(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        Some("image/webp")
    } else {
        None
    }
}

async fn github(state: &AppState, url: &str) -> Result<Collected> {
    let parsed = parse_url(url)?;
    if !is_github_host(parsed.host_str()) {
        return Err(AppError::bad("请填写 https://github.com/所有者/仓库 地址"));
    }
    let parts: Vec<_> = parsed.path().trim_matches('/').split('/').collect();
    if parts.len() < 2
        || parts[..2].iter().any(|s| {
            s.is_empty()
                || !s
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c))
        })
    {
        return Err(AppError::bad("GitHub 仓库地址无效"));
    }
    let name = format!("{}/{}", parts[0], parts[1].trim_end_matches(".git"));
    let api = format!("https://api.github.com/repos/{name}");
    let mut headers = HeaderMap::new();
    headers.insert(
        ACCEPT,
        HeaderValue::from_static("application/vnd.github+json"),
    );
    if let Some(token) = &state.github_token {
        headers.insert(
            AUTHORIZATION,
            HeaderValue::from_str(&format!("Bearer {token}"))
                .map_err(|_| AppError::bad("GITHUB_TOKEN 格式错误"))?,
        );
    }
    let metadata = state
        .network
        .fetch(&api, Method::GET, headers.clone(), None, true)
        .await?;
    if metadata.status != 200 {
        return Err(AppError::bad(format!(
            "GitHub 返回 HTTP {}。私有仓库或请求限额需要配置 GITHUB_TOKEN",
            metadata.status
        )));
    }
    let repo: Value = serde_json::from_slice(&metadata.bytes)
        .map_err(|_| AppError::bad("GitHub 响应格式错误"))?;
    let mut warnings = vec![];
    let release = match state
        .network
        .fetch(
            &format!("{api}/releases/latest"),
            Method::GET,
            headers.clone(),
            None,
            true,
        )
        .await
    {
        Ok(f) if f.status == 200 => match serde_json::from_slice::<Value>(&f.bytes) {
            Ok(value) => Some(value),
            Err(_) => {
                warnings.push("最新 Release 响应无效，保留已有版本信息".into());
                None
            }
        },
        Ok(f) if f.status == 404 => Some(Value::Null),
        _ => {
            warnings.push("最新 Release 暂未同步，可稍后重试".into());
            None
        }
    };
    headers.insert(
        ACCEPT,
        HeaderValue::from_static("application/vnd.github.raw+json"),
    );
    let readme = match state
        .network
        .fetch(&format!("{api}/readme"), Method::GET, headers, None, true)
        .await
    {
        Ok(f) if f.status == 200 => Some(String::from_utf8_lossy(&f.bytes).into_owned()),
        Ok(f) if f.status == 404 => Some(String::new()),
        _ => {
            warnings.push("README 暂未同步".into());
            None
        }
    };
    Ok(Collected {
        input: repository_input(&repo, &name, release.as_ref(), readme.as_deref()),
        images: vec![],
        warnings,
    })
}

fn repository_input(
    repo: &Value,
    requested_name: &str,
    release: Option<&Value>,
    readme: Option<&str>,
) -> ItemInput {
    let name = repo["full_name"].as_str().unwrap_or(requested_name);
    let (owner, repo_name) = name.split_once('/').unwrap_or(("", name));
    let tags = repo["topics"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .take(50)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    let mut data = json!({"owner":owner, "repoName":repo_name, "stars": repo["stargazers_count"], "forks":repo["forks_count"], "watchers":repo["subscribers_count"], "license":repo["license"]["spdx_id"], "defaultBranch":repo["default_branch"], "localWorkspacePath":"", "cookbookNotes":""});
    if let Some(release) = release {
        for (field, source) in [
            ("latestRelease", "tag_name"),
            ("releaseDate", "published_at"),
            ("releaseUrl", "html_url"),
            ("releaseNotes", "body"),
        ] {
            data[field] = release[source].clone();
        }
    }
    if let Some(readme) = readme {
        data["readme"] = readme.into();
    }
    ItemInput {
        kind: "repo".into(),
        title: name.into(),
        url: format!("https://github.com/{name}"),
        category: repo["language"].as_str().unwrap_or("未标注").into(),
        summary: repo["description"].as_str().unwrap_or_default().into(),
        tags,
        data,
        ..Default::default()
    }
}

fn resolve<'a>(root: &'a Value, value: &'a Value) -> Result<&'a Value> {
    let mut current = value;
    for _ in 0..20 {
        match current["$ref"].as_str() {
            Some(reference) => {
                current = root
                    .pointer(reference.strip_prefix('#').ok_or_else(|| {
                        AppError::bad("外部 $ref 暂不支持，请先将 OpenAPI 打包为单个文件")
                    })?)
                    .ok_or_else(|| AppError::bad(format!("无法解析 OpenAPI 引用：{reference}")))?;
            }
            None => return Ok(current),
        }
    }
    Err(AppError::bad("OpenAPI 包含循环引用"))
}
fn sample(root: &Value, value: &Value, depth: usize) -> Value {
    if depth > 6 {
        return Value::Null;
    }
    let Ok(value) = resolve(root, value) else {
        return Value::Null;
    };
    for key in ["example", "default"] {
        if !value[key].is_null() {
            return value[key].clone();
        }
    }
    if let Some(first) = value["enum"].as_array().and_then(|a| a.first()) {
        return first.clone();
    }
    if let Some(first) = value["oneOf"]
        .as_array()
        .or_else(|| value["anyOf"].as_array())
        .and_then(|a| a.first())
    {
        return sample(root, first, depth + 1);
    }
    if let Some(parts) = value["allOf"].as_array() {
        let mut fields = serde_json::Map::new();
        for part in parts {
            if let Value::Object(v) = sample(root, part, depth + 1) {
                fields.extend(v);
            }
        }
        return fields.into();
    }
    match value["type"]
        .as_str()
        .unwrap_or(if value["properties"].is_object() {
            "object"
        } else {
            "string"
        }) {
        "object" => value["properties"]
            .as_object()
            .map(|p| {
                p.iter()
                    .map(|(k, v)| (k.clone(), sample(root, v, depth + 1)))
                    .collect::<serde_json::Map<_, _>>()
            })
            .unwrap_or_default()
            .into(),
        "array" => json!([sample(root, &value["items"], depth + 1)]),
        "integer" | "number" => json!(0),
        "boolean" => json!(false),
        _ => json!(""),
    }
}
fn string_value(value: Value) -> String {
    value.as_str().map(str::to_string).unwrap_or_else(|| {
        if value.is_null() {
            String::new()
        } else {
            value.to_string()
        }
    })
}

fn validate_references(root: &Value, value: &Value) -> Result<()> {
    match value {
        Value::Object(fields) => {
            if fields.contains_key("$ref") {
                if !value["$ref"].is_string() {
                    return Err(AppError::bad("OpenAPI $ref 必须为文本"));
                }
                resolve(root, value)?;
            }
            for (key, child) in fields {
                // Example payloads are data, not schema references.
                if !["example", "examples", "default", "enum", "const"].contains(&key.as_str()) {
                    validate_references(root, child)?;
                }
            }
        }
        Value::Array(values) => {
            for child in values {
                validate_references(root, child)?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn normalize_server(parsed: url::Url) -> Result<String> {
    parse_url(parsed.as_str())?;
    if parsed.fragment().is_some() {
        return Err(AppError::bad("OpenAPI 服务地址不能包含 # 片段"));
    }
    Ok(if parsed.query().is_some() {
        parsed.to_string()
    } else {
        parsed.to_string().trim_end_matches('/').to_string()
    })
}

fn server_url(server: &Value, source: Option<&url::Url>) -> Result<String> {
    let mut value = server["url"]
        .as_str()
        .ok_or_else(|| AppError::bad("OpenAPI servers 缺少 URL"))?
        .to_string();
    if let Some(variables) = server["variables"].as_object() {
        for (key, variable) in variables {
            let default = variable["default"]
                .as_str()
                .ok_or_else(|| AppError::bad("OpenAPI 服务地址变量缺少默认值"))?;
            value = value.replace(&format!("{{{key}}}"), default);
        }
    }
    if value.contains(['{', '}']) {
        return Err(AppError::bad("OpenAPI 服务地址变量未定义"));
    }
    if let Ok(absolute) = url::Url::parse(&value) {
        if ["http", "https"].contains(&absolute.scheme()) && absolute.host_str().is_some() {
            return normalize_server(absolute);
        }
    }
    let Some(source) = source else {
        return Ok(String::new());
    };
    let parsed = source
        .join(&value)
        .map_err(|_| AppError::bad("OpenAPI servers URL 无效"))?;
    normalize_server(parsed)
}

fn body_example(mime: &str, example: Value, encoding: &Value) -> (String, Option<String>) {
    if mime.contains("json") {
        return (
            serde_json::to_string_pretty(&example).unwrap_or_default(),
            None,
        );
    }
    if mime == "application/x-www-form-urlencoded" {
        if let Some(fields) = example.as_object() {
            let mut result = url::form_urlencoded::Serializer::new(String::new());
            for (key, value) in fields {
                let enc = &encoding[key];
                if enc.get("style").is_some() || enc.get("explode").is_some() {
                    if enc["style"].as_str().is_some_and(|style| style != "form") {
                        return (
                            String::new(),
                            Some("此表单使用特殊参数编码，请根据规范手动填写请求正文。".into()),
                        );
                    }
                    let explode = enc["explode"].as_bool().unwrap_or(true);
                    if let Some(array) = value.as_array() {
                        if explode {
                            for entry in array {
                                result.append_pair(key, &string_value(entry.clone()));
                            }
                        } else {
                            result.append_pair(
                                key,
                                &array
                                    .iter()
                                    .cloned()
                                    .map(string_value)
                                    .collect::<Vec<_>>()
                                    .join(","),
                            );
                        }
                        continue;
                    }
                    if let Some(object) = value.as_object() {
                        if explode {
                            for (name, entry) in object {
                                result.append_pair(name, &string_value(entry.clone()));
                            }
                        } else {
                            let values: Vec<_> = object
                                .iter()
                                .flat_map(|(name, entry)| {
                                    [name.clone(), string_value(entry.clone())]
                                })
                                .collect();
                            result.append_pair(key, &values.join(","));
                        }
                        continue;
                    }
                }
                result.append_pair(key, &string_value(value.clone()));
            }
            return (result.finish(), None);
        }
        return (string_value(example), None);
    }
    if mime.starts_with("multipart/") || (mime.contains("xml") && !example.is_string()) {
        return (
            String::new(),
            Some(format!("{mime} 正文需手动填写；文件上传请求尚未自动生成。")),
        );
    }
    (string_value(example), None)
}

pub fn openapi(doc: &Value, source: &str) -> Result<ItemInput> {
    if !doc["openapi"].as_str().is_some_and(|v| v.starts_with("3.")) && doc["swagger"] != "2.0" {
        return Err(AppError::bad("不是有效的 OpenAPI 3.x / Swagger 2.0 规范"));
    }
    validate_references(doc, doc)?;
    let source_url = if source.trim().is_empty() {
        None
    } else {
        Some(parse_url(source)?)
    };
    let base_url = if doc["servers"][0].is_object() {
        server_url(&doc["servers"][0], source_url.as_ref())?
    } else {
        let value = if let Some(host) = doc["host"].as_str() {
            format!(
                "{}://{}{}",
                doc["schemes"][0]
                    .as_str()
                    .or_else(|| source_url.as_ref().map(|url| url.scheme()))
                    .unwrap_or("https"),
                host,
                doc["basePath"].as_str().unwrap_or_default()
            )
        } else if let Some(source_url) = source_url.as_ref() {
            format!(
                "{}{}",
                source_url.origin().ascii_serialization(),
                doc["basePath"].as_str().unwrap_or_default()
            )
        } else {
            String::new()
        };
        if value.is_empty() {
            String::new()
        } else {
            server_url(&json!({"url": value}), source_url.as_ref())?
        }
    };
    let paths = doc["paths"]
        .as_object()
        .ok_or_else(|| AppError::bad("OpenAPI 缺少 paths"))?;
    let mut endpoints = vec![];
    for (path, path_spec) in paths {
        let path_spec = resolve(doc, path_spec)?;
        for method in [
            "get", "post", "put", "patch", "delete", "head", "options", "trace",
        ] {
            if !path_spec[method].is_object() {
                continue;
            }
            let op = resolve(doc, &path_spec[method])?;
            let operation_server = op["servers"]
                .as_array()
                .and_then(|a| a.first())
                .or_else(|| path_spec["servers"].as_array().and_then(|a| a.first()));
            let operation_url = operation_server
                .map(|server| server_url(server, source_url.as_ref()))
                .transpose()?;
            let mut params = HashMap::new();
            for list in [&path_spec["parameters"], &op["parameters"]] {
                if let Some(list) = list.as_array() {
                    for p in list {
                        let p = resolve(doc, p)?;
                        params.insert(
                            (
                                p["in"].as_str().unwrap_or_default(),
                                p["name"].as_str().unwrap_or_default(),
                            ),
                            p,
                        );
                    }
                }
            }
            let mut query = vec![];
            let mut path_params = vec![];
            let mut headers = vec![];
            let mut body = String::new();
            let mut warning = None;
            let mut form = serde_json::Map::new();
            for ((location, name), p) in params {
                if location == "body" {
                    let example = sample(doc, &p["schema"], 0);
                    let mime = op["consumes"][0]
                        .as_str()
                        .or_else(|| doc["consumes"][0].as_str())
                        .unwrap_or("application/json");
                    (body, warning) = body_example(mime, example, &Value::Null);
                    continue;
                }
                if location == "formData" {
                    if p["type"] == "file" {
                        warning = Some(
                            "文件上传请求尚未自动生成，请手动配置正文与 Content-Type。".into(),
                        );
                    }
                    form.insert(name.into(), sample(doc, p, 0));
                    continue;
                }
                let schema = if p["schema"].is_object() {
                    &p["schema"]
                } else {
                    p
                };
                let value = if p.get("example").is_some() {
                    p["example"].clone()
                } else {
                    sample(doc, schema, 0)
                };
                let pair = json!({"key":name, "value":string_value(value), "enabled":p["required"].as_bool().unwrap_or(false) || location == "path", "desc":p["description"].as_str().unwrap_or_default()});
                match location {
                    "query" => query.push(pair),
                    "path" => path_params.push(pair),
                    "header" => headers.push(pair),
                    _ => {}
                }
            }
            for pairs in [&mut query, &mut path_params, &mut headers] {
                pairs.sort_by(|a, b| a["key"].as_str().cmp(&b["key"].as_str()));
            }
            if op["requestBody"].is_object() {
                let request_body = resolve(doc, &op["requestBody"])?;
                if let Some(content) = request_body["content"].as_object() {
                    if let Some((mime, content)) = content
                        .get_key_value("application/json")
                        .or_else(|| content.iter().next())
                    {
                        let example = content
                            .get("example")
                            .cloned()
                            .or_else(|| {
                                content["examples"]
                                    .as_object()
                                    .and_then(|a| a.values().next())
                                    .and_then(|v| v.get("value"))
                                    .cloned()
                            })
                            .unwrap_or_else(|| sample(doc, &content["schema"], 0));
                        (body, warning) = body_example(mime, example, &content["encoding"]);
                        headers.push(json!({"key":"Content-Type", "value":mime, "enabled":true, "desc":"请求内容类型"}));
                    }
                }
            }
            if !form.is_empty() {
                let mime = op["consumes"][0]
                    .as_str()
                    .or_else(|| doc["consumes"][0].as_str())
                    .unwrap_or("application/x-www-form-urlencoded");
                if warning.is_none() {
                    (body, warning) = body_example(mime, form.into(), &Value::Null);
                }
                headers.push(json!({"key":"Content-Type", "value":mime, "enabled":true, "desc":"请求内容类型"}));
            }
            if !body.is_empty()
                && !headers.iter().any(|h| {
                    h["key"]
                        .as_str()
                        .is_some_and(|k| k.eq_ignore_ascii_case("content-type"))
                })
            {
                let mime = op["consumes"][0]
                    .as_str()
                    .or_else(|| doc["consumes"][0].as_str())
                    .unwrap_or("application/json");
                headers.push(json!({"key":"Content-Type", "value":mime, "enabled":true, "desc":"请求内容类型"}));
            }
            let mut endpoint = json!({"method":method.to_uppercase(), "path":path, "summary":op["summary"].as_str().or_else(|| op["operationId"].as_str()).unwrap_or(path), "tag":op["tags"][0].as_str().unwrap_or("默认"), "customHeaders":headers, "queryParams":query, "pathParams":path_params, "requestBody":body});
            if let Some(url) = operation_url.filter(|url| !url.is_empty()) {
                endpoint["baseUrl"] = url.into();
            }
            if let Some(warning) = warning {
                endpoint["requestWarning"] = warning.into();
            }
            endpoints.push(endpoint);
        }
    }
    if endpoints.len() > 2000 {
        return Err(AppError::bad("单个规范最多支持 2000 个接口，请拆分导入"));
    }
    Ok(ItemInput {
        kind: "credential".into(),
        title: doc["info"]["title"]
            .as_str()
            .unwrap_or("OpenAPI 服务")
            .chars()
            .take(500)
            .collect(),
        category: "http".into(),
        data: json!({"typeKey":"rest_api", "fields":{"baseUrl":base_url,"swaggerUrl":source},"description":doc["info"]["description"],"globalHeaders":[], "swaggerEndpoints":endpoints,"spec":doc}),
        ..Default::default()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn wechat_urls_drop_tracking_query_and_captcha_pages_are_blocked() {
        assert_eq!(
            canonical_source_url(
                "https://mp.weixin.qq.com/s/KW2jUE8RUV3xX4nZ6F5Rqg?scene=1&click_id=1192932897"
            )
            .unwrap(),
            "https://mp.weixin.qq.com/s/KW2jUE8RUV3xX4nZ6F5Rqg"
        );
        assert_eq!(
            canonical_source_url("https://example.com/post?utm=1").unwrap(),
            "https://example.com/post?utm=1"
        );
        assert!(!scrape_blocked(
            "https://example.com/a",
            "排查未知错误",
            "<div id=\"js_content\">enough article text for ingest</div>"
        ));
        assert!(scrape_blocked(
            "https://mp.weixin.qq.com/mp/wappoc_appmsgcaptcha?poc_token=x",
            "未知错误",
            "失效的验证页面"
        ));
    }
    #[test]
    fn operation_servers_override_path_and_root_and_expand_variables() {
        let doc = json!({"openapi":"3.0.3","servers":[{"url":"/root"}],"paths":{
            "/root-only":{"get":{}},
            "/overrides":{"servers":[{"url":"../path"}],"get":{},"post":{"servers":[{"url":"https://{env}.example/v2?key=a/","variables":{"env":{"default":"staging"}}}]}}
        }});
        let input = openapi(&doc, "https://example.com/docs/openapi.json").unwrap();
        assert_eq!(input.data["fields"]["baseUrl"], "https://example.com/root");
        let endpoints = input.data["swaggerEndpoints"].as_array().unwrap();
        assert_eq!(
            endpoints.iter().find(|e| e["method"] == "POST").unwrap()["baseUrl"],
            "https://staging.example/v2?key=a/"
        );
        assert_eq!(
            endpoints
                .iter()
                .find(|e| e["path"] == "/overrides" && e["method"] == "GET")
                .unwrap()["baseUrl"],
            "https://example.com/path"
        );
        assert!(endpoints
            .iter()
            .find(|e| e["path"] == "/root-only")
            .unwrap()
            .get("baseUrl")
            .is_none());
        let legacy = openapi(
            &json!({"swagger":"2.0","basePath":"/legacy","paths":{}}),
            "https://example.com/spec.json",
        )
        .unwrap();
        assert_eq!(
            legacy.data["fields"]["baseUrl"],
            "https://example.com/legacy"
        );
    }
    #[test]
    fn form_bodies_are_encoded_and_unsupported_multipart_is_explicit() {
        for doc in [
            json!({"openapi":"3.0.3","paths":{"/login":{"post":{"requestBody":{"content":{"application/x-www-form-urlencoded":{"example":{"name":"a&b 中文","password":"x+y=z"}}}}}}}}),
            json!({"swagger":"2.0","consumes":["application/x-www-form-urlencoded"],"paths":{"/login":{"post":{"parameters":[{"in":"formData","name":"name","type":"string","default":"a&b 中文"},{"in":"formData","name":"password","type":"string","default":"x+y=z"}]}}}}),
        ] {
            let input = openapi(&doc, "https://example.com/spec.json").unwrap();
            let ep = &input.data["swaggerEndpoints"][0];
            let body: std::collections::BTreeMap<_, _> =
                url::form_urlencoded::parse(ep["requestBody"].as_str().unwrap().as_bytes())
                    .into_owned()
                    .collect();
            assert_eq!(body["name"], "a&b 中文");
            assert_eq!(body["password"], "x+y=z");
            assert!(ep.get("requestWarning").is_none());
            assert_eq!(
                ep["customHeaders"][0]["value"],
                "application/x-www-form-urlencoded"
            );
        }
        let doc = json!({"openapi":"3.0.3","paths":{"/upload":{"post":{"requestBody":{"content":{"multipart/form-data":{"schema":{"type":"object","properties":{"file":{"type":"string","format":"binary"}}}}}}}}}});
        let input = openapi(&doc, "https://example.com/spec.json").unwrap();
        assert_eq!(input.data["swaggerEndpoints"][0]["requestBody"], "");
        assert!(input.data["swaggerEndpoints"][0]["requestWarning"]
            .as_str()
            .unwrap()
            .contains("手动"));
    }
    #[test]
    fn github_uses_canonical_names_and_distinguishes_missing_resources_from_failures() {
        let repo = json!({"full_name":"new-owner/new-name","language":"Rust"});
        let failed = repository_input(&repo, "old-owner/old-name", None, None);
        assert_eq!(failed.url, "https://github.com/new-owner/new-name");
        assert_eq!(failed.data["owner"], "new-owner");
        assert!(failed.data.get("readme").is_none());
        assert!(failed.data.get("latestRelease").is_none());
        let missing = repository_input(&repo, "old-owner/old-name", Some(&Value::Null), Some(""));
        assert_eq!(missing.data["readme"], "");
        assert_eq!(missing.data.get("latestRelease"), Some(&Value::Null));
    }
    #[test]
    fn rejects_nested_bad_refs_but_allows_recursive_models_and_literal_examples() {
        let mut doc = json!({"openapi":"3.1.0","paths":{},"components":{"schemas":{"Node":{"type":"object","properties":{"next":{"$ref":"#/components/schemas/Node"}}}}}});
        assert!(openapi(&doc, "https://example.com/spec.json").is_ok());
        doc["components"]["schemas"]["Node"]["example"] = json!({"$ref":"literal-data"});
        assert!(openapi(&doc, "https://example.com/spec.json").is_ok());
        for reference in ["https://example.com/external", "#/missing"] {
            doc["components"]["schemas"]["Node"]["properties"]["next"]["$ref"] = reference.into();
            assert!(openapi(&doc, "https://example.com/spec.json").is_err());
        }
        doc["components"]["schemas"]["Node"] = json!({"$ref":"#/components/schemas/Node"});
        assert!(openapi(&doc, "https://example.com/spec.json").is_err());
    }
    #[test]
    fn imports_openapi_refs_and_operation_overrides() {
        let doc = json!({"openapi":"3.0.3","info":{"title":"Orders"},"servers":[{"url":"/v2"}],"components":{"schemas":{"Order":{"type":"object","properties":{"amount":{"type":"number","example":42}}}}},"paths":{"/orders/{id}":{"parameters":[{"in":"path","name":"id","required":true,"schema":{"type":"string"}}],"post":{"parameters":[{"in":"query","name":"q","schema":{"default":"test"}}],"requestBody":{"content":{"application/json":{"schema":{"$ref":"#/components/schemas/Order"}}}}}}}});
        let result = openapi(&doc, "https://example.com/openapi.json").unwrap();
        assert_eq!(result.data["fields"]["baseUrl"], "https://example.com/v2");
        let ep = &result.data["swaggerEndpoints"][0];
        assert_eq!(ep["pathParams"][0]["key"], "id");
        assert!(ep["requestBody"].as_str().unwrap().contains("42"));
        assert_eq!(ep["queryParams"][0]["value"], "test");
    }
    #[test]
    fn supports_swagger_v2_body_and_rejects_external_refs() {
        let mut doc = json!({"swagger":"2.0","info":{"title":"Legacy"},"host":"example.com","basePath":"/v1","paths":{"/items":{"post":{"parameters":[{"in":"body","name":"body","schema":{"type":"object","properties":{"ok":{"type":"boolean"}}}}]}}}});
        let result = openapi(&doc, "https://example.com/swagger.json").unwrap();
        assert!(result.data["swaggerEndpoints"][0]["requestBody"]
            .as_str()
            .unwrap()
            .contains("false"));
        doc["paths"]["/items"] = json!({"$ref":"https://evil.test/schema"});
        assert!(openapi(&doc, "https://example.com/swagger.json").is_err());
    }
    #[test]
    fn github_hosts_include_www_and_ignore_other_github_sites() {
        assert!(is_github_host(Some("github.com")));
        assert!(is_github_host(Some("WWW.GITHUB.COM")));
        assert!(is_github_host(Some("www.github.com")));
        assert!(!is_github_host(Some("gist.github.com")));
        assert!(!is_github_host(Some("example.com")));
    }
    #[test]
    fn swagger_ui_mention_without_spec_is_not_fatal_for_auto_detect() {
        assert!(looks_like_swagger_ui(
            "This post embeds swagger-ui and SwaggerUIBundle({ url: '/missing.json' })"
        ));
        assert!(!swagger_discovery_required(""));
        assert!(!swagger_discovery_required("knowledge"));
        assert!(swagger_discovery_required("credential"));
    }
    #[test]
    fn swagger_candidates_skip_petstore_and_prefer_local_spec_over_dummy_urls() {
        let page = url::Url::parse("https://api.internal/docs/index.html").unwrap();
        let html = r#"
            SwaggerUIBundle({
              url: "https://petstore.swagger.io/v2/swagger.json",
              extra: true
            });
            const a = { url: "https://cdn.example/dummy1.json" };
            const b = { url: "https://cdn.example/dummy2.json" };
            const c = { url: "https://cdn.example/dummy3.json" };
            const d = { url: "https://cdn.example/dummy4.json" };
            const e = { url: "https://cdn.example/dummy5.json" };
            const real = { url: "/openapi.json" };
        "#;
        let candidates = swagger_spec_candidates(&page, html, true);
        assert_eq!(candidates[0], "https://api.internal/openapi.json");
        assert!(candidates
            .iter()
            .all(|url| !url.contains("petstore.swagger.io")));
        let dummy_index = candidates
            .iter()
            .position(|url| url.contains("dummy1.json"))
            .unwrap_or(usize::MAX);
        assert!(dummy_index > 0);
        let mention = swagger_spec_candidates(
            &page,
            "这篇文章讨论 SwaggerUIBundle 的使用方式",
            false,
        );
        assert!(mention.is_empty());
    }
    #[test]
    fn inline_openapi_without_source_does_not_invent_example_com() {
        let doc = json!({"openapi":"3.0.3","info":{"title":"T"},"paths":{"/x":{"get":{}}}});
        let parsed = openapi(&doc, "").unwrap();
        assert_eq!(parsed.data["fields"]["baseUrl"], "");
        assert!(!parsed.data.to_string().contains("example.com"));
        let relative = json!({"openapi":"3.0.3","info":{"title":"T"},"servers":[{"url":"/v1"}],"paths":{"/x":{"get":{}}}});
        let parsed = openapi(&relative, "").unwrap();
        assert_eq!(parsed.data["fields"]["baseUrl"], "");
        assert!(!parsed.data.to_string().contains("example.com"));
    }
}
