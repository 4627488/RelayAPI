use sea_orm::{ConnectionTrait, Statement};
use serde::Serialize;

use crate::{db::Database, error::AppResult};

#[derive(Serialize)]
pub struct Counts {
    pub api_keys: i64,
    pub codex_credentials: i64,
    pub channels: i64,
    pub request_logs: i64,
}

pub async fn counts(db: &Database) -> AppResult<Counts> {
    Ok(Counts {
        api_keys: count(db, "api_keys").await?,
        codex_credentials: count(db, "codex_credentials").await?,
        channels: count(db, "channels").await?,
        request_logs: count(db, "request_logs").await?,
    })
}

async fn count(db: &Database, table: &str) -> Result<i64, sea_orm::DbErr> {
    let sql = format!("SELECT COUNT(*) AS count FROM {table}");
    let result = db
        .conn
        .query_one(Statement::from_string(
            sea_orm::DatabaseBackend::Sqlite,
            sql,
        ))
        .await?;
    Ok(result
        .and_then(|row| row.try_get::<i64>("", "count").ok())
        .unwrap_or(0))
}
