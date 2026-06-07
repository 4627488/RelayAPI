use chrono::Utc;
use sea_orm::{EntityTrait, Set};
use serde_json::{json, Value};

use crate::{
    db::{entities::codex_quota_cache, Database},
    error::{AppError, AppResult},
    http::AppState,
    services::codex_credentials,
};

const WHAM_USAGE_URL: &str = "https://chatgpt.com/backend-api/wham/usage";

pub async fn get(state: &AppState, credential_id: &str, force_refresh: bool) -> AppResult<Value> {
    if !force_refresh {
        if let Some(row) = codex_quota_cache::Entity::find_by_id(credential_id.to_string())
            .one(&state.db().conn)
            .await?
        {
            let body = serde_json::from_str::<Value>(&row.cache_json).unwrap_or_else(|_| json!({}));
            return Ok(json!({
                "cached": true,
                "status": row.status,
                "retrieved_at": row.retrieved_at,
                "raw": body,
            }));
        }
    }
    let credential = codex_credentials::runtime_by_id(state, credential_id).await?;
    if credential.account_id.is_empty() {
        return Err(AppError::bad_request(
            "missing_account_id",
            "Credential has no ChatGPT account id",
        ));
    }
    let response = state
        .http()
        .get(WHAM_USAGE_URL)
        .header(
            "authorization",
            format!("Bearer {}", credential.access_token),
        )
        .header("chatgpt-account-id", &credential.account_id)
        .header(
            "user-agent",
            credential
                .user_agent
                .as_deref()
                .unwrap_or(&state.config().codex_user_agent),
        )
        .send()
        .await?;
    let status = response.status();
    let body: Value = response.json().await.unwrap_or_else(|_| json!({}));
    if !status.is_success() {
        return Err(AppError::Http {
            status: axum::http::StatusCode::from_u16(status.as_u16())
                .unwrap_or(axum::http::StatusCode::BAD_GATEWAY),
            code: "codex_quota_request_failed",
            message: body.to_string(),
        });
    }
    let now = Utc::now().to_rfc3339();
    let quota_status = quota_status(&body);
    let active = codex_quota_cache::ActiveModel {
        credential_id: Set(credential_id.to_string()),
        status: Set(quota_status.clone()),
        cache_json: Set(body.to_string()),
        retrieved_at: Set(now.clone()),
        updated_at: Set(now),
    };
    codex_quota_cache::Entity::insert(active)
        .on_conflict(
            sea_orm::sea_query::OnConflict::column(codex_quota_cache::Column::CredentialId)
                .update_columns([
                    codex_quota_cache::Column::Status,
                    codex_quota_cache::Column::CacheJson,
                    codex_quota_cache::Column::RetrievedAt,
                    codex_quota_cache::Column::UpdatedAt,
                ])
                .to_owned(),
        )
        .exec(&state.db().conn)
        .await?;
    Ok(json!({ "cached": false, "status": quota_status, "raw": body }))
}

#[allow(dead_code)]
pub async fn clear(db: &Database, credential_id: &str) -> AppResult<()> {
    codex_quota_cache::Entity::delete_by_id(credential_id.to_string())
        .exec(&db.conn)
        .await?;
    Ok(())
}

fn quota_status(body: &Value) -> String {
    let text = body.to_string().to_lowercase();
    if text.contains("exhausted") || text.contains("0 remaining") {
        "exhausted"
    } else {
        "unknown"
    }
    .to_string()
}
