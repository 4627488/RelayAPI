use axum::http::StatusCode;
use chrono::{Datelike, Duration, Utc};
use sea_orm::{
    ColumnTrait, ConnectionTrait, EntityTrait, PaginatorTrait, QueryFilter, Set, Statement,
};
use serde_json::Value;
use uuid::Uuid;

use crate::{
    db::{
        entities::{request_logs, usage_records},
        Database,
    },
    error::{AppError, AppResult},
    services::api_keys::RelayApiKeyContext,
};

#[derive(Clone, Copy, Default)]
pub struct TokenUsage {
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
    pub total_tokens: i64,
    pub cached_tokens: i64,
}

pub struct RecordUsageInput<'a> {
    pub log_id: Option<&'a str>,
    pub api_key: &'a RelayApiKeyContext,
    pub channel_id: Option<&'a str>,
    pub credential_id: Option<&'a str>,
    pub model: &'a str,
    pub request_type: &'a str,
    pub usage: TokenUsage,
}

pub async fn enforce_preflight(db: &Database, api_key: &RelayApiKeyContext) -> AppResult<()> {
    if let Some(limit) = api_key.rate_limit_per_minute.filter(|limit| *limit > 0) {
        let since = (Utc::now() - Duration::minutes(1)).to_rfc3339();
        let count = count_recent_requests(db, &api_key.id, &since).await?;
        if count >= limit {
            return Err(rate_limited(
                "rate_limit_exceeded",
                "API key rate limit exceeded",
            ));
        }
    }
    if let Some(limit) = api_key.token_limit_daily.filter(|limit| *limit > 0) {
        let used = daily_tokens(db, &api_key.id).await?;
        if used >= limit {
            return Err(rate_limited(
                "daily_token_limit_exceeded",
                "API key daily token limit exceeded",
            ));
        }
    }
    Ok(())
}

pub async fn record(db: &Database, input: RecordUsageInput<'_>) -> AppResult<()> {
    let api_key = input.api_key;
    let usage = input.usage;
    if usage.total_tokens <= 0 && usage.prompt_tokens <= 0 && usage.completion_tokens <= 0 {
        return Ok(());
    }
    let now = Utc::now().to_rfc3339();
    usage_records::Entity::insert(usage_records::ActiveModel {
        id: Set(Uuid::new_v4().to_string()),
        request_log_id: Set(input.log_id.map(ToString::to_string)),
        api_key_id: Set(Some(api_key.id.clone())),
        api_key_prefix: Set(Some(api_key.prefix.clone())),
        api_key_name: Set(Some(api_key.name.clone())),
        tenant_id: Set(api_key.tenant_id.clone()),
        tenant_name: Set(api_key.tenant_name.clone()),
        channel_id: Set(input.channel_id.map(ToString::to_string)),
        credential_id: Set(input.credential_id.map(ToString::to_string)),
        model: Set(input.model.to_string()),
        request_type: Set(input.request_type.to_string()),
        prompt_tokens: Set(usage.prompt_tokens),
        completion_tokens: Set(usage.completion_tokens),
        total_tokens: Set(usage.total_tokens),
        cached_tokens: Set(usage.cached_tokens),
        created_at: Set(now),
    })
    .exec(&db.conn)
    .await?;
    Ok(())
}

pub fn extract_token_usage(text: &str) -> TokenUsage {
    let Ok(value) = serde_json::from_str::<Value>(text) else {
        return TokenUsage::default();
    };
    extract_from_value(&value).unwrap_or_default()
}

pub fn extract_token_usage_value(value: &Value) -> TokenUsage {
    extract_from_value(value).unwrap_or_default()
}

fn extract_from_value(value: &Value) -> Option<TokenUsage> {
    if let Some(usage) = value.get("usage").and_then(Value::as_object) {
        let prompt = number(usage.get("prompt_tokens"))
            .or_else(|| number(usage.get("input_tokens")))
            .unwrap_or(0);
        let completion = number(usage.get("completion_tokens"))
            .or_else(|| number(usage.get("output_tokens")))
            .unwrap_or(0);
        let total = number(usage.get("total_tokens")).unwrap_or(prompt + completion);
        let cached = usage
            .get("prompt_tokens_details")
            .and_then(|value| value.get("cached_tokens"))
            .and_then(Value::as_i64)
            .unwrap_or(0);
        if total > 0 || prompt > 0 || completion > 0 {
            return Some(TokenUsage {
                prompt_tokens: prompt,
                completion_tokens: completion,
                total_tokens: total,
                cached_tokens: cached,
            });
        }
    }
    if let Some(object) = value.as_object() {
        for child in object.values() {
            if let Some(usage) = extract_from_value(child) {
                return Some(usage);
            }
        }
    }
    if let Some(array) = value.as_array() {
        for child in array {
            if let Some(usage) = extract_from_value(child) {
                return Some(usage);
            }
        }
    }
    None
}

fn number(value: Option<&Value>) -> Option<i64> {
    value.and_then(Value::as_i64)
}

async fn count_recent_requests(db: &Database, api_key_id: &str, since: &str) -> AppResult<i64> {
    let count = request_logs::Entity::find()
        .filter(request_logs::Column::ApiKeyId.eq(Some(api_key_id.to_string())))
        .filter(request_logs::Column::StartedAt.gte(since.to_string()))
        .count(&db.conn)
        .await?;
    Ok(count as i64)
}

async fn daily_tokens(db: &Database, api_key_id: &str) -> AppResult<i64> {
    let today = Utc::now();
    let start = format!(
        "{:04}-{:02}-{:02}T00:00:00",
        today.year(),
        today.month(),
        today.day()
    );
    let result = db
        .conn
        .query_one(Statement::from_sql_and_values(
            sea_orm::DatabaseBackend::Sqlite,
            "SELECT COALESCE(SUM(total_tokens), 0) AS total FROM usage_records WHERE api_key_id = ? AND created_at >= ?",
            [api_key_id.into(), start.into()],
        ))
        .await?;
    Ok(result
        .and_then(|row| row.try_get::<i64>("", "total").ok())
        .unwrap_or(0))
}

fn rate_limited(code: &'static str, message: &'static str) -> AppError {
    AppError::Http {
        status: StatusCode::TOO_MANY_REQUESTS,
        code,
        message: message.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_openai_style_usage() {
        let usage = extract_token_usage(
            r#"{"usage":{"prompt_tokens":3,"completion_tokens":4,"total_tokens":7}}"#,
        );
        assert_eq!(usage.prompt_tokens, 3);
        assert_eq!(usage.completion_tokens, 4);
        assert_eq!(usage.total_tokens, 7);
    }

    #[test]
    fn extracts_nested_codex_usage() {
        let usage =
            extract_token_usage(r#"{"response":{"usage":{"input_tokens":5,"output_tokens":6}}}"#);
        assert_eq!(usage.prompt_tokens, 5);
        assert_eq!(usage.completion_tokens, 6);
        assert_eq!(usage.total_tokens, 11);
    }
}
