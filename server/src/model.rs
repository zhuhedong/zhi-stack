use crate::{
    crypto::{self, VaultKey},
    error::{AppError, Result},
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

#[derive(Debug, sqlx::FromRow)]
pub struct ItemRow {
    pub id: Uuid,
    pub kind: String,
    pub title: String,
    pub category: String,
    pub project: String,
    pub tags: Vec<String>,
    pub summary: String,
    pub url: String,
    pub data: Value,
    pub secret: Option<Vec<u8>>,
    pub favorite: bool,
    pub revision: i64,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub id: Uuid,
    pub kind: String,
    pub title: String,
    pub category: String,
    pub project: String,
    pub tags: Vec<String>,
    pub summary: String,
    pub url: String,
    pub data: Value,
    pub favorite: bool,
    pub revision: i64,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}
impl ItemRow {
    pub fn public(self, key: Option<&VaultKey>, detail: bool) -> Result<Item> {
        let data = if detail && self.kind == "credential" {
            let bytes = crypto::decrypt(
                key.ok_or_else(AppError::locked)?,
                self.secret.as_deref().unwrap_or_default(),
                &self.id.to_string(),
            )?;
            serde_json::from_slice(&bytes).map_err(|_| AppError::bad("凭证数据格式无效"))?
        } else if self.kind == "credential" {
            serde_json::json!({})
        } else {
            self.data
        };
        Ok(Item {
            id: self.id,
            kind: self.kind,
            title: self.title,
            category: self.category,
            project: self.project,
            tags: self.tags,
            summary: self.summary,
            url: self.url,
            data,
            favorite: self.favorite,
            revision: self.revision,
            created_at: self.created_at,
            updated_at: self.updated_at,
        })
    }
}

#[derive(Deserialize, Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct ItemInput {
    pub kind: String,
    pub title: String,
    #[serde(default)]
    pub category: String,
    #[serde(default)]
    pub project: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub url: String,
    #[serde(default = "empty_object")]
    pub data: Value,
    #[serde(default)]
    pub favorite: bool,
    pub revision: Option<i64>,
}
fn empty_object() -> Value {
    serde_json::json!({})
}
impl ItemInput {
    pub fn validate(&mut self) -> Result<()> {
        self.title = self.title.trim().to_string();
        self.url = self.url.trim().to_string();
        self.project = self.project.trim().to_string();
        if !["knowledge", "repo", "credential"].contains(&self.kind.as_str()) {
            return Err(AppError::bad("未知资产类型"));
        }
        if self.title.is_empty() || self.title.chars().count() > 500 {
            return Err(AppError::bad("标题需要 1–500 个字符"));
        }
        if !self.data.is_object() {
            return Err(AppError::bad("资产内容必须为 JSON 对象"));
        }
        validate_data(&self.data)?;
        if self.project.len() > 500
            || self.category.len() > 100
            || self.summary.len() > 16000
            || self.data.to_string().len() > 4 * 1024 * 1024
        {
            return Err(AppError::bad("资产内容超出大小限制"));
        }
        if !self.url.is_empty() {
            crate::net::parse_url(&self.url)?;
        }
        self.tags = self
            .tags
            .iter()
            .map(|x| x.trim().to_string())
            .filter(|x| !x.is_empty())
            .collect();
        self.tags.sort();
        self.tags.dedup();
        if self.tags.len() > 50 || self.tags.iter().any(|x| x.chars().count() > 100) {
            return Err(AppError::bad("最多 50 个标签，每项不超过 100 个字符"));
        }
        if self.kind == "credential" {
            // Metadata is searchable. All connection details and descriptions stay encrypted.
            if !self.summary.is_empty() {
                self.data["description"] = self.summary.clone().into();
            }
            if !self.url.is_empty() {
                self.data["sourceUrl"] = self.url.clone().into();
            }
            self.summary.clear();
            self.url.clear();
        }
        Ok(())
    }
}

fn validate_pairs(value: &Value) -> Result<()> {
    let pairs = value
        .as_array()
        .ok_or_else(|| AppError::bad("请求参数必须为数组"))?;
    if pairs.len() > 200 {
        return Err(AppError::bad("每组最多 200 个参数"));
    }
    for pair in pairs {
        if !pair["key"].is_string()
            || !pair["value"].is_string()
            || !pair["enabled"].is_boolean()
            || (!pair["desc"].is_null() && !pair["desc"].is_string())
        {
            return Err(AppError::bad(
                "请求参数需要 key、value 字符串和 enabled 布尔值",
            ));
        }
    }
    Ok(())
}

fn validate_data(data: &Value) -> Result<()> {
    for field in ["stars", "forks", "watchers", "imagesCount"] {
        if !data[field].is_null() && data[field].as_u64().is_none() {
            return Err(AppError::bad(format!("{field} 必须为非负整数")));
        }
    }
    for field in [
        "content",
        "author",
        "sourceName",
        "readme",
        "releaseNotes",
        "latestRelease",
        "releaseDate",
        "releaseUrl",
        "owner",
        "repoName",
        "license",
        "defaultBranch",
        "localWorkspacePath",
        "cookbookNotes",
        "description",
        "typeKey",
        "readerMode",
        "sourceUrl",
        "importSpec",
    ] {
        if !data[field].is_null() && !data[field].is_string() {
            return Err(AppError::bad(format!("{field} 必须为文本")));
        }
    }
    for field in ["releaseUrl"] {
        if let Some(url) = data[field].as_str().filter(|s| !s.is_empty()) {
            crate::net::parse_url(url)?;
        }
    }
    if let Some(fields) = data.get("fields") {
        if !fields
            .as_object()
            .is_some_and(|obj| obj.len() <= 100 && obj.values().all(Value::is_string))
        {
            return Err(AppError::bad("连接属性必须是最多 100 项的文本键值对"));
        }
    }
    if let Some(headers) = data.get("globalHeaders") {
        validate_pairs(headers)?;
    }
    if let Some(endpoints) = data.get("swaggerEndpoints") {
        let endpoints = endpoints
            .as_array()
            .ok_or_else(|| AppError::bad("接口目录必须为数组"))?;
        if endpoints.len() > 2000 {
            return Err(AppError::bad("每个资产最多 2000 个接口"));
        }
        for ep in endpoints {
            for field in ["baseUrl", "tag", "requestWarning"] {
                if !ep[field].is_null() && !ep[field].is_string() {
                    return Err(AppError::bad(format!("接口 {field} 必须为文本")));
                }
            }
            if let Some(url) = ep["baseUrl"].as_str().filter(|url| !url.trim().is_empty()) {
                crate::net::parse_url(url)?;
            }
            if !ep["path"].as_str().is_some_and(|p| p.starts_with('/'))
                || !ep["summary"].is_string()
                || !ep["requestBody"].is_string()
                || !ep["method"].as_str().is_some_and(|m| {
                    [
                        "GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "TRACE",
                    ]
                    .contains(&m)
                })
            {
                return Err(AppError::bad(
                    "接口需要合法方法、以 / 开头的路径、说明和请求正文",
                ));
            }
            for field in ["pathParams", "queryParams", "customHeaders"] {
                validate_pairs(&ep[field])?;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tag_limit_applies_after_trim_and_dedup() {
        let mut input = ItemInput {
            kind: "knowledge".into(),
            title: "笔记".into(),
            tags: std::iter::repeat("alpha".to_string())
                .take(51)
                .chain(["".into(), "  ".into(), " alpha ".into()])
                .collect(),
            data: serde_json::json!({}),
            ..Default::default()
        };
        input.validate().unwrap();
        assert_eq!(input.tags, vec!["alpha"]);
    }
}
