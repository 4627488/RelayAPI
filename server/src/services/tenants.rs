use axum::http::{header, HeaderMap, HeaderValue};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use chrono::{Duration, Utc};
use sea_orm::{ActiveModelTrait, ColumnTrait, EntityTrait, QueryFilter, Set};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::{
    db::{
        entities::{tenant_invites, tenant_users, tenants},
        Database,
    },
    error::{AppError, AppResult},
    http::AppState,
    services::crypto,
};

#[derive(Clone, Serialize)]
pub struct TenantPublic {
    pub id: String,
    pub name: String,
    pub owner_email: String,
    pub enabled: bool,
    pub max_api_keys: Option<i64>,
    pub token_limit_daily: Option<i64>,
    pub rate_limit_per_minute: Option<i64>,
    pub model_allowlist: Vec<String>,
    pub channel_allowlist: Vec<String>,
    pub allow_custom_proxy: bool,
    pub allow_custom_user_agent: bool,
    pub user_agent: Option<String>,
    pub expires_at: Option<String>,
    pub created_at: String,
    pub deleted_at: Option<String>,
}

#[derive(Clone)]
pub struct TenantSession {
    pub tenant_id: String,
    pub user_id: String,
    pub email: String,
}

#[derive(Deserialize)]
pub struct TenantPayload {
    pub name: String,
    pub owner_email: String,
    pub enabled: Option<bool>,
    pub max_api_keys: Option<i64>,
    pub token_limit_daily: Option<i64>,
    pub rate_limit_per_minute: Option<i64>,
    pub model_allowlist: Option<Vec<String>>,
    pub channel_allowlist: Option<Vec<String>>,
    pub allow_custom_proxy: Option<bool>,
    pub allow_custom_user_agent: Option<bool>,
    pub user_agent: Option<String>,
    pub expires_at: Option<String>,
}

#[derive(Deserialize)]
pub struct InviteRequest {
    pub email: Option<String>,
}

#[derive(Serialize)]
pub struct CreatedInvite {
    pub invite_id: String,
    pub token: String,
    pub activation_url: String,
    pub expires_at: String,
}

#[derive(Deserialize)]
pub struct ActivateRequest {
    pub token: String,
    pub password: String,
    pub display_name: Option<String>,
}

#[derive(Deserialize)]
pub struct LoginRequest {
    pub email: String,
    pub password: String,
}

pub async fn list(db: &Database) -> AppResult<Vec<TenantPublic>> {
    let rows = tenants::Entity::find().all(&db.conn).await?;
    Ok(rows.into_iter().map(public).collect())
}

pub async fn create(db: &Database, input: TenantPayload) -> AppResult<TenantPublic> {
    let now = Utc::now().to_rfc3339();
    let id = Uuid::new_v4().to_string();
    let active = tenants::ActiveModel {
        id: Set(id.clone()),
        name: Set(clean_or(&input.name, "Tenant")),
        owner_email: Set(clean(&input.owner_email)),
        enabled: Set(if input.enabled.unwrap_or(true) { 1 } else { 0 }),
        max_api_keys: Set(input.max_api_keys),
        token_limit_daily: Set(input.token_limit_daily),
        rate_limit_per_minute: Set(input.rate_limit_per_minute),
        model_allowlist_json: Set(json_string(&input.model_allowlist.unwrap_or_default())),
        channel_allowlist_json: Set(json_string(&input.channel_allowlist.unwrap_or_default())),
        allow_custom_proxy: Set(if input.allow_custom_proxy.unwrap_or(false) {
            1
        } else {
            0
        }),
        allow_custom_user_agent: Set(if input.allow_custom_user_agent.unwrap_or(false) {
            1
        } else {
            0
        }),
        proxy_json: Set(None),
        user_agent: Set(input.user_agent.filter(|v| !v.trim().is_empty())),
        expires_at: Set(input.expires_at),
        metadata_json: Set("{}".to_string()),
        created_at: Set(now.clone()),
        updated_at: Set(now),
        deleted_at: Set(None),
    };
    tenants::Entity::insert(active).exec(&db.conn).await?;
    let row = tenants::Entity::find_by_id(id)
        .one(&db.conn)
        .await?
        .ok_or_else(|| AppError::bad_request("tenant_create_failed", "Tenant was not created"))?;
    Ok(public(row))
}

