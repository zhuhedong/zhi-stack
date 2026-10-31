use crate::{
    auth::Auth,
    crypto,
    error::{AppError, Result},
    net::parse_url,
    AppState,
};
use axum::{
    extract::{Path, State},
    Extension, Json,
};
use reqwest::Method;
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

#[derive(Deserialize)]
pub struct TestInput {
    #[serde(default)]
    pub mode: Option<String>,
}

/// Test that a saved credential's target is reachable without returning or
/// logging any secret material. Database and SSH checks intentionally stop at
/// the TCP handshake: this is a connectivity check, not an authentication
/// attempt or an interactive session.
pub async fn test(
    State(state): State<AppState>,
    Extension(auth): Extension<Auth>,
    Path(id): Path<Uuid>,
    Json(input): Json<TestInput>,
) -> Result<Json<Value>> {
    let key = auth.vault()?;
    let (kind, category, secret): (String, String, Option<Vec<u8>>) =
        sqlx::query_as("SELECT kind,category,secret FROM items WHERE id=$1 AND deleted_at IS NULL")
            .bind(id)
            .fetch_one(&state.db)
            .await?;
    if kind != "credential" {
        return Err(AppError::bad("只有凭证资产支持连接测试"));
    }
    let secret = secret.ok_or_else(|| AppError::bad("凭证数据不存在"))?;
    let bytes = crypto::decrypt(key, &secret, &id.to_string())?;
    let data: Value =
        serde_json::from_slice(&bytes).map_err(|_| AppError::bad("凭证数据格式无效"))?;
    let type_key = data["typeKey"].as_str().unwrap_or_default();
    if type_key == "rest_api" || category == "http" {
        let url = data["fields"]["baseUrl"]
            .as_str()
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| AppError::bad("请先填写 Base URL"))?;
        let response = state
            .network
            .fetch(
                url,
                Method::HEAD,
                reqwest::header::HeaderMap::new(),
                None,
                false,
            )
            .await?;
        return Ok(Json(json!({
            "ok": true,
            "mode": input.mode.unwrap_or_else(|| "http".into()),
            "status": response.status,
            "message": format!("HTTP 目标可达（状态 {}）；服务是否接受凭证请以实际请求为准。", response.status)
        })));
    }

    let fields = data["fields"]
        .as_object()
        .ok_or_else(|| AppError::bad("凭证缺少连接属性"))?;
    let default_port = match type_key {
        "postgresql" => 5432,
        "mysql" => 3306,
        "redis" => 6379,
        "mongodb" => 27017,
        "milvus" => 19530,
        "qdrant" => 6333,
        "ssh" => 22,
        _ => 0,
    };
    if default_port == 0 {
        let url = fields
            .get("url")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| AppError::bad("该凭证类型没有可测试的网络目标"))?;
        let parsed = parse_url(url)?;
        let response = state
            .network
            .fetch(
                parsed.as_str(),
                Method::HEAD,
                reqwest::header::HeaderMap::new(),
                None,
                false,
            )
            .await?;
        return Ok(Json(json!({
            "ok": true,
            "mode": input.mode.unwrap_or_else(|| "http".into()),
            "status": response.status,
            "message": format!("目标可达（HTTP {}）。", response.status)
        })));
    }
    let host = fields
        .get("host")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| AppError::bad("请先填写 Host / IP"))?;
    let port = fields
        .get("port")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("")
        .parse::<u16>()
        .unwrap_or(default_port);
    state.network.tcp_connect(host, port).await?;
    Ok(Json(json!({
        "ok": true,
        "mode": input.mode.unwrap_or_else(|| "tcp".into()),
        "host": host,
        "port": port,
        "message": format!("{}:{} 网络可达；尚未执行数据库/SSH 登录。", host, port)
    })))
}
