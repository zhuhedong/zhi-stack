//! Minimal Model Context Protocol server (Streamable HTTP, JSON responses only)
//! at `POST /api/mcp`, authenticated with personal API tokens.
use crate::{auth::Auth, error::AppError, jobs, library, routes, AppState};
use axum::{
    extract::{Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Extension, Json,
};
use serde_json::{json, Value};
use uuid::Uuid;

const PROTOCOLS: [&str; 3] = ["2025-06-18", "2025-03-26", "2024-11-05"];
const MAX_CONTENT: usize = 50_000;

fn tools() -> Value {
    json!([
        {
            "name": "search_items",
            "title": "搜索资料库",
            "description": "Full-text search across saved articles, notes, repositories and API collections (Chinese and English). Returns ids, titles, URLs and matching snippets.",
            "inputSchema": {"type":"object","properties":{
                "query":{"type":"string","description":"Search words; whitespace-separated terms must all match. Empty lists recent items."},
                "kind":{"type":"string","enum":["knowledge","repo","credential"],"description":"Optional item type filter"},
                "project":{"type":"string"},
                "limit":{"type":"integer","minimum":1,"maximum":50,"default":10}
            }},
            "annotations": {"readOnlyHint": true}
        },
        {
            "name": "get_item",
            "title": "读取条目",
            "description": "Read one saved item by id, including the article/note body (Markdown). Encrypted credential secrets are never returned.",
            "inputSchema": {"type":"object","properties":{"id":{"type":"string","format":"uuid"}},"required":["id"]},
            "annotations": {"readOnlyHint": true}
        },
        {
            "name": "save_url",
            "title": "收藏链接",
            "description": "Queue a web page or GitHub repository URL for collection into the library (requires the write scope). Returns the job id.",
            "inputSchema": {"type":"object","properties":{
                "url":{"type":"string","format":"uri"},
                "kind":{"type":"string","enum":["knowledge","repo"],"description":"Omit to auto-detect"},
                "project":{"type":"string"},
                "tags":{"type":"array","items":{"type":"string"}}
            },"required":["url"]}
        },
        {
            "name": "create_note",
            "title": "新建笔记",
            "description": "Create a Markdown note in the library (requires the write scope).",
            "inputSchema": {"type":"object","properties":{
                "title":{"type":"string"},
                "content":{"type":"string","description":"Markdown body"},
                "project":{"type":"string"},
                "tags":{"type":"array","items":{"type":"string"}}
            },"required":["title","content"]}
        }
    ])
}
fn rpc_error(id: &Value, code: i64, message: impl Into<String>) -> Value {
    json!({"jsonrpc":"2.0","id":id,"error":{"code":code,"message":message.into()}})
}
fn text_result(value: Value, is_error: bool) -> Value {
    let text = if let Value::String(s) = &value {
        s.clone()
    } else {
        serde_json::to_string_pretty(&value).unwrap_or_default()
    };
    json!({"content":[{"type":"text","text":text}],"structuredContent": if value.is_object() { value } else { json!({}) },"isError":is_error})
}
fn can_write(auth: &Auth) -> bool {
    auth.scopes
        .as_ref()
        .is_none_or(|s| s.iter().any(|v| v == "write"))
}
fn truncate(text: &str) -> String {
    if text.chars().count() <= MAX_CONTENT {
        return text.to_string();
    }
    let mut s: String = text.chars().take(MAX_CONTENT).collect();
    s.push_str("\n\n…（内容过长，已截断）");
    s
}
async fn call(state: &AppState, auth: &Auth, name: &str, args: &Value) -> Result<Value, AppError> {
    let s = |k: &str| args[k].as_str().unwrap_or_default().to_string();
    let tags: Vec<String> = args["tags"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    match name {
        "search_items" => {
            let limit = args["limit"].as_u64().unwrap_or(10).clamp(1, 50);
            let filter: library::Filter = serde_json::from_value(json!({
                "q": s("query"),
                "kind": args["kind"].as_str(),
                "project": args["project"].as_str(),
                "limit": limit,
            }))
            .map_err(|e| AppError::bad(e.to_string()))?;
            let Json(found) =
                library::list(State(state.clone()), Extension(auth.clone()), Query(filter)).await?;
            let items: Vec<Value> = found["items"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|i| json!({"id":i["id"],"kind":i["kind"],"title":i["title"],"url":i["url"],"project":i["project"],"tags":i["tags"],"summary":i["summary"],"snippet":i["matchSnippet"],"updatedAt":i["updatedAt"]}))
                .collect();
            Ok(json!({"total": found["total"], "items": items}))
        }
        "get_item" => {
            let id = Uuid::parse_str(&s("id")).map_err(|_| AppError::bad("id 必须是 UUID"))?;
            let Json(item) = routes::detail(
                State(state.clone()),
                Extension(auth.clone()),
                axum::extract::Path(id),
            )
            .await?;
            let item = json!(item);
            let data = &item["data"];
            let content = data["content"]
                .as_str()
                .or(data["readme"].as_str())
                .unwrap_or_default();
            Ok(json!({
                "id": item["id"], "kind": item["kind"], "title": item["title"], "url": item["url"],
                "project": item["project"], "tags": item["tags"], "summary": item["summary"],
                "category": item["category"], "createdAt": item["createdAt"], "updatedAt": item["updatedAt"],
                "content": truncate(content),
            }))
        }
        "save_url" | "create_note" if !can_write(auth) => Err(AppError(
            StatusCode::FORBIDDEN,
            "API 令牌缺少 write 权限".into(),
        )),
        "save_url" => {
            let kind = args["kind"].as_str().unwrap_or("");
            if !["", "knowledge", "repo"].contains(&kind) {
                return Err(AppError::bad("kind 只能是 knowledge 或 repo"));
            }
            let request: jobs::Enqueue = serde_json::from_value(json!({
                "url": s("url"), "kind": kind, "project": s("project"), "tags": tags, "requestId": Uuid::new_v4(),
            }))
            .map_err(|e| AppError::bad(e.to_string()))?;
            let (_, Json(job)) =
                jobs::create(State(state.clone()), Extension(auth.clone()), Json(request)).await?;
            Ok(json!({"queued": true, "jobId": job["id"], "status": job["status"]}))
        }
        "create_note" => {
            let input: crate::model::ItemInput = serde_json::from_value(json!({
                "kind": "knowledge", "title": s("title"), "category": "note", "project": s("project"),
                "tags": tags, "data": {"content": s("content")},
            }))
            .map_err(|e| AppError::bad(e.to_string()))?;
            let (_, Json(item)) =
                routes::create(State(state.clone()), Extension(auth.clone()), Json(input)).await?;
            let item = json!(item);
            Ok(json!({"id": item["id"], "title": item["title"]}))
        }
        _ => Err(AppError(StatusCode::NOT_FOUND, format!("未知工具：{name}"))),
    }
}
async fn handle(state: &AppState, auth: &Auth, message: &Value) -> Option<Value> {
    let id = message.get("id").cloned();
    let method = message["method"].as_str().unwrap_or_default();
    // Notifications (no id) get no response.
    let id = id?;
    if message["jsonrpc"] != "2.0" {
        return Some(rpc_error(&id, -32600, "Invalid Request"));
    }
    let params = &message["params"];
    Some(match method {
        "initialize" => {
            let requested = params["protocolVersion"].as_str().unwrap_or_default();
            let version = PROTOCOLS
                .iter()
                .find(|v| **v == requested)
                .unwrap_or(&PROTOCOLS[0]);
            json!({"jsonrpc":"2.0","id":id,"result":{
                "protocolVersion": version,
                "capabilities": {"tools": {"listChanged": false}},
                "serverInfo": {"name": "infohub", "title": "InfoHub", "version": env!("CARGO_PKG_VERSION")},
                "instructions": "Search and read the user's saved knowledge library; save URLs and notes when the token has the write scope."
            }})
        }
        "ping" => json!({"jsonrpc":"2.0","id":id,"result":{}}),
        "tools/list" => json!({"jsonrpc":"2.0","id":id,"result":{"tools": tools()}}),
        "tools/call" => {
            let name = params["name"].as_str().unwrap_or_default();
            let empty = json!({});
            let args = params
                .get("arguments")
                .filter(|v| v.is_object())
                .unwrap_or(&empty);
            if !tools()
                .as_array()
                .unwrap()
                .iter()
                .any(|t| t["name"] == name)
            {
                return Some(rpc_error(&id, -32602, format!("Unknown tool: {name}")));
            }
            let result = match call(state, auth, name, args).await {
                Ok(value) => text_result(value, false),
                Err(e) => text_result(json!(e.1), true),
            };
            json!({"jsonrpc":"2.0","id":id,"result":result})
        }
        _ => rpc_error(&id, -32601, format!("Method not found: {method}")),
    })
}
pub async fn endpoint(
    State(state): State<AppState>,
    Extension(auth): Extension<Auth>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let _ = headers;
    match &body {
        Value::Array(batch) => {
            if batch.is_empty() || batch.len() > 20 {
                return Json(rpc_error(&Value::Null, -32600, "Invalid batch")).into_response();
            }
            let mut out = Vec::new();
            for message in batch {
                if let Some(reply) = handle(&state, &auth, message).await {
                    out.push(reply);
                }
            }
            if out.is_empty() {
                StatusCode::ACCEPTED.into_response()
            } else {
                Json(Value::Array(out)).into_response()
            }
        }
        Value::Object(_) => match handle(&state, &auth, &body).await {
            Some(reply) => Json(reply).into_response(),
            None => StatusCode::ACCEPTED.into_response(),
        },
        _ => Json(rpc_error(&Value::Null, -32700, "Parse error")).into_response(),
    }
}
/// Server-initiated streams are not offered.
pub async fn get_not_allowed() -> StatusCode {
    StatusCode::METHOD_NOT_ALLOWED
}