pub async fn patch(db: &Database, id: &str, input: TenantPayload) -> AppResult<TenantPublic> {
    let row = tenants::Entity::find_by_id(id.to_string())
        .one(&db.conn)
        .await?
        .ok_or_else(|| AppError::bad_request("tenant_not_found", "Tenant not found"))?;
    let mut active: tenants::ActiveModel = row.into();
    active.name = Set(clean_or(&input.name, "Tenant"));
    active.owner_email = Set(clean(&input.owner_email));
    active.enabled = Set(if input.enabled.unwrap_or(true) { 1 } else { 0 });
    active.max_api_keys = Set(input.max_api_keys);
    active.token_limit_daily = Set(input.token_limit_daily);
    active.rate_limit_per_minute = Set(input.rate_limit_per_minute);
    active.model_allowlist_json = Set(json_string(&input.model_allowlist.unwrap_or_default()));
    active.channel_allowlist_json = Set(json_string(&input.channel_allowlist.unwrap_or_default()));
    active.allow_custom_proxy = Set(if input.allow_custom_proxy.unwrap_or(false) {
        1
    } else {
        0
    });
    active.allow_custom_user_agent = Set(if input.allow_custom_user_agent.unwrap_or(false) {
        1
    } else {
        0
    });
    active.user_agent = Set(input.user_agent.filter(|v| !v.trim().is_empty()));
    active.expires_at = Set(input.expires_at);
    active.updated_at = Set(Utc::now().to_rfc3339());
    Ok(public(active.update(&db.conn).await?))
}

pub async fn delete(db: &Database, id: &str) -> AppResult<()> {
    let row = tenants::Entity::find_by_id(id.to_string())
        .one(&db.conn)
        .await?
        .ok_or_else(|| AppError::bad_request("tenant_not_found", "Tenant not found"))?;
    let mut active: tenants::ActiveModel = row.into();
    active.enabled = Set(0);
    active.deleted_at = Set(Some(Utc::now().to_rfc3339()));
    active.updated_at = Set(Utc::now().to_rfc3339());
    active.update(&db.conn).await?;
    Ok(())
}

pub async fn invite(
    state: &AppState,
    tenant_id: &str,
    input: InviteRequest,
) -> AppResult<CreatedInvite> {
    let tenant = tenants::Entity::find_by_id(tenant_id.to_string())
        .one(&state.db().conn)
        .await?
        .ok_or_else(|| AppError::bad_request("tenant_not_found", "Tenant not found"))?;
    let email = input.email.unwrap_or(tenant.owner_email);
    let token = format!("relay_invite_{}", crypto::random_urlsafe(32));
    let now = Utc::now();
    let expires = now + Duration::days(7);
    let id = Uuid::new_v4().to_string();
    tenant_invites::Entity::insert(tenant_invites::ActiveModel {
        id: Set(id.clone()),
        tenant_id: Set(tenant_id.to_string()),
        user_id: Set(Uuid::new_v4().to_string()),
        email: Set(email),
        token_hash: Set(crypto::hash_secret(&token)),
        expires_at: Set(expires.to_rfc3339()),
        accepted_at: Set(None),
        revoked_at: Set(None),
        created_at: Set(now.to_rfc3339()),
        updated_at: Set(now.to_rfc3339()),
    })
    .exec(&state.db().conn)
    .await?;
    Ok(CreatedInvite {
        invite_id: id,
        token: token.clone(),
        activation_url: format!("/tenant/activate?token={token}"),
        expires_at: expires.to_rfc3339(),
    })
}

