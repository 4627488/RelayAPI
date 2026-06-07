use chrono::Utc;
use sea_orm::{ActiveModelTrait, ColumnTrait, EntityTrait, QueryFilter, Set};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{
    db::{
        entities::{api_keys, tenants},
        Database,
    },
    error::{AppError, AppResult},
    services::crypto,
};

#[derive(Clone, Serialize)]
pub struct ApiKeyPublic {
    pub id: String,
    pub name: String,
    pub prefix: String,
    pub enabled: bool,
    pub scopes: Vec<String>,
    pub model_allowlist: Vec<String>,
    pub channel_allowlist: Vec<String>,
    pub token_limit_daily: Option<i64>,
    pub rate_limit_per_minute: Option<i64>,
    pub expires_at: Option<String>,
    pub created_at: String,
    pub last_used_at: Option<String>,
}

#[derive(Deserialize)]
pub struct CreateApiKeyRequest {
    pub name: String,
    pub scopes: Option<Vec<String>>,
    pub model_allowlist: Option<Vec<String>>,
    pub channel_allowlist: Option<Vec<String>>,
    pub token_limit_daily: Option<i64>,
    pub rate_limit_per_minute: Option<i64>,
    pub expires_at: Option<String>,
}

#[derive(Deserialize)]
pub struct PatchApiKeyRequest {
    pub name: Option<String>,
    pub enabled: Option<bool>,
    pub scopes: Option<Vec<String>>,
    pub model_allowlist: Option<Vec<String>>,
    pub channel_allowlist: Option<Vec<String>>,
    pub token_limit_daily: Option<Option<i64>>,
    pub rate_limit_per_minute: Option<Option<i64>>,
    pub expires_at: Option<Option<String>>,
}

#[derive(Serialize)]
pub struct CreateApiKeyResponse {
    pub api_key: ApiKeyPublic,
    pub key: String,
}

#[derive(Clone)]
pub struct RelayApiKeyContext {
    pub id: String,
    pub prefix: String,
    pub name: String,
    pub tenant_id: Option<String>,
    pub tenant_name: Option<String>,
    pub channel_allowlist: Vec<String>,
    pub model_allowlist: Vec<String>,
    pub token_limit_daily: Option<i64>,
    pub rate_limit_per_minute: Option<i64>,
}

pub async fn list(db: &Database) -> AppResult<Vec<ApiKeyPublic>> {
    let rows = api_keys::Entity::find().all(&db.conn).await?;
    Ok(rows.into_iter().map(public).collect())
}

pub async fn list_for_tenant(db: &Database, tenant_id: &str) -> AppResult<Vec<ApiKeyPublic>> {
    let rows = api_keys::Entity::find()
        .filter(api_keys::Column::TenantId.eq(Some(tenant_id.to_string())))
        .all(&db.conn)
        .await?;
    Ok(rows.into_iter().map(public).collect())
}

pub async fn create(db: &Database, input: CreateApiKeyRequest) -> AppResult<CreateApiKeyResponse> {
    create_with_tenant(db, None, input).await
}

pub async fn create_for_tenant(
    db: &Database,
    tenant_id: &str,
    input: CreateApiKeyRequest,
) -> AppResult<CreateApiKeyResponse> {
    create_with_tenant(db, Some(tenant_id.to_string()), input).await
}

async fn create_with_tenant(
    db: &Database,
    tenant_id: Option<String>,
    input: CreateApiKeyRequest,
) -> AppResult<CreateApiKeyResponse> {
    let now = Utc::now().to_rfc3339();
    let secret = format!("relay_{}", crypto::random_urlsafe(32));
    let prefix = secret.chars().take(18).collect::<String>();
    let id = Uuid::new_v4().to_string();
    let active = api_keys::ActiveModel {
        id: Set(id.clone()),
        tenant_id: Set(tenant_id),
        name: Set(clean_name(&input.name)),
        key_hash: Set(crypto::hash_secret(&secret)),
        prefix: Set(prefix),
        enabled: Set(1),
        scopes_json: Set(json_string(
            &input.scopes.unwrap_or_else(|| vec!["relay".to_string()]),
        )),
        model_allowlist_json: Set(json_string(&input.model_allowlist.unwrap_or_default())),
        channel_allowlist_json: Set(json_string(&input.channel_allowlist.unwrap_or_default())),
        token_limit_daily: Set(input.token_limit_daily),
        rate_limit_per_minute: Set(input.rate_limit_per_minute),
        expires_at: Set(input.expires_at),
        created_at: Set(now.clone()),
        updated_at: Set(now),
        last_used_at: Set(None),
    };
    api_keys::Entity::insert(active).exec(&db.conn).await?;
    let model = api_keys::Entity::find_by_id(id)
        .one(&db.conn)
        .await?
        .ok_or_else(|| AppError::bad_request("api_key_create_failed", "API key was not created"))?;
    Ok(CreateApiKeyResponse {
        api_key: public(model),
        key: secret,
    })
}

