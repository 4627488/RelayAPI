use chrono::Utc;
use sea_orm::{ActiveModelTrait, ColumnTrait, EntityTrait, QueryFilter, QueryOrder, Set};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{
    db::{
        entities::{channels, codex_credentials},
        Database,
    },
    error::{AppError, AppResult},
    http::AppState,
    services::{api_keys::RelayApiKeyContext, codex_credentials as credential_service},
};

#[derive(Clone, Serialize)]
pub struct ChannelPublic {
    pub id: String,
    pub name: String,
    pub base_url: String,
    pub credential_id: Option<String>,
    pub enabled: bool,
    pub priority: i32,
    pub weight: i32,
    pub model_allowlist: Vec<String>,
    pub status: String,
    pub health_score: i32,
    pub last_error: Option<String>,
    pub created_at: String,
}

#[derive(Clone)]
pub struct SelectedChannel {
    pub channel: channels::Model,
    pub credential: credential_service::CodexCredentialRuntime,
}

#[derive(Deserialize)]
pub struct CreateChannelRequest {
    pub name: String,
    pub base_url: Option<String>,
    pub credential_id: String,
    pub priority: Option<i32>,
    pub weight: Option<i32>,
    pub model_allowlist: Option<Vec<String>>,
}

#[derive(Deserialize)]
pub struct PatchChannelRequest {
    pub name: Option<String>,
    pub base_url: Option<String>,
    pub credential_id: Option<Option<String>>,
    pub enabled: Option<bool>,
    pub priority: Option<i32>,
    pub weight: Option<i32>,
    pub model_allowlist: Option<Vec<String>>,
    pub status: Option<String>,
}

pub async fn list(db: &Database) -> AppResult<Vec<ChannelPublic>> {
    let rows = channels::Entity::find()
        .order_by_asc(channels::Column::Priority)
        .all(&db.conn)
        .await?;
    Ok(rows.into_iter().map(public).collect())
}

pub async fn create(state: &AppState, input: CreateChannelRequest) -> AppResult<ChannelPublic> {
    let now = Utc::now().to_rfc3339();
    let id = Uuid::new_v4().to_string();
    let active = channels::ActiveModel {
        id: Set(id.clone()),
        name: Set(clean_name(&input.name)),
        base_url: Set(input
            .base_url
            .unwrap_or_else(|| state.config().codex_base_url.clone())),
        credential_id: Set(Some(input.credential_id)),
        enabled: Set(1),
        priority: Set(input.priority.unwrap_or(100).max(0)),
        weight: Set(input.weight.unwrap_or(1).max(1)),
        model_allowlist_json: Set(json_string(&input.model_allowlist.unwrap_or_default())),
        status: Set("healthy".to_string()),
        health_score: Set(100),
        cooldown_until: Set(None),
        last_error: Set(None),
        last_used_at: Set(None),
        created_at: Set(now.clone()),
        updated_at: Set(now),
    };
    channels::Entity::insert(active)
        .exec(&state.db().conn)
        .await?;
    let row = channels::Entity::find_by_id(id)
        .one(&state.db().conn)
        .await?
        .ok_or_else(|| AppError::bad_request("channel_create_failed", "Channel was not created"))?;
    Ok(public(row))
}

