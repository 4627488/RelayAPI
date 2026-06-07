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

pub async fn counts_for_tenant(db: &Database, tenant_id: &str) -> AppResult<Counts> {
    let api_keys = scalar(
        db,
        "SELECT COUNT(*) AS count FROM api_keys WHERE tenant_id = ?",
        [tenant_id.into()],
    )
    .await?;
    let request_logs = scalar(
        db,
        "SELECT COUNT(*) AS count FROM request_logs WHERE api_key_id IN (SELECT id FROM api_keys WHERE tenant_id = ?)",
        [tenant_id.into()],
    )
    .await?;
    let channels = scalar(
        db,
        "SELECT CASE WHEN channel_allowlist_json = '[]' THEN (SELECT COUNT(*) FROM channels) ELSE json_array_length(channel_allowlist_json) END AS count FROM tenants WHERE id = ?",
        [tenant_id.into()],
    )
    .await?;
    Ok(Counts {
        api_keys,
        codex_credentials: 0,
        channels,
        request_logs,
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

async fn scalar<I>(db: &Database, sql: &str, values: I) -> Result<i64, sea_orm::DbErr>
where
    I: IntoIterator<Item = sea_orm::Value>,
{
    let result = db
        .conn
        .query_one(Statement::from_sql_and_values(
            sea_orm::DatabaseBackend::Sqlite,
            sql,
            values,
        ))
        .await?;
    Ok(result
        .and_then(|row| row.try_get::<i64>("", "count").ok())
        .unwrap_or(0))
}
