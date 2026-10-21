use infohub_server::{config::Config, files, router, storage::FileStorage, AppState};
use sqlx::postgres::PgPoolOptions;
use std::{net::SocketAddr, time::Duration};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    dotenvy::dotenv().ok();
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "infohub_server=info".into()),
        )
        .init();
    let _ = rustls::crypto::ring::default_provider().install_default();
    let config = match Config::load() {
        Ok(config) => config,
        Err(message) => {
            tracing::error!("配置错误：{message}");
            return Err(message.into());
        }
    };
    tracing::info!("InfoHub 生效配置：\n{}", config.summary());
    let options = config.database.clone();
    let db = PgPoolOptions::new()
        .max_connections(10)
        .acquire_timeout(Duration::from_secs(10))
        .connect_with(options)
        .await?;
    let storage = FileStorage::from_env().await?;
    sqlx::migrate!().run(&db).await?;
    files::initialize(&db, &storage).await?;
    sqlx::query("UPDATE backup_runs SET status='interrupted',message='服务中断，请重新执行并核对备份文件',finished_at=now() WHERE status='running'").execute(&db).await?;
    sqlx::query(
        "UPDATE api_history SET status='interrupted',finished_at=now() WHERE status='running'",
    )
    .execute(&db)
    .await?;
    let state = AppState::with_settings(db, storage, config.settings.clone());
    infohub_server::auth::prepare_setup_token(&state).await?;
    infohub_server::jobs::initialize(&state).await?;
    infohub_server::subscriptions::initialize(&state).await?;
    infohub_server::feeds::initialize(&state).await?;
    infohub_server::scheduled::initialize(&state).await?;
    let address = config.settings.bind_addr;
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
            let _guard = cleanup_state.maintenance.read().await;
            files::cleanup(&cleanup_state.db, &cleanup_state.storage).await;
            if sqlx::query("DELETE FROM usage_events WHERE created_at < now()-interval '180 days'")
                .execute(&cleanup_state.db)
                .await
                .is_err()
            {
                tracing::warn!("expired local usage events could not be removed");
            }
        }
    });
    let jobs_worker = tokio::spawn(infohub_server::jobs::worker(state.clone()));
    let subscriptions_worker = tokio::spawn(infohub_server::subscriptions::worker(state.clone()));
    let feeds_worker = tokio::spawn(infohub_server::feeds::worker(state.clone()));
    let backups_worker = tokio::spawn(infohub_server::scheduled::worker(state.clone()));
    let result = axum::serve(
        listener,
        router(state).into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown_signal())
    .await;
    cleanup_worker.abort();
    jobs_worker.abort();
    subscriptions_worker.abort();
    feeds_worker.abort();
    backups_worker.abort();
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
