use chrono::Utc;
use sea_orm::{EntityTrait, QueryOrder, QuerySelect, Set};
use serde::Serialize;
use uuid::Uuid;

use crate::{
    db::{entities::request_logs, Database},
    error::AppResult,
};

#[derive(Clone)]
pub struct RequestLogInput {
    pub started_at: String,
    pub method: String,
    pub path: String,
    pub request_type: String,
    pub stream: bool,
    pub model: String,
    pub status_code: i32,
    pub latency_ms: i64,
    pub api_key_id: Option<String>,
    pub api_key_prefix: Option<String>,
    pub channel_id: Option<String>,
    pub credential_id: Option<String>,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
    pub request_body_text: Option<String>,
    pub upstream_body_text: Option<String>,
}

#[derive(Serialize)]
pub struct RequestLogPublic {
    pub id: String,
    pub started_at: String,
    pub method: String,
    pub path: String,
    pub request_type: String,
    pub stream: bool,
    pub model: String,
    pub status_code: i32,
    pub latency_ms: i64,
    pub api_key_prefix: Option<String>,
    pub channel_id: Option<String>,
    pub credential_id: Option<String>,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
}

pub async fn append(db: &Database, input: RequestLogInput) -> AppResult<()> {
    let active = request_logs::ActiveModel {
        id: Set(Uuid::new_v4().to_string()),
        started_at: Set(input.started_at),
        completed_at: Set(Utc::now().to_rfc3339()),
        method: Set(input.method),
        path: Set(input.path),
        request_type: Set(input.request_type),
        stream: Set(if input.stream { 1 } else { 0 }),
        model: Set(input.model),
        status_code: Set(input.status_code),
        latency_ms: Set(input.latency_ms),
        api_key_id: Set(input.api_key_id),
        api_key_prefix: Set(input.api_key_prefix),
        channel_id: Set(input.channel_id),
        credential_id: Set(input.credential_id),
        prompt_tokens: Set(0),
        completion_tokens: Set(0),
        total_tokens: Set(0),
        error_code: Set(input.error_code),
        error_message: Set(input.error_message),
        request_body_text: Set(input.request_body_text),
        upstream_body_text: Set(input.upstream_body_text),
        timing_json: Set(None),
    };
    request_logs::Entity::insert(active).exec(&db.conn).await?;
    Ok(())
}

pub async fn recent(db: &Database, limit: u64) -> AppResult<Vec<RequestLogPublic>> {
    let rows = request_logs::Entity::find()
        .order_by_desc(request_logs::Column::StartedAt)
        .limit(limit)
        .all(&db.conn)
        .await?;
    Ok(rows.into_iter().map(public).collect())
}

fn public(row: request_logs::Model) -> RequestLogPublic {
    RequestLogPublic {
        id: row.id,
        started_at: row.started_at,
        method: row.method,
        path: row.path,
        request_type: row.request_type,
        stream: row.stream != 0,
        model: row.model,
        status_code: row.status_code,
        latency_ms: row.latency_ms,
        api_key_prefix: row.api_key_prefix,
        channel_id: row.channel_id,
        credential_id: row.credential_id,
        error_code: row.error_code,
        error_message: row.error_message,
    }
}
