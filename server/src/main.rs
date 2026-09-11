use infohub_server::{files, router, storage::FileStorage, AppState};
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use std::time::Duration;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    dotenvy::dotenv().ok();
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "infohub_server=info".into()),
        )
        .init();
    let options =
        if let Ok(url) = std::env::var("DATABASE_URL") {
            url.parse::<PgConnectOptions>()?
        } else {
            PgConnectOptions::new()
                .host(&std::env::var("PGHOST").map_err(|_| {
                    "请设置 DATABASE_URL 或 PGHOST 等 PG 连接变量（参见 .env.example）"
                })?)
                .port(
                    std::env::var("PGPORT")
                        .unwrap_or_else(|_| "5432".into())
                        .parse()?,
                )
                .username(&std::env::var("PGUSER")?)
                .password(&std::env::var("PGPASSWORD")?)
                .database(&std::env::var("PGDATABASE")?)
        };
    let db = PgPoolOptions::new()
        .max_connections(10)
        .acquire_timeout(Duration::from_secs(10))
        .connect_with(options)
        .await?;
    let storage = FileStorage::from_env().await?;
    sqlx::migrate!().run(&db).await?;
    files::initialize(&db, &storage).await?;
    let state = AppState::new(db, storage);
    let address = std::env::var("BIND_ADDR").unwrap_or_else(|_| "127.0.0.1:3210".into());
    let listener = tokio::net::TcpListener::bind(&address).await?;
    tracing::info!(%address, "InfoHub connected to PostgreSQL; server ready");
    let cleanup_state = state.clone();
    let cleanup_worker = tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(60));
        loop {
            tokio::select! {
                _ = interval.tick() => {},
                _ = cleanup_state.file_cleanup.notified() => {},
            }
            files::cleanup(&cleanup_state.db, &cleanup_state.storage).await;
        }
    });
    let result = axum::serve(listener, router(state))
        .with_graceful_shutdown(shutdown_signal())
        .await;
    cleanup_worker.abort();
    result?;
    Ok(())
}

async fn shutdown_signal() {
    #[cfg(unix)]
    {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut terminate) => tokio::select! {
                _ = tokio::signal::ctrl_c() => {},
                _ = terminate.recv() => {},
            },
            Err(_) => {
                tokio::signal::ctrl_c().await.ok();
            }
        }
    }
    #[cfg(not(unix))]
    {
        tokio::signal::ctrl_c().await.ok();
    }
}