pub async fn activate(state: &AppState, input: ActivateRequest) -> AppResult<HeaderValue> {
    if input.password.len() < 8 {
        return Err(AppError::bad_request(
            "weak_password",
            "Password must be at least 8 characters",
        ));
    }
    let token_hash = crypto::hash_secret(&input.token);
    let invite = tenant_invites::Entity::find()
        .filter(tenant_invites::Column::TokenHash.eq(token_hash))
        .one(&state.db().conn)
        .await?
        .ok_or_else(|| AppError::bad_request("invalid_invite", "Invalid invite token"))?;
    validate_invite(&invite)?;
    let tenant = tenants::Entity::find_by_id(invite.tenant_id.clone())
        .one(&state.db().conn)
        .await?
        .ok_or_else(|| AppError::bad_request("tenant_not_found", "Tenant not found"))?;
    validate_tenant(&tenant)?;
    let user_id = invite.user_id.clone();
    let now = Utc::now().to_rfc3339();
    tenant_users::Entity::insert(tenant_users::ActiveModel {
        id: Set(user_id.clone()),
        tenant_id: Set(invite.tenant_id.clone()),
        email: Set(invite.email.clone()),
        display_name: Set(input.display_name.unwrap_or_default()),
        role: Set("owner".to_string()),
        enabled: Set(1),
        password_hash: Set(Some(password_hash(&input.password))),
        last_login_at: Set(Some(now.clone())),
        created_at: Set(now.clone()),
        updated_at: Set(now.clone()),
    })
    .exec(&state.db().conn)
    .await?;
    let tenant_id = invite.tenant_id.clone();
    let email = invite.email.clone();
    let mut active: tenant_invites::ActiveModel = invite.into();
    active.accepted_at = Set(Some(now));
    active.update(&state.db().conn).await?;
    session_cookie(state, &tenant_id, &user_id, &email)
}

pub async fn login(state: &AppState, input: LoginRequest) -> AppResult<HeaderValue> {
    let user = tenant_users::Entity::find()
        .filter(tenant_users::Column::Email.eq(clean(&input.email)))
        .one(&state.db().conn)
        .await?
        .ok_or_else(|| AppError::unauthorized("Invalid tenant login"))?;
    if user.enabled == 0
        || user.password_hash.as_deref() != Some(password_hash(&input.password).as_str())
    {
        return Err(AppError::unauthorized("Invalid tenant login"));
    }
    let tenant = tenants::Entity::find_by_id(user.tenant_id.clone())
        .one(&state.db().conn)
        .await?
        .ok_or_else(|| AppError::unauthorized("Tenant is unavailable"))?;
    validate_tenant(&tenant)?;
    session_cookie(state, &user.tenant_id, &user.id, &user.email)
}

pub async fn require(state: &AppState, headers: &HeaderMap) -> AppResult<TenantSession> {
    let raw = cookie(headers, "relay_tenant_session")
        .ok_or_else(|| AppError::unauthorized("Tenant session required"))?;
    let value = String::from_utf8(URL_SAFE_NO_PAD.decode(raw).map_err(anyhow::Error::from)?)
        .map_err(anyhow::Error::from)?;
    let mut parts = value.split('|');
    let tenant_id = parts.next().unwrap_or_default();
    let user_id = parts.next().unwrap_or_default();
    let email = parts.next().unwrap_or_default();
    let sig = parts.next().unwrap_or_default();
    let expected = crypto::hash_secret(&format!(
        "{tenant_id}|{user_id}|{email}|{}",
        state.config().secret
    ));
    if sig != expected || tenant_id.is_empty() || user_id.is_empty() {
        return Err(AppError::unauthorized("Invalid tenant session"));
    }
    let user = tenant_users::Entity::find_by_id(user_id.to_string())
        .one(&state.db().conn)
        .await?
        .ok_or_else(|| AppError::unauthorized("Invalid tenant session"))?;
    if user.tenant_id != tenant_id || user.email != email || user.enabled == 0 {
        return Err(AppError::unauthorized("Invalid tenant session"));
    }
    let tenant = tenants::Entity::find_by_id(tenant_id.to_string())
        .one(&state.db().conn)
        .await?
        .ok_or_else(|| AppError::unauthorized("Tenant is unavailable"))?;
    validate_tenant(&tenant)?;
    Ok(TenantSession {
        tenant_id: tenant_id.to_string(),
        user_id: user_id.to_string(),
        email: email.to_string(),
    })
}

