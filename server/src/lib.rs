pub mod api_history;
pub mod auth;
pub mod backup;
pub mod config;
pub mod crypto;
pub mod error;
pub mod files;
pub mod ingest;
pub mod insights;
pub mod jobs;
pub mod library;
pub mod lifecycle;
pub mod model;
pub mod net;
pub mod projects;
pub mod routes;
pub mod storage;
pub mod subscriptions;

use axum::{
    extract::DefaultBodyLimit,
    http::{header, HeaderValue, Method},
    middleware,
    routing::{get, post},
    Router,
};
use sqlx::PgPool;
use std::sync::Arc;
use tokio::sync::{Mutex, Notify, RwLock};
use tower_http::{
    cors::CorsLayer,
    services::{ServeDir, ServeFile},
    set_header::SetResponseHeaderLayer,
};

#[derive(Clone)]
pub struct AppState {
    pub db: PgPool,
    pub storage: storage::FileStorage,
    pub file_cleanup: Arc<Notify>,
    pub sessions: auth::Sessions,
    pub login_limiter: Arc<Mutex<auth::Limiter>>,
    /// One-time token required by `/auth/setup` while the vault is uninitialized.
    pub setup_token: Arc<Mutex<Option<String>>>,
    pub settings: Arc<config::Settings>,
    pub network: net::Network,
    pub github_token: Option<String>,
    pub maintenance: Arc<RwLock<()>>,
    pub active_requests:
        Arc<Mutex<std::collections::HashMap<uuid::Uuid, tokio_util::sync::CancellationToken>>>,
    pub active_jobs:
        Arc<Mutex<std::collections::HashMap<uuid::Uuid, tokio_util::sync::CancellationToken>>>,
    pub jobs_notify: Arc<Notify>,
    pub subscriptions_notify: Arc<Notify>,
    pub github_api_base: String,
}
impl AppState {
    pub fn new(db: PgPool, storage: storage::FileStorage) -> Self {
        Self::with_settings(
            db,
            storage,
            config::Settings::from_env().unwrap_or_default(),
        )
    }
    pub fn with_settings(
        db: PgPool,
        storage: storage::FileStorage,
        settings: config::Settings,
    ) -> Self {
        Self {
            db,
            storage,
            file_cleanup: Arc::new(Notify::new()),
            sessions: Default::default(),
            login_limiter: Default::default(),
            setup_token: Arc::new(Mutex::new(settings.setup_token.clone())),
            network: net::Network {
                allowed_private_hosts: settings.allowed_private_hosts.clone(),
            },
            github_token: settings.github_token.clone(),
            maintenance: Arc::new(RwLock::new(())),
            active_requests: Default::default(),
            active_jobs: Default::default(),
            jobs_notify: Default::default(),
            subscriptions_notify: Default::default(),
            github_api_base: settings.github_api_base.clone(),
            settings: Arc::new(settings),
        }
    }
}
/// Content-Security-Policy for the web build. Mirrors the Tauri policy but
/// only allows API calls to the same origin.
pub const WEB_CSP: &str = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";
const LANDING_TEMPLATE: &str = include_str!("landing.html");

fn html_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

/// Renders the self-contained intro page used by `WEB_UI=landing`. No
/// scripts or external assets, so it satisfies [`WEB_CSP`].
pub fn landing_page(download_url: Option<&str>) -> String {
    let download = match download_url {
        Some(url) => format!(
            r#"<a class="btn" href="{}" rel="noopener noreferrer">下载桌面客户端</a>"#,
            html_escape(url)
        ),
        None => r#"<span class="btn disabled">桌面客户端下载地址未配置</span>"#.to_string(),
    };
    LANDING_TEMPLATE
        .replace("{{DOWNLOAD}}", &download)
        .replace("{{VERSION}}", env!("CARGO_PKG_VERSION"))
}

async fn not_found() -> axum::http::StatusCode {
    axum::http::StatusCode::NOT_FOUND
}

