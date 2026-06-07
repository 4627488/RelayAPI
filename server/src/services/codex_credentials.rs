use axum::http::StatusCode;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use chrono::{TimeZone, Utc};
use sea_orm::{ActiveModelTrait, ColumnTrait, EntityTrait, QueryFilter, QueryOrder, Set};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;

const TOKEN_URL: &str = "https://auth.openai.com/oauth/token";
const CLIENT_ID: &str = "codex-cli";

use crate::{
    db::{entities::codex_credentials, Database},
    error::{AppError, AppResult},
    http::AppState,
    services::{crypto, proxy_pool::CredentialProxy},
};

#[derive(Clone, Serialize)]
pub struct CodexCredentialPublic {
    pub id: String,
    pub label: String,
    pub email: String,
    pub account_id: String,
    pub plan_type: String,
    pub enabled: bool,
    pub priority: i32,
    pub weight: i32,
    pub user_agent: Option<String>,
    pub upstream_transport: String,
    pub proxy: Option<CredentialProxy>,
    pub token_expires_at: Option<String>,
    pub last_refresh_at: Option<String>,
    pub last_used_at: Option<String>,
    pub created_at: String,
}

#[derive(Clone)]
#[allow(dead_code)]
pub struct CodexCredentialRuntime {
    pub id: String,
    pub email: String,
    pub account_id: String,
    pub plan_type: String,
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub user_agent: Option<String>,
    pub proxy: Option<CredentialProxy>,
}

#[derive(Deserialize)]
pub struct ImportCredentialRequest {
    pub label: Option<String>,
    pub tokens: Value,
}

#[derive(Deserialize)]
pub struct PatchCredentialRequest {
    pub label: Option<String>,
    pub enabled: Option<bool>,
    pub priority: Option<i32>,
    pub weight: Option<i32>,
    pub user_agent: Option<Option<String>>,
    pub upstream_transport: Option<String>,
    pub proxy: Option<Option<CredentialProxy>>,
}

pub async fn list(db: &Database) -> AppResult<Vec<CodexCredentialPublic>> {
    let rows = codex_credentials::Entity::find()
        .order_by_asc(codex_credentials::Column::Priority)
        .all(&db.conn)
        .await?;
    Ok(rows.into_iter().map(public).collect())
}

pub async fn import_tokens(
    state: &AppState,
    input: ImportCredentialRequest,
) -> AppResult<CodexCredentialPublic> {
    let credential = upsert_from_tokens(state, input.tokens, input.label).await?;
    Ok(public(credential))
}

