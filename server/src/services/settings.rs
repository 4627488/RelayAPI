use chrono::Utc;
use sea_orm::{ColumnTrait, EntityTrait, QueryFilter, Set};
use serde::{Deserialize, Serialize};

use crate::{
    db::{entities::app_settings, Database},
    error::AppResult,
    http::AppState,
};

const CODEX_USER_AGENT: &str = "codex_user_agent";

#[derive(Serialize)]
pub struct AdminSettings {
    pub codex_base_url: String,
    pub codex_default_model: String,
    pub codex_user_agent: String,
    pub codex_user_agent_source: String,
}

#[derive(Deserialize)]
pub struct PatchSettingsRequest {
    pub codex_user_agent: Option<String>,
}

pub async fn admin_settings(state: &AppState) -> AppResult<AdminSettings> {
    let configured_user_agent = get(state.db(), CODEX_USER_AGENT).await?;
    Ok(AdminSettings {
        codex_base_url: state.config().codex_base_url.clone(),
        codex_default_model: state.config().codex_default_model.clone(),
        codex_user_agent: configured_user_agent
            .clone()
            .unwrap_or_else(|| state.config().codex_user_agent.clone()),
        codex_user_agent_source: if configured_user_agent.is_some() {
            "database".to_string()
        } else {
            "environment".to_string()
        },
    })
}

pub async fn patch(state: &AppState, input: PatchSettingsRequest) -> AppResult<AdminSettings> {
    if let Some(user_agent) = input.codex_user_agent {
        let trimmed = user_agent.trim();
        if trimmed.is_empty() {
            delete(state.db(), CODEX_USER_AGENT).await?;
        } else {
            upsert(state.db(), CODEX_USER_AGENT, trimmed).await?;
        }
    }
    admin_settings(state).await
}

pub async fn codex_user_agent(state: &AppState) -> AppResult<String> {
    Ok(get(state.db(), CODEX_USER_AGENT)
        .await?
        .unwrap_or_else(|| state.config().codex_user_agent.clone()))
}

async fn get(db: &Database, key: &str) -> Result<Option<String>, sea_orm::DbErr> {
    Ok(app_settings::Entity::find()
        .filter(app_settings::Column::Key.eq(key))
        .one(&db.conn)
        .await?
        .map(|row| row.value))
}

async fn upsert(db: &Database, key: &str, value: &str) -> Result<(), sea_orm::DbErr> {
    let active = app_settings::ActiveModel {
        key: Set(key.to_string()),
        value: Set(value.to_string()),
        updated_at: Set(Utc::now().to_rfc3339()),
    };
    app_settings::Entity::insert(active)
        .on_conflict(
            sea_orm::sea_query::OnConflict::column(app_settings::Column::Key)
                .update_columns([app_settings::Column::Value, app_settings::Column::UpdatedAt])
                .to_owned(),
        )
        .exec(&db.conn)
        .await?;
    Ok(())
}

async fn delete(db: &Database, key: &str) -> Result<(), sea_orm::DbErr> {
    app_settings::Entity::delete_by_id(key.to_string())
        .exec(&db.conn)
        .await?;
    Ok(())
}