pub async fn patch(db: &Database, id: &str, input: PatchApiKeyRequest) -> AppResult<ApiKeyPublic> {
    let row = api_keys::Entity::find_by_id(id.to_string())
        .one(&db.conn)
        .await?
        .ok_or_else(|| AppError::bad_request("api_key_not_found", "API key not found"))?;
    let mut active: api_keys::ActiveModel = row.into();
    if let Some(name) = input.name {
        active.name = Set(clean_name(&name));
    }
    if let Some(enabled) = input.enabled {
        active.enabled = Set(if enabled { 1 } else { 0 });
    }
    if let Some(scopes) = input.scopes {
        active.scopes_json = Set(json_string(&scopes));
    }
    if let Some(models) = input.model_allowlist {
        active.model_allowlist_json = Set(json_string(&models));
    }
    if let Some(channels) = input.channel_allowlist {
        active.channel_allowlist_json = Set(json_string(&channels));
    }
    if let Some(limit) = input.token_limit_daily {
        active.token_limit_daily = Set(limit);
    }
    if let Some(limit) = input.rate_limit_per_minute {
        active.rate_limit_per_minute = Set(limit);
    }
    if let Some(expires_at) = input.expires_at {
        active.expires_at = Set(expires_at);
    }
    active.updated_at = Set(Utc::now().to_rfc3339());
    Ok(public(active.update(&db.conn).await?))
}

pub async fn delete(db: &Database, id: &str) -> AppResult<()> {
    api_keys::Entity::delete_by_id(id.to_string())
        .exec(&db.conn)
        .await?;
    Ok(())
}

pub async fn delete_for_tenant(db: &Database, tenant_id: &str, id: &str) -> AppResult<()> {
    let row = api_keys::Entity::find_by_id(id.to_string())
        .one(&db.conn)
        .await?
        .ok_or_else(|| AppError::bad_request("api_key_not_found", "API key not found"))?;
    if row.tenant_id.as_deref() != Some(tenant_id) {
        return Err(AppError::unauthorized("API key is outside tenant scope"));
    }
    delete(db, id).await
}

pub async fn patch_for_tenant(
    db: &Database,
    tenant_id: &str,
    id: &str,
    input: PatchApiKeyRequest,
) -> AppResult<ApiKeyPublic> {
    let row = api_keys::Entity::find_by_id(id.to_string())
        .one(&db.conn)
        .await?
        .ok_or_else(|| AppError::bad_request("api_key_not_found", "API key not found"))?;
    if row.tenant_id.as_deref() != Some(tenant_id) {
        return Err(AppError::unauthorized("API key is outside tenant scope"));
    }
    patch(db, id, input).await
}