pub async fn patch(
    state: &AppState,
    id: &str,
    input: PatchChannelRequest,
) -> AppResult<ChannelPublic> {
    let row = channels::Entity::find_by_id(id.to_string())
        .one(&state.db().conn)
        .await?
        .ok_or_else(|| AppError::bad_request("channel_not_found", "Channel not found"))?;
    let mut active: channels::ActiveModel = row.into();
    if let Some(name) = input.name {
        active.name = Set(clean_name(&name));
    }
    if let Some(base_url) = input.base_url {
        active.base_url = Set(base_url.trim().trim_end_matches('/').to_string());
    }
    if let Some(credential_id) = input.credential_id {
        active.credential_id = Set(credential_id);
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
    if let Some(models) = input.model_allowlist {
        active.model_allowlist_json = Set(json_string(&models));
    }
    if let Some(status) = input.status {
        active.status = Set(status);
    }
    active.updated_at = Set(Utc::now().to_rfc3339());
    Ok(public(active.update(&state.db().conn).await?))
}

pub async fn delete(db: &Database, id: &str) -> AppResult<()> {
    channels::Entity::delete_by_id(id.to_string())
        .exec(&db.conn)
        .await?;
    Ok(())
}

pub async fn ensure_default_for_credential(
    state: &AppState,
    credential: &codex_credentials::Model,
) -> AppResult<()> {
    let existing = channels::Entity::find()
        .filter(channels::Column::CredentialId.eq(Some(credential.id.clone())))
        .one(&state.db().conn)
        .await?;
    if existing.is_some() {
        return Ok(());
    }
    create(
        state,
        CreateChannelRequest {
            name: if credential.email.is_empty() {
                "Codex".to_string()
            } else {
                credential.email.clone()
            },
            base_url: Some(state.config().codex_base_url.clone()),
            credential_id: credential.id.clone(),
            priority: None,
            weight: None,
            model_allowlist: None,
        },
    )
    .await?;
    Ok(())
}

pub async fn select(
    state: &AppState,
    api_key: &RelayApiKeyContext,
    model: &str,
) -> AppResult<SelectedChannel> {
    if !api_key.model_allowlist.is_empty()
        && !api_key.model_allowlist.iter().any(|item| item == model)
    {
        return Err(AppError::bad_request(
            "model_not_allowed",
            "API key cannot use this model",
        ));
    }
    let mut query = channels::Entity::find()
        .filter(channels::Column::Enabled.eq(1))
        .filter(channels::Column::Status.eq("healthy"))
        .order_by_asc(channels::Column::Priority)
        .order_by_desc(channels::Column::Weight);
    if !api_key.channel_allowlist.is_empty() {
        query = query.filter(channels::Column::Id.is_in(api_key.channel_allowlist.clone()));
    }
    let channel = query.one(&state.db().conn).await?;
    if let Some(channel) = channel {
        let channel_models = parse_string_list(&channel.model_allowlist_json);
        if !channel_models.is_empty() && !channel_models.iter().any(|item| item == model) {
            return Err(AppError::bad_request(
                "model_not_allowed",
                "Selected channel cannot use this model",
            ));
        }
        let credential_id = channel.credential_id.clone().ok_or_else(|| {
            AppError::bad_request("channel_missing_credential", "Channel has no credential")
        })?;
        let credential = credential_service::runtime_by_id(state, &credential_id).await?;
        return Ok(SelectedChannel {
            channel,
            credential,
        });
    }
    let credential = credential_service::first_enabled(state).await?;
    let channel = channels::Model {
        id: "virtual_default".to_string(),
        name: "Default Codex".to_string(),
        base_url: state.config().codex_base_url.clone(),
        credential_id: Some(credential.id.clone()),
        enabled: 1,
        priority: 100,
        weight: 1,
        model_allowlist_json: "[]".to_string(),
        status: "healthy".to_string(),
        health_score: 100,
        cooldown_until: None,
        last_error: None,
        last_used_at: None,
        created_at: Utc::now().to_rfc3339(),
        updated_at: Utc::now().to_rfc3339(),
    };
    Ok(SelectedChannel {
        channel,
        credential,
    })
}

pub async fn record_success(db: &Database, channel: &channels::Model) -> AppResult<()> {
    if channel.id == "virtual_default" {
        return Ok(());
    }
    let mut active: channels::ActiveModel = channel.clone().into();
    active.last_used_at = Set(Some(Utc::now().to_rfc3339()));
    active.status = Set("healthy".to_string());
    active.health_score = Set(100);
    active.update(&db.conn).await?;
    Ok(())
}

pub async fn record_failure(
    db: &Database,
    channel: &channels::Model,
    message: String,
) -> AppResult<()> {
    if channel.id == "virtual_default" {
        return Ok(());
    }
    let mut active: channels::ActiveModel = channel.clone().into();
    active.last_error = Set(Some(message));
    active.health_score = Set((channel.health_score - 10).max(0));
    active.update(&db.conn).await?;
    Ok(())
}

fn public(row: channels::Model) -> ChannelPublic {
    ChannelPublic {
        id: row.id,
        name: row.name,
        base_url: row.base_url,
        credential_id: row.credential_id,
        enabled: row.enabled != 0,
        priority: row.priority,
        weight: row.weight,
        model_allowlist: parse_string_list(&row.model_allowlist_json),
        status: row.status,
        health_score: row.health_score,
        last_error: row.last_error,
        created_at: row.created_at,
    }
}

fn json_string(value: &[String]) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "[]".to_string())
}

fn parse_string_list(value: &str) -> Vec<String> {
    serde_json::from_str::<Vec<String>>(value).unwrap_or_default()
}

fn clean_name(name: &str) -> String {
    let name = name.trim();
    if name.is_empty() {
        "Codex Channel".to_string()
    } else {
        name.to_string()
    }
}