pub fn expired_cookie(secure: bool) -> HeaderValue {
    HeaderValue::from_str(&format!(
        "relay_tenant_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0{}",
        if secure { "; Secure" } else { "" }
    ))
    .unwrap_or_else(|_| {
        HeaderValue::from_static("relay_tenant_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0")
    })
}

pub async fn resources(state: &AppState, session: &TenantSession) -> AppResult<Value> {
    let tenant = tenants::Entity::find_by_id(session.tenant_id.clone())
        .one(&state.db().conn)
        .await?
        .ok_or_else(|| AppError::bad_request("tenant_not_found", "Tenant not found"))?;
    Ok(
        json!({ "tenant": public(tenant), "user": { "id": session.user_id, "email": session.email } }),
    )
}

fn session_cookie(
    state: &AppState,
    tenant_id: &str,
    user_id: &str,
    email: &str,
) -> AppResult<HeaderValue> {
    let sig = crypto::hash_secret(&format!(
        "{tenant_id}|{user_id}|{email}|{}",
        state.config().secret
    ));
    let raw = format!("{tenant_id}|{user_id}|{email}|{sig}");
    let encoded = URL_SAFE_NO_PAD.encode(raw);
    HeaderValue::from_str(&format!(
        "relay_tenant_session={encoded}; Path=/; HttpOnly; SameSite=Lax{}",
        if state.config().secure_cookies {
            "; Secure"
        } else {
            ""
        }
    ))
    .map_err(anyhow::Error::from)
    .map_err(AppError::from)
}

fn public(row: tenants::Model) -> TenantPublic {
    TenantPublic {
        id: row.id,
        name: row.name,
        owner_email: row.owner_email,
        enabled: row.enabled != 0,
        max_api_keys: row.max_api_keys,
        token_limit_daily: row.token_limit_daily,
        rate_limit_per_minute: row.rate_limit_per_minute,
        model_allowlist: parse_list(&row.model_allowlist_json),
        channel_allowlist: parse_list(&row.channel_allowlist_json),
        allow_custom_proxy: row.allow_custom_proxy != 0,
        allow_custom_user_agent: row.allow_custom_user_agent != 0,
        user_agent: row.user_agent,
        expires_at: row.expires_at,
        created_at: row.created_at,
        deleted_at: row.deleted_at,
    }
}

fn validate_tenant(row: &tenants::Model) -> AppResult<()> {
    if row.enabled == 0 || row.deleted_at.is_some() {
        return Err(AppError::unauthorized("Tenant is disabled"));
    }
    if let Some(expires_at) = &row.expires_at {
        if chrono::DateTime::parse_from_rfc3339(expires_at)
            .map(|value| value.with_timezone(&Utc) <= Utc::now())
            .unwrap_or(false)
        {
            return Err(AppError::unauthorized("Tenant has expired"));
        }
    }
    Ok(())
}

fn validate_invite(row: &tenant_invites::Model) -> AppResult<()> {
    if row.accepted_at.is_some() || row.revoked_at.is_some() {
        return Err(AppError::bad_request(
            "invalid_invite",
            "Invite is no longer valid",
        ));
    }
    if chrono::DateTime::parse_from_rfc3339(&row.expires_at)
        .map(|value| value.with_timezone(&Utc) <= Utc::now())
        .unwrap_or(true)
    {
        return Err(AppError::bad_request(
            "invite_expired",
            "Invite has expired",
        ));
    }
    Ok(())
}

fn password_hash(password: &str) -> String {
    crypto::hash_secret(password)
}

fn cookie<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers
        .get(header::COOKIE)
        .and_then(|v| v.to_str().ok())?
        .split(';')
        .filter_map(|part| part.trim().split_once('='))
        .find_map(|(key, value)| (key == name).then_some(value))
}

fn clean(value: &str) -> String {
    value.trim().to_string()
}
fn clean_or(value: &str, fallback: &str) -> String {
    let value = clean(value);
    if value.is_empty() {
        fallback.to_string()
    } else {
        value
    }
}
fn json_string(value: &[String]) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "[]".to_string())
}
fn parse_list(value: &str) -> Vec<String> {
    serde_json::from_str(value).unwrap_or_default()
}