pub async fn upsert_from_tokens(
    state: &AppState,
    tokens: Value,
    label: Option<String>,
) -> AppResult<codex_credentials::Model> {
    let access_token = tokens
        .get("access_token")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            AppError::bad_request("missing_access_token", "Token payload missing access_token")
        })?;
    let claims = decode_jwt_claims(access_token).unwrap_or_else(|| json!({}));
    let codex_auth = claims
        .get("https://api.openai.com/auth")
        .and_then(Value::as_object);
    let email = claims
        .get("email")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let account_id = codex_auth
        .and_then(|v| v.get("chatgpt_account_id"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let plan_type = codex_auth
        .and_then(|v| v.get("chatgpt_plan_type"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let token_expires_at = token_expires_at(&tokens, &claims);
    let now = Utc::now().to_rfc3339();
    let encrypted = crypto::encrypt_json(&state.config().secret, &tokens)?;
    let id = Uuid::new_v4().to_string();
    let active = codex_credentials::ActiveModel {
        id: Set(id.clone()),
        label: Set(label.unwrap_or_else(|| email.clone()).trim().to_string()),
        email: Set(email),
        account_id: Set(account_id),
        plan_type: Set(plan_type),
        token_ciphertext: Set(encrypted),
        token_expires_at: Set(token_expires_at),
        enabled: Set(1),
        priority: Set(100),
        weight: Set(1),
        user_agent: Set(None),
        upstream_transport: Set("http".to_string()),
        proxy_json: Set(None),
        metadata_json: Set("{}".to_string()),
        last_refresh_at: Set(Some(now.clone())),
        last_used_at: Set(None),
        created_at: Set(now.clone()),
        updated_at: Set(now),
    };
    codex_credentials::Entity::insert(active)
        .exec(&state.db().conn)
        .await?;
    let row = codex_credentials::Entity::find_by_id(id)
        .one(&state.db().conn)
        .await?
        .ok_or_else(|| {
            AppError::bad_request("credential_create_failed", "Credential was not created")
        })?;
    crate::services::channels::ensure_default_for_credential(state, &row).await?;
    Ok(row)
}

pub async fn delete(db: &Database, id: &str) -> AppResult<()> {
    codex_credentials::Entity::delete_by_id(id.to_string())
        .exec(&db.conn)
        .await?;
    Ok(())
}

pub async fn patch(
    state: &AppState,
    id: &str,
    input: PatchCredentialRequest,
) -> AppResult<CodexCredentialPublic> {
    let row = codex_credentials::Entity::find_by_id(id.to_string())
        .one(&state.db().conn)
        .await?
        .ok_or_else(|| {
            AppError::bad_request("codex_credential_not_found", "Codex credential not found")
        })?;
    let mut active: codex_credentials::ActiveModel = row.into();
    if let Some(label) = input.label {
        active.label = Set(label.trim().to_string());
    }
    if let Some(enabled) = input.enabled {
        active.enabled = Set(if enabled { 1 } else { 0 });
    }
    if let Some(priority) = input.priority {
        active.priority = Set(priority.max(0));
    }
    if let Some(weight) = input.weight {
        active.weight = Set(weight.max(1));
    }
    if let Some(user_agent) = input.user_agent {
        active.user_agent = Set(user_agent
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty()));
    }
    if let Some(transport) = input.upstream_transport {
        active.upstream_transport = Set(match transport.trim().to_ascii_lowercase().as_str() {
            "websocket" => "websocket".to_string(),
            _ => "http".to_string(),
        });
    }
    if let Some(proxy) = input.proxy {
        active.proxy_json = Set(proxy
            .map(|value| serde_json::to_string(&value))
            .transpose()
            .map_err(anyhow::Error::from)?);
    }
    active.updated_at = Set(Utc::now().to_rfc3339());
    Ok(public(active.update(&state.db().conn).await?))
}

pub async fn export(state: &AppState, id: Option<&str>) -> AppResult<Value> {
    let rows = if let Some(id) = id {
        codex_credentials::Entity::find_by_id(id.to_string())
            .one(&state.db().conn)
            .await?
            .into_iter()
            .collect::<Vec<_>>()
    } else {
        codex_credentials::Entity::find()
            .all(&state.db().conn)
            .await?
    };
    let mut credentials = Vec::with_capacity(rows.len());
    for row in rows {
        credentials.push(json!({
            "type": "codex",
            "id": row.id,
            "label": row.label,
            "email": row.email,
            "account_id": row.account_id,
            "plan_type": row.plan_type,
            "tokens": crypto::decrypt_json(&state.config().secret, &row.token_ciphertext)?,
            "enabled": row.enabled != 0,
            "priority": row.priority,
            "weight": row.weight,
            "user_agent": row.user_agent,
            "upstream_transport": row.upstream_transport,
            "proxy": parse_proxy(row.proxy_json.as_deref()),
        }));
    }
    Ok(
        json!({ "type": "relayapi_codex_credentials_export", "version": 2, "credentials": credentials }),
    )
}

pub async fn refresh(state: &AppState, id: &str) -> AppResult<CodexCredentialPublic> {
    let row = codex_credentials::Entity::find_by_id(id.to_string())
        .one(&state.db().conn)
        .await?
        .ok_or_else(|| {
            AppError::bad_request("codex_credential_not_found", "Codex credential not found")
        })?;
    let _ = refresh_tokens(state, &row).await?;
    let updated = codex_credentials::Entity::find_by_id(id.to_string())
        .one(&state.db().conn)
        .await?
        .ok_or_else(|| {
            AppError::bad_request("codex_credential_not_found", "Codex credential not found")
        })?;
    Ok(public(updated))
}

pub async fn runtime_by_id(state: &AppState, id: &str) -> AppResult<CodexCredentialRuntime> {
    let row = codex_credentials::Entity::find_by_id(id.to_string())
        .one(&state.db().conn)
        .await?
        .ok_or_else(|| {
            AppError::bad_request("codex_credential_not_found", "Codex credential not found")
        })?;
    runtime_from_row(state, row).await
}

pub async fn first_enabled(state: &AppState) -> AppResult<CodexCredentialRuntime> {
    let row = codex_credentials::Entity::find()
        .filter(codex_credentials::Column::Enabled.eq(1))
        .order_by_asc(codex_credentials::Column::Priority)
        .one(&state.db().conn)
        .await?
        .ok_or_else(|| {
            AppError::bad_request("no_codex_credentials", "No enabled Codex credentials")
        })?;
    runtime_from_row(state, row).await
}

async fn runtime_from_row(
    state: &AppState,
    row: codex_credentials::Model,
) -> AppResult<CodexCredentialRuntime> {
    let tokens = ensure_fresh_tokens(state, &row).await?;
    let access_token = tokens
        .get("access_token")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            AppError::bad_request("missing_access_token", "Credential has no access_token")
        })?
        .to_string();
    let refresh_token = tokens
        .get("refresh_token")
        .and_then(Value::as_str)
        .map(ToString::to_string);
    Ok(CodexCredentialRuntime {
        id: row.id,
        email: row.email,
        account_id: row.account_id,
        plan_type: row.plan_type,
        access_token,
        refresh_token,
        user_agent: row.user_agent,
        proxy: parse_proxy(row.proxy_json.as_deref()),
    })
}

