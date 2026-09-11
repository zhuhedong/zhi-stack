pub mod api_history;
pub mod auth;
pub mod backup;
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
use std::{sync::Arc, time::Instant};
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
    pub login_attempts: Arc<Mutex<(Instant, u32)>>,
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
        Self {
            db,
            storage,
            file_cleanup: Arc::new(Notify::new()),
            sessions: Default::default(),
            login_attempts: Arc::new(Mutex::new((Instant::now(), 0))),
            network: net::Network {
                allowed_private_hosts: std::env::var("ALLOWED_PRIVATE_HOSTS")
                    .unwrap_or_default()
                    .split(',')
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_owned)
                    .collect(),
            },
            github_token: std::env::var("GITHUB_TOKEN").ok().filter(|s| !s.is_empty()),
            maintenance: Arc::new(RwLock::new(())),
            active_requests: Default::default(),
            active_jobs: Default::default(),
            jobs_notify: Default::default(),
            subscriptions_notify: Default::default(),
            github_api_base: std::env::var("GITHUB_API_BASE")
                .unwrap_or_else(|_| "https://api.github.com".into()),
        }
    }
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
    let origins = std::env::var("ALLOWED_ORIGINS").unwrap_or_else(|_| "http://localhost:5173,http://127.0.0.1:5173,http://tauri.localhost,https://tauri.localhost,tauri://localhost".into());
    let origins: Vec<HeaderValue> = origins
        .split(',')
        .filter_map(|s| s.trim().parse().ok())
        .collect();
    let cors = CorsLayer::new()
        .allow_origin(origins)
        .allow_methods([Method::GET, Method::POST, Method::PUT, Method::DELETE])
        .allow_headers([header::AUTHORIZATION, header::CONTENT_TYPE])
        .expose_headers([header::CONTENT_DISPOSITION]);
    let frontend = std::env::var("FRONTEND_DIR").unwrap_or_else(|_| "dist".into());
    Router::new()
        .nest("/api", api)
        .fallback_service(
            ServeDir::new(&frontend)
                .not_found_service(ServeFile::new(format!("{frontend}/index.html"))),
        )
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
