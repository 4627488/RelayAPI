mod config;
mod db;
mod error;
mod http;
mod services;
mod upstream;

use std::net::SocketAddr;

use anyhow::Context;
use axum::Router;
use tower_http::{cors::CorsLayer, trace::TraceLayer};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

use crate::{config::Config, db::Database, http::AppState};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    if std::env::args().any(|arg| arg == "--healthcheck") {
        let port = std::env::var("PORT").unwrap_or_else(|_| "3000".to_string());
        let response = reqwest::get(format!("http://127.0.0.1:{port}/api/health")).await?;
        anyhow::ensure!(response.status().is_success(), "healthcheck failed");
        return Ok(());
    }

    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "relay_api_server=info,tower_http=info".into()),
        )
        .with(tracing_subscriber::fmt::layer())
        .init();

    let config = Config::from_env()?;
    if let Some(key) = &config.generated_web_access_key {
        tracing::warn!("generated RelayAPI web access key: {key}");
    }
    let db = Database::connect(&config).await?;
    db.migrate().await?;

    let state = AppState::new(config.clone(), db);
    let app = Router::new()
        .merge(http::routes(state))
        .layer(CorsLayer::permissive())
        .layer(TraceLayer::new_for_http());

    let addr = SocketAddr::from(([0, 0, 0, 0], config.port));
    tracing::info!(%addr, "starting RelayAPI Rust server");
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .with_context(|| format!("failed to bind {addr}"))?;
    axum::serve(listener, app).await?;
    Ok(())
}
