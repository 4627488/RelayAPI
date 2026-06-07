mod config;
mod db;
mod error;
mod http;
mod services;
mod upstream;

use std::net::SocketAddr;

use anyhow::Context;
use axum::{
    http::{header, HeaderName, HeaderValue, Method},
    Router,
};
use tower_http::{
    cors::{AllowOrigin, CorsLayer},
    services::{ServeDir, ServeFile},
    trace::TraceLayer,
};
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
    let mut app = Router::new()
        .merge(http::routes(state))
        .layer(TraceLayer::new_for_http());
    if let Some(static_dir) = &config.static_dir {
        app = app.fallback_service(
            ServeDir::new(static_dir)
                .not_found_service(ServeFile::new(static_dir.join("index.html"))),
        );
    }
    if let Some(cors) = cors_layer(&config.cors_allowed_origins)? {
        app = app.layer(cors);
    }

    let addr = SocketAddr::from(([0, 0, 0, 0], config.port));
    tracing::info!(%addr, "starting RelayAPI Rust server");
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .with_context(|| format!("failed to bind {addr}"))?;
    axum::serve(listener, app).await?;
    Ok(())
}

fn cors_layer(origins: &[String]) -> anyhow::Result<Option<CorsLayer>> {
    if origins.is_empty() {
        return Ok(None);
    }
    let origins = origins
        .iter()
        .map(|origin| origin.parse::<HeaderValue>())
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Some(
        CorsLayer::new()
            .allow_origin(AllowOrigin::list(origins))
            .allow_methods([Method::GET, Method::POST, Method::PATCH, Method::DELETE])
            .allow_headers(allowed_headers())
            .allow_credentials(true),
    ))
}

fn allowed_headers() -> [HeaderName; 4] {
    [
        header::AUTHORIZATION,
        header::CONTENT_TYPE,
        HeaderName::from_static("x-api-key"),
        HeaderName::from_static("x-relay-web-key"),
    ]
}