pub fn router(state: AppState) -> Router {
    let protected = Router::new()
        .route("/session", get(auth::session))
        .route(
            "/usage",
            get(insights::usage)
                .put(insights::settings)
                .delete(insights::clear),
        )
        .route(
            "/onboarding",
            get(insights::onboarding).put(insights::set_onboarding),
        )
        .route(
            "/feedback",
            get(insights::feedback).post(insights::add_feedback),
        )
        .route(
            "/feedback/{id}",
            axum::routing::put(insights::update_feedback).delete(insights::delete_feedback),
        )
        .route("/activity", get(insights::activity))
        .route("/vault/lock", post(auth::lock))
        .route("/vault/unlock", post(auth::unlock))
        .route("/vault/password", post(backup::change_password))
        .route("/backup/export", post(backup::export))
        .route("/backup/runs", get(backup::runs))
        .route("/auth/logout", post(auth::logout))
        .route("/items", get(library::list).post(routes::create))
        .route("/views", get(library::views).post(library::save_view))
        .route("/views/{id}", axum::routing::delete(library::delete_view))
        .route("/tags", get(library::tags))
        .route("/tags/merge", post(library::merge_tags))
        .route("/projects", get(projects::list).post(projects::create))
        .route(
            "/projects/{id}",
            get(projects::detail).put(projects::update),
        )
        .route("/items/batch", post(projects::batch))
        .route(
            "/items/{id}/relations",
            get(projects::relations).post(projects::link),
        )
        .route(
            "/items/{id}/relations/{target}",
            axum::routing::delete(projects::unlink),
        )
        .route(
            "/items/{id}/state",
            get(projects::state).put(projects::update_state),
        )
        .route("/items/{id}/visit", post(projects::visit))
        .route(
            "/items/{id}",
            get(routes::detail)
                .put(routes::update)
                .delete(routes::delete),
        )
        .route("/items/{id}/refresh", post(routes::refresh))
        .route("/items/{id}/versions", get(lifecycle::versions))
        .route("/items/{id}/export", get(backup::article_zip))
        .route("/items/{id}/versions/{version}", get(lifecycle::version))
        .route(
            "/items/{id}/versions/{version}/restore",
            post(lifecycle::restore_version),
        )
        .route("/trash", get(lifecycle::trash))
        .route("/trash/{id}/restore", post(lifecycle::restore_item))
        .route("/trash/{id}", axum::routing::delete(lifecycle::purge))
        .route("/drafts", get(lifecycle::drafts))
        .route(
            "/drafts/{id}",
            get(lifecycle::draft)
                .put(lifecycle::save_draft)
                .delete(lifecycle::delete_draft),
        )
        .route(
            "/items/{id}/attachments",
            get(routes::attachments).post(routes::upload),
        )
        .route(
            "/attachments/{id}",
            get(routes::download).delete(routes::delete_attachment),
        )
        .route("/media/{id}", get(routes::media))
        .route("/ingest", post(routes::ingest))
        .route("/jobs", get(jobs::list).post(jobs::create))
        .route("/jobs/{id}/cancel", post(jobs::cancel))
        .route("/jobs/{id}/retry", post(jobs::retry))
        .route("/jobs/{id}", axum::routing::delete(jobs::delete))
        .route("/subscriptions", get(subscriptions::all))
        .route(
            "/items/{id}/subscription",
            get(subscriptions::get).put(subscriptions::update),
        )
        .route(
            "/items/{id}/subscription/check",
            post(subscriptions::request_check),
        )
        .route("/items/{id}/subscription/seen", post(subscriptions::seen))
        .route("/probe", post(api_history::probe))
        .route("/items/{id}/requests", get(api_history::list))
        .route(
            "/items/{id}/requests/{request}",
            get(api_history::detail).delete(api_history::delete),
        )
        .route(
            "/items/{id}/requests/{request}/cancel",
            post(api_history::cancel),
        )
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            auth::middleware,
        ));
    let api = Router::new()
        .route("/health", get(auth::status))
        .route("/auth/setup", post(auth::setup))
        .route("/auth/login", post(auth::login))
        .route(
            "/backup/restore",
            post(backup::restore).layer(DefaultBodyLimit::disable()),
        )
        .merge(protected)
        .fallback(|| async {
            (
                axum::http::StatusCode::NOT_FOUND,
                axum::Json(serde_json::json!({"error":"接口不存在"})),
            )
        })
        .layer(SetResponseHeaderLayer::overriding(
            header::CACHE_CONTROL,
            HeaderValue::from_static("no-store"),
        ));
    let origins: Vec<HeaderValue> = state
        .settings
        .allowed_origins
        .iter()
        .filter_map(|s| s.trim().parse().ok())
        .collect();
    let cors = CorsLayer::new()
        .allow_origin(origins)
        .allow_methods([Method::GET, Method::POST, Method::PUT, Method::DELETE])
        .allow_headers([header::AUTHORIZATION, header::CONTENT_TYPE])
        .expose_headers([header::CONTENT_DISPOSITION]);
    let frontend = state.settings.frontend_dir.clone();
    let site = match state.settings.web_ui {
        config::WebUi::Full => Router::new().fallback_service(
            ServeDir::new(&frontend)
                .not_found_service(ServeFile::new(format!("{frontend}/index.html"))),
        ),
        config::WebUi::Landing => {
            let page = landing_page(state.settings.landing_download_url.as_deref());
            let serve = move || {
                let page = page.clone();
                async move {
                    (
                        [(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"))],
                        axum::response::Html(page),
                    )
                }
            };
            Router::new()
                .route("/", get(serve.clone()))
                .route("/index.html", get(serve))
                .fallback(not_found)
        }
        config::WebUi::Off => Router::new().fallback(not_found),
    };
    Router::new()
        .nest("/api", api)
        .merge(site)
        .layer(DefaultBodyLimit::max(12 * 1024 * 1024))
        .layer(cors)
        .layer(SetResponseHeaderLayer::overriding(
            header::X_CONTENT_TYPE_OPTIONS,
            HeaderValue::from_static("nosniff"),
        ))
        .layer(SetResponseHeaderLayer::overriding(
            header::REFERRER_POLICY,
            HeaderValue::from_static("no-referrer"),
        ))
        .layer(SetResponseHeaderLayer::if_not_present(
            header::CONTENT_SECURITY_POLICY,
            HeaderValue::from_static(WEB_CSP),
        ))
        .layer(SetResponseHeaderLayer::overriding(
            header::X_FRAME_OPTIONS,
            HeaderValue::from_static("DENY"),
        ))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            insights::track,
        ))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            lifecycle::maintenance_gate,
        ))
        .with_state(state)
}