pub async fn authenticate(db: &Database, token: &str) -> AppResult<RelayApiKeyContext> {
    let key_hash = crypto::hash_secret(token.trim());
    let Some(row) = api_keys::Entity::find()
        .filter(api_keys::Column::KeyHash.eq(key_hash))
        .one(&db.conn)
        .await?
    else {
        return Err(AppError::unauthorized("Invalid API key"));
    };
    if row.enabled == 0 {
        return Err(AppError::unauthorized("API key is disabled"));
    }
    if let Some(expires_at) = &row.expires_at {
        if chrono::DateTime::parse_from_rfc3339(expires_at)
            .map(|value| value.with_timezone(&Utc) <= Utc::now())
            .unwrap_or(false)
        {
            return Err(AppError::unauthorized("API key has expired"));
        }
    }
    let tenant = if let Some(tenant_id) = &row.tenant_id {
        let tenant = tenants::Entity::find_by_id(tenant_id.clone())
            .one(&db.conn)
            .await?
            .ok_or_else(|| AppError::unauthorized("API key tenant no longer exists"))?;
        validate_tenant(&tenant)?;
        Some(tenant)
    } else {
        None
    };
    let mut active: api_keys::ActiveModel = row.clone().into();
    active.last_used_at = Set(Some(Utc::now().to_rfc3339()));
    active.update(&db.conn).await?;
    let tenant_models = tenant
        .as_ref()
        .map(|tenant| parse_string_list(&tenant.model_allowlist_json))
        .unwrap_or_default();
    let tenant_channels = tenant
        .as_ref()
        .map(|tenant| parse_string_list(&tenant.channel_allowlist_json))
        .unwrap_or_default();
    Ok(RelayApiKeyContext {
        id: row.id.clone(),
        prefix: row.prefix.clone(),
        name: row.name.clone(),
        tenant_id: row.tenant_id.clone(),
        tenant_name: tenant.as_ref().map(|tenant| tenant.name.clone()),
        channel_allowlist: effective_allowlist(
            parse_string_list(&row.channel_allowlist_json),
            tenant_channels,
        ),
        model_allowlist: effective_allowlist(
            parse_string_list(&row.model_allowlist_json),
            tenant_models,
        ),
        token_limit_daily: effective_limit(
            row.token_limit_daily,
            tenant.as_ref().and_then(|v| v.token_limit_daily),
        ),
        rate_limit_per_minute: effective_limit(
            row.rate_limit_per_minute,
            tenant.as_ref().and_then(|v| v.rate_limit_per_minute),
        ),
    })
}

fn validate_tenant(row: &tenants::Model) -> AppResult<()> {
    if row.enabled == 0 || row.deleted_at.is_some() {
        return Err(AppError::unauthorized("API key tenant is disabled"));
    }
    if let Some(expires_at) = &row.expires_at {
        if chrono::DateTime::parse_from_rfc3339(expires_at)
            .map(|value| value.with_timezone(&Utc) <= Utc::now())
            .unwrap_or(false)
        {
            return Err(AppError::unauthorized("API key tenant has expired"));
        }
    }
    Ok(())
}

fn effective_allowlist(key_list: Vec<String>, tenant_list: Vec<String>) -> Vec<String> {
    if key_list.is_empty() {
        return tenant_list;
    }
    if tenant_list.is_empty() {
        return key_list;
    }
    key_list
        .into_iter()
        .filter(|item| tenant_list.iter().any(|tenant_item| tenant_item == item))
        .collect()
}

fn effective_limit(key_limit: Option<i64>, tenant_limit: Option<i64>) -> Option<i64> {
    match (key_limit, tenant_limit) {
        (Some(key), Some(tenant)) => Some(key.min(tenant)),
        (Some(key), None) => Some(key),
        (None, Some(tenant)) => Some(tenant),
        (None, None) => None,
    }
}

fn public(row: api_keys::Model) -> ApiKeyPublic {
    ApiKeyPublic {
        id: row.id,
        name: row.name,
        prefix: row.prefix,
        enabled: row.enabled != 0,
        scopes: parse_string_list(&row.scopes_json),
        model_allowlist: parse_string_list(&row.model_allowlist_json),
        channel_allowlist: parse_string_list(&row.channel_allowlist_json),
        token_limit_daily: row.token_limit_daily,
        rate_limit_per_minute: row.rate_limit_per_minute,
        expires_at: row.expires_at,
        created_at: row.created_at,
        last_used_at: row.last_used_at,
    }
}

fn json_string(value: &[String]) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "[]".to_string())
}

fn clean_name(name: &str) -> String {
    let name = name.trim();
    if name.is_empty() {
        "API Key".to_string()
    } else {
        name.to_string()
    }
}

fn parse_string_list(value: &str) -> Vec<String> {
    serde_json::from_str::<Vec<String>>(value).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn effective_allowlist_intersects_when_both_are_set() {
        let result = effective_allowlist(
            vec!["a".to_string(), "b".to_string()],
            vec!["b".to_string(), "c".to_string()],
        );
        assert_eq!(result, vec!["b".to_string()]);
    }

    #[test]
    fn effective_allowlist_uses_tenant_list_when_key_is_unrestricted() {
        let result = effective_allowlist(Vec::new(), vec!["tenant-channel".to_string()]);
        assert_eq!(result, vec!["tenant-channel".to_string()]);
    }

    #[test]
    fn effective_limit_uses_strictest_limit() {
        assert_eq!(effective_limit(Some(100), Some(50)), Some(50));
        assert_eq!(effective_limit(Some(100), None), Some(100));
        assert_eq!(effective_limit(None, Some(50)), Some(50));
        assert_eq!(effective_limit(None, None), None);
    }
}
