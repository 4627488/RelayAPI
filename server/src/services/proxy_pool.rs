use chrono::Utc;
use sea_orm::{ActiveModelTrait, EntityTrait, Set};
use serde::{Deserialize, Serialize};
use serde_json::json;
use uuid::Uuid;

use crate::{
    db::{entities::proxy_pool, Database},
    error::{AppError, AppResult},
    http::AppState,
    services::crypto,
};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CredentialProxy {
    pub enabled: bool,
    pub r#type: String,
    pub host: String,
    pub port: i32,
    pub username: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub password: Option<String>,
}

#[derive(Serialize)]
pub struct ProxyPoolPublic {
    pub id: String,
    pub name: String,
    pub r#type: String,
    pub host: String,
    pub port: i32,
    pub username: String,
    pub password_set: bool,
    pub enabled: bool,
    pub notes: String,
    pub created_at: String,
    pub updated_at: String,
    pub last_used_at: Option<String>,
}

#[derive(Deserialize)]
pub struct SaveProxyPoolRequest {
    pub name: String,
    pub r#type: Option<String>,
    pub host: String,
    pub port: i32,
    pub username: Option<String>,
    pub password: Option<String>,
    pub enabled: Option<bool>,
    pub notes: Option<String>,
}

pub async fn list(db: &Database) -> AppResult<Vec<ProxyPoolPublic>> {
    let rows = proxy_pool::Entity::find().all(&db.conn).await?;
    Ok(rows.into_iter().map(public).collect())
}

pub async fn create(state: &AppState, input: SaveProxyPoolRequest) -> AppResult<ProxyPoolPublic> {
    validate(&input)?;
    let now = Utc::now().to_rfc3339();
    let id = Uuid::new_v4().to_string();
    let active = proxy_pool::ActiveModel {
        id: Set(id.clone()),
        name: Set(clean(&input.name)),
        r#type: Set(normalize_type(input.r#type.as_deref())),
        host: Set(clean(&input.host)),
        port: Set(input.port),
        username: Set(input.username.unwrap_or_default()),
        password_ciphertext: Set(encrypt_password(state, input.password.as_deref())?),
        enabled: Set(if input.enabled.unwrap_or(true) { 1 } else { 0 }),
        notes: Set(input.notes.unwrap_or_default()),
        created_at: Set(now.clone()),
        updated_at: Set(now),
        last_used_at: Set(None),
    };
    proxy_pool::Entity::insert(active)
        .exec(&state.db().conn)
        .await?;
    let row = proxy_pool::Entity::find_by_id(id)
        .one(&state.db().conn)
        .await?
        .ok_or_else(|| AppError::bad_request("proxy_create_failed", "Proxy was not created"))?;
    Ok(public(row))
}

pub async fn patch(
    state: &AppState,
    id: &str,
    input: SaveProxyPoolRequest,
) -> AppResult<ProxyPoolPublic> {
    validate(&input)?;
    let row = proxy_pool::Entity::find_by_id(id.to_string())
        .one(&state.db().conn)
        .await?
        .ok_or_else(|| {
            AppError::bad_request("proxy_pool_not_found", "Proxy pool item not found")
        })?;
    let mut active: proxy_pool::ActiveModel = row.into();
    active.name = Set(clean(&input.name));
    active.r#type = Set(normalize_type(input.r#type.as_deref()));
    active.host = Set(clean(&input.host));
    active.port = Set(input.port);
    active.username = Set(input.username.unwrap_or_default());
    if input.password.is_some() {
        active.password_ciphertext = Set(encrypt_password(state, input.password.as_deref())?);
    }
    active.enabled = Set(if input.enabled.unwrap_or(true) { 1 } else { 0 });
    active.notes = Set(input.notes.unwrap_or_default());
    active.updated_at = Set(Utc::now().to_rfc3339());
    Ok(public(active.update(&state.db().conn).await?))
}

pub async fn delete(db: &Database, id: &str) -> AppResult<()> {
    proxy_pool::Entity::delete_by_id(id.to_string())
        .exec(&db.conn)
        .await?;
    Ok(())
}

pub fn proxy_url(proxy: &CredentialProxy) -> Option<String> {
    if !proxy.enabled || proxy.host.trim().is_empty() || proxy.port <= 0 {
        return None;
    }
    let auth = if proxy.username.is_empty() {
        String::new()
    } else {
        format!(
            "{}:{}@",
            proxy.username,
            proxy.password.as_deref().unwrap_or("")
        )
    };
    Some(format!(
        "{}://{}{}:{}",
        proxy.r#type, auth, proxy.host, proxy.port
    ))
}

fn public(row: proxy_pool::Model) -> ProxyPoolPublic {
    ProxyPoolPublic {
        id: row.id,
        name: row.name,
        r#type: row.r#type,
        host: row.host,
        port: row.port,
        username: row.username,
        password_set: row.password_ciphertext.is_some(),
        enabled: row.enabled != 0,
        notes: row.notes,
        created_at: row.created_at,
        updated_at: row.updated_at,
        last_used_at: row.last_used_at,
    }
}

fn validate(input: &SaveProxyPoolRequest) -> AppResult<()> {
    if clean(&input.name).is_empty() {
        return Err(AppError::bad_request(
            "invalid_proxy_name",
            "Proxy name is required",
        ));
    }
    if clean(&input.host).is_empty() {
        return Err(AppError::bad_request(
            "missing_proxy_host",
            "Proxy host is required",
        ));
    }
    if input.port < 1 || input.port > 65535 {
        return Err(AppError::bad_request(
            "invalid_proxy_port",
            "Proxy port must be between 1 and 65535",
        ));
    }
    Ok(())
}

fn normalize_type(value: Option<&str>) -> String {
    match value
        .unwrap_or("socks5h")
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "socks5" => "socks5".to_string(),
        _ => "socks5h".to_string(),
    }
}

fn encrypt_password(state: &AppState, password: Option<&str>) -> AppResult<Option<String>> {
    let Some(password) = password.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    Ok(Some(crypto::encrypt_json(
        &state.config().secret,
        &json!(password),
    )?))
}

fn clean(value: &str) -> String {
    value.trim().to_string()
}