async fn ensure_fresh_tokens(state: &AppState, row: &codex_credentials::Model) -> AppResult<Value> {
    let tokens = crypto::decrypt_json(&state.config().secret, &row.token_ciphertext)?;
    if !needs_refresh(&tokens, row.token_expires_at.as_deref()) {
        return Ok(tokens);
    }
    if tokens
        .get("refresh_token")
        .and_then(Value::as_str)
        .is_none()
    {
        return Ok(tokens);
    }
    refresh_tokens(state, row).await
}

async fn refresh_tokens(state: &AppState, row: &codex_credentials::Model) -> AppResult<Value> {
    let tokens = crypto::decrypt_json(&state.config().secret, &row.token_ciphertext)?;
    let Some(refresh_token) = tokens.get("refresh_token").and_then(Value::as_str) else {
        return Ok(tokens);
    };
    let response = state
        .http()
        .post(TOKEN_URL)
        .form(&[
            ("grant_type", "refresh_token"),
            ("client_id", CLIENT_ID),
            ("refresh_token", refresh_token),
        ])
        .send()
        .await?;
    let status = response.status();
    let mut refreshed: Value = response
        .json()
        .await
        .unwrap_or_else(|_| serde_json::json!({}));
    if !status.is_success() {
        return Err(AppError::Http {
            status: StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::BAD_GATEWAY),
            code: "codex_token_refresh_failed",
            message: refreshed.to_string(),
        });
    }
    if refreshed.get("refresh_token").is_none() {
        if let Some(existing_refresh_token) = tokens.get("refresh_token") {
            refreshed["refresh_token"] = existing_refresh_token.clone();
        }
    }
    let access_token = refreshed
        .get("access_token")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let claims = decode_jwt_claims(access_token).unwrap_or_else(|| json!({}));
    let token_expires_at = token_expires_at(&refreshed, &claims);
    let mut active: codex_credentials::ActiveModel = row.clone().into();
    active.token_ciphertext = Set(crypto::encrypt_json(&state.config().secret, &refreshed)?);
    active.token_expires_at = Set(token_expires_at);
    active.last_refresh_at = Set(Some(Utc::now().to_rfc3339()));
    active.updated_at = Set(Utc::now().to_rfc3339());
    active.update(&state.db().conn).await?;
    Ok(refreshed)
}

fn needs_refresh(tokens: &Value, token_expires_at: Option<&str>) -> bool {
    if tokens
        .get("refresh_token")
        .and_then(Value::as_str)
        .is_none()
    {
        return false;
    }
    let Some(expires_at) = token_expires_at else {
        return false;
    };
    chrono::DateTime::parse_from_rfc3339(expires_at)
        .map(|expires_at| {
            expires_at.with_timezone(&Utc) <= Utc::now() + chrono::Duration::seconds(90)
        })
        .unwrap_or(false)
}

fn public(row: codex_credentials::Model) -> CodexCredentialPublic {
    CodexCredentialPublic {
        id: row.id,
        label: row.label,
        email: row.email,
        account_id: row.account_id,
        plan_type: row.plan_type,
        enabled: row.enabled != 0,
        priority: row.priority,
        weight: row.weight,
        user_agent: row.user_agent,
        upstream_transport: row.upstream_transport,
        proxy: parse_proxy(row.proxy_json.as_deref()),
        token_expires_at: row.token_expires_at,
        last_refresh_at: row.last_refresh_at,
        last_used_at: row.last_used_at,
        created_at: row.created_at,
    }
}

fn parse_proxy(value: Option<&str>) -> Option<CredentialProxy> {
    value.and_then(|value| serde_json::from_str(value).ok())
}

fn decode_jwt_claims(token: &str) -> Option<Value> {
    let payload = token.split('.').nth(1)?;
    let bytes = URL_SAFE_NO_PAD.decode(payload).ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn token_expires_at(tokens: &Value, claims: &Value) -> Option<String> {
    if let Some(expires_at) = tokens.get("expires_at").and_then(Value::as_i64) {
        return Utc
            .timestamp_opt(expires_at, 0)
            .single()
            .map(|v| v.to_rfc3339());
    }
    if let Some(exp) = claims.get("exp").and_then(Value::as_i64) {
        return Utc.timestamp_opt(exp, 0).single().map(|v| v.to_rfc3339());
    }
    tokens
        .get("expires_in")
        .and_then(Value::as_i64)
        .map(|seconds| (Utc::now() + chrono::Duration::seconds(seconds)).to_rfc3339())
}
