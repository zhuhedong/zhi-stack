pub mod auth;
pub mod crypto;
pub mod error;
pub mod files;
pub mod ingest;
pub mod model;
pub mod net;
pub mod routes;
pub mod storage;

use axum::{
    extract::DefaultBodyLimit,
    http::{header, HeaderValue, Method},
    middleware,
    routing::{get, post},
    Router,
};
use sqlx::PgPool;
use std::{sync::Arc, time::Instant};
use tokio::sync::{Mutex, Notify};
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
        }
    }
}
pub fn router(state: AppState) -> Router {
    let protected = Router::new()
        .route("/session", get(auth::session))
        .route("/vault/lock", post(auth::lock))
        .route("/vault/unlock", post(auth::unlock))
        .route("/auth/logout", post(auth::logout))
        .route("/items", get(routes::list).post(routes::create))
        .route(
            "/items/{id}",
            get(routes::detail)
                .put(routes::update)
                .delete(routes::delete),
        )
        .route("/items/{id}/refresh", post(routes::refresh))
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
        .route("/probe", post(routes::probe))
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            auth::middleware,
        ));
    let api = Router::new()
        .route("/health", get(auth::status))
        .route("/auth/setup", post(auth::setup))
        .route("/auth/login", post(auth::login))
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
        .with_state(state)
}
