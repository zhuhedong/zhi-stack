use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;

#[derive(Debug)]
pub struct AppError(pub StatusCode, pub String);
pub type Result<T> = std::result::Result<T, AppError>;

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.1)
    }
}
impl std::error::Error for AppError {}

impl AppError {
    pub fn bad(message: impl Into<String>) -> Self {
        Self(StatusCode::BAD_REQUEST, message.into())
    }
    pub fn locked() -> Self {
        Self(StatusCode::LOCKED, "金库已锁定，请输入主密码解锁".into())
    }
    pub fn unauthorized() -> Self {
        Self(StatusCode::UNAUTHORIZED, "会话已失效，请重新登录".into())
    }
}

pub(crate) fn unique_violation(constraint: Option<&str>) -> AppError {
    AppError(
        StatusCode::CONFLICT,
        if constraint == Some("items_source_unique") {
            "该链接已经收录，请刷新已有条目".into()
        } else {
            "保存冲突，请稍后重试".into()
        },
    )
}
impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        (self.0, Json(json!({"error": self.1}))).into_response()
    }
}
impl From<sqlx::Error> for AppError {
    fn from(err: sqlx::Error) -> Self {
        match &err {
            sqlx::Error::RowNotFound => Self(StatusCode::NOT_FOUND, "条目不存在或已删除".into()),
            sqlx::Error::Database(e) if e.is_unique_violation() => unique_violation(e.constraint()),
            _ => {
                tracing::error!(error = %err, "Database operation failed");
                Self(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "数据库操作失败，请检查服务端日志".into(),
                )
            }
        }
    }
}
impl From<reqwest::Error> for AppError {
    fn from(err: reqwest::Error) -> Self {
        // Do not echo a URL that may carry a credential in its query string.
        Self(
            StatusCode::BAD_GATEWAY,
            if err.is_timeout() {
                "目标站点响应超时"
            } else {
                "无法访问目标站点，请检查地址、网络和访问权限"
            }
            .into(),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_url_uniqueness_keeps_the_duplicate_link_wording() {
        assert_eq!(
            unique_violation(Some("items_source_unique")).1,
            "该链接已经收录，请刷新已有条目"
        );
    }

    #[test]
    fn other_unique_constraints_do_not_use_the_duplicate_link_wording() {
        for constraint in [
            None,
            Some("file_objects_pkey"),
            Some("media_item_id_source_url_key"),
        ] {
            let message = unique_violation(constraint).1;
            assert_ne!(message, "该链接已经收录，请刷新已有条目");
            assert!(message.contains("冲突"));
        }
    }
}