#[cfg(test)]
mod web_ui_tests {
    use super::*;
    use axum::{body::Body, http::Request, http::StatusCode};
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    fn app(mode: config::WebUi, frontend: &str, download: Option<&str>) -> Router {
        let settings = config::Settings {
            web_ui: mode,
            frontend_dir: frontend.into(),
            landing_download_url: download.map(Into::into),
            ..Default::default()
        };
        let db = sqlx::postgres::PgPoolOptions::new()
            .acquire_timeout(std::time::Duration::from_millis(300))
            .connect_lazy("postgres://test:test@127.0.0.1:1/test")
            .unwrap();
        router(AppState::with_settings(
            db,
            storage::FileStorage::memory(),
            settings,
        ))
    }

    async fn get(app: &Router, uri: &str) -> (StatusCode, String, String) {
        let response = app
            .clone()
            .oneshot(Request::builder().uri(uri).body(Body::empty()).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let kind = response
            .headers()
            .get(header::CONTENT_TYPE)
            .map(|v| v.to_str().unwrap().to_string())
            .unwrap_or_default();
        let body = response.into_body().collect().await.unwrap().to_bytes();
        (status, kind, String::from_utf8_lossy(&body).into_owned())
    }

    fn frontend() -> tempfile_dir::Dir {
        tempfile_dir::Dir::new()
    }

    mod tempfile_dir {
        pub struct Dir(pub std::path::PathBuf);
        impl Dir {
            pub fn new() -> Self {
                let path =
                    std::env::temp_dir().join(format!("infohub-webui-{}", uuid::Uuid::new_v4()));
                std::fs::create_dir_all(path.join("assets")).unwrap();
                std::fs::write(
                    path.join("index.html"),
                    "<!doctype html><div id=root>SPA</div>",
                )
                .unwrap();
                std::fs::write(path.join("assets/app.js"), "console.log(1)").unwrap();
                Self(path)
            }
            pub fn path(&self) -> &str {
                self.0.to_str().unwrap()
            }
        }
        impl Drop for Dir {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
    }

    /// `/api/*` must reach the API router (JSON), never the web fallback.
    async fn assert_api_routed(app: &Router) {
        let (status, kind, _) = get(app, "/api/health").await;
        assert_ne!(status, StatusCode::NOT_FOUND);
        assert!(kind.starts_with("application/json"), "{kind}");
        let (status, kind, body) = get(app, "/api/does-not-exist").await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert!(kind.starts_with("application/json") && body.contains("接口不存在"));
    }

    #[tokio::test]
    async fn full_mode_serves_the_spa() {
        let dir = frontend();
        let app = app(config::WebUi::Full, dir.path(), None);
        let (s, _, b) = get(&app, "/").await;
        assert_eq!(s, StatusCode::OK);
        assert!(b.contains("SPA"));
        // Unchanged pre-existing behavior: ServeDir's not_found_service
        // returns index.html for SPA routes (with a 404 status).
        let (_, _, b) = get(&app, "/items/123").await;
        assert!(b.contains("SPA"));
        let (s, _, b) = get(&app, "/assets/app.js").await;
        assert_eq!(s, StatusCode::OK);
        assert!(b.contains("console.log"));
        assert_api_routed(&app).await;
    }

    #[tokio::test]
    async fn landing_mode_serves_only_the_intro_page() {
        let dir = frontend();
        let app = app(
            config::WebUi::Landing,
            dir.path(),
            Some("https://example.com/dl?a=1&b=\"x\""),
        );
        for path in ["/", "/index.html"] {
            let (s, kind, b) = get(&app, path).await;
            assert_eq!(s, StatusCode::OK);
            assert!(kind.starts_with("text/html"));
            assert!(b.contains("InfoHub") && b.contains(env!("CARGO_PKG_VERSION")));
            assert!(b.contains("https://example.com/dl?a=1&amp;b=&quot;x&quot;"));
            assert!(!b.contains("<script") && !b.contains("SPA"));
        }
        for path in ["/items/123", "/assets/app.js", "/favicon.ico"] {
            assert_eq!(get(&app, path).await.0, StatusCode::NOT_FOUND, "{path}");
        }
        assert_api_routed(&app).await;
    }

    #[tokio::test]
    async fn landing_page_without_download_url_shows_placeholder() {
        let page = landing_page(None);
        assert!(page.contains("下载地址未配置"));
        assert!(!page.contains("{{"));
        let page = landing_page(Some("https://example.com/download"));
        assert_eq!(
            page.matches(r#"href="https://example.com/download""#)
                .count(),
            3
        );
        assert!(page.contains(&format!("v{}", env!("CARGO_PKG_VERSION"))));
        assert!(!page.contains("{{") && !page.contains("<script"));
        assert!(page.contains("<title>新时代农民工笔记</title>"));
        assert!(page.contains("湘ICP备2023031880号-1"));
        assert!(page.contains(r#"href="https://beian.miit.gov.cn/""#));
    }

    #[tokio::test]
    async fn off_mode_serves_no_web_content() {
        let dir = frontend();
        let app = app(config::WebUi::Off, dir.path(), None);
        for path in ["/", "/index.html", "/items/123", "/assets/app.js"] {
            assert_eq!(get(&app, path).await.0, StatusCode::NOT_FOUND, "{path}");
        }
        assert_api_routed(&app).await;
    }
}
