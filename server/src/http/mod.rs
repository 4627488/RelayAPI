use std::sync::Arc;

use axum::{
    extract::{Path, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, patch, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::{
    config::Config,
    db::Database,
    error::AppResult,
    services::{self, admin_auth},
    upstream::codex,
};

#[derive(Clone)]
pub struct AppState(Arc<AppStateInner>);

struct AppStateInner {
    config: Config,
    db: Database,
    http: reqwest::Client,
}

impl AppState {
    pub fn new(config: Config, db: Database) -> Self {
        Self(Arc::new(AppStateInner {
            config,
            db,
            http: reqwest::Client::new(),
        }))
    }

    pub fn config(&self) -> &Config {
        &self.0.config
    }
    pub fn db(&self) -> &Database {
        &self.0.db
    }
    pub fn http(&self) -> &reqwest::Client {
        &self.0.http
    }
}

pub fn routes(state: AppState) -> Router {
    Router::new()
        .route("/api/health", get(health))
        .route("/api/auth/web-login", post(web_login))
        .route("/api/auth/web-logout", post(web_logout))
        .route("/api/auth/web-session", get(web_session))
        .route("/api/admin/overview", get(admin_overview))
        .route(
            "/api/admin/api-keys",
            get(list_api_keys).post(create_api_key),
        )
        .route(
            "/api/admin/api-keys/{id}",
            patch(patch_api_key).delete(delete_api_key),
        )
        .route("/api/admin/codex/credentials", get(list_credentials))
        .route(
            "/api/admin/codex/credentials/import",
            post(import_credential),
        )
        .route(
            "/api/admin/codex/credentials/{id}",
            patch(patch_credential).delete(delete_credential),
        )
        .route(
            "/api/admin/codex/credentials/{id}/refresh",
            post(refresh_credential),
        )
        .route(
            "/api/admin/codex/credentials/{id}/export",
            get(export_credential),
        )
        .route(
            "/api/admin/codex/credentials/export",
            get(export_credentials),
        )
        .route(
            "/api/admin/codex/credentials/{id}/quota",
            get(get_credential_quota),
        )
        .route(
            "/api/admin/channels",
            get(list_channels).post(create_channel),
        )
        .route(
            "/api/admin/channels/{id}",
            patch(patch_channel).delete(delete_channel),
        )
        .route(
            "/api/admin/proxy-pool",
            get(list_proxy_pool).post(create_proxy_pool),
        )
        .route(
            "/api/admin/proxy-pool/{id}",
            patch(patch_proxy_pool).delete(delete_proxy_pool),
        )
        .route("/api/admin/tenants", get(list_tenants).post(create_tenant))
        .route(
            "/api/admin/tenants/{id}",
            patch(patch_tenant).delete(delete_tenant),
        )
        .route("/api/admin/tenants/{id}/invite", post(create_tenant_invite))
        .route("/api/admin/request-logs", get(list_logs))
        .route(
            "/api/admin/settings",
            get(get_settings).patch(patch_settings),
        )
        .route(
            "/api/admin/codex/credentials/oauth/start",
            post(start_oauth),
        )
        .route(
            "/api/admin/codex/credentials/oauth/callback",
            post(finish_oauth),
        )
        .route("/auth/callback", get(oauth_callback_page))
        .route("/api/activity.svg", get(activity_svg))
        .route("/api/tenant/auth/activate", post(tenant_activate))
        .route("/api/tenant/auth/login", post(tenant_login))
        .route("/api/tenant/auth/logout", post(tenant_logout))
        .route("/api/tenant/profile", get(tenant_profile))
        .route("/api/tenant/resources", get(tenant_resources))
        .route(
            "/api/tenant/settings",
            get(tenant_settings).patch(tenant_patch_settings),
        )
        .route(
            "/api/tenant/api-keys",
            get(tenant_api_keys).post(tenant_create_api_key),
        )
        .route(
            "/api/tenant/api-keys/{id}",
            patch(tenant_patch_api_key).delete(tenant_delete_api_key),
        )
        .route("/api/tenant/overview", get(tenant_overview))
        .route("/api/tenant/request-logs", get(tenant_logs))
        .route(
            "/api/tenant/codex/credentials/{id}/quota",
            get(tenant_quota),
        )
        .route("/v1/models", get(models))
        .route("/v1/responses", post(responses))
        .route("/v1/responses/compact", post(responses_compact))
        .route("/v1/chat/completions", post(chat_completions))
        .route("/v1/images/generations", post(image_generations))
        .route("/v1/images/edits", post(image_edits))
        .route("/api/codex/responses", post(raw_codex_responses))
        .route(
            "/api/codex/responses/compact",
            post(raw_codex_responses_compact),
        )
        .route("/backend-api/codex/responses", post(raw_codex_responses))
        .route(
            "/backend-api/codex/responses/compact",
            post(raw_codex_responses_compact),
        )
        .route("/api/admin/{section}", get(admin_placeholder))
        .with_state(state)
}

async fn health(State(state): State<AppState>) -> AppResult<Json<Value>> {
    state.db().conn.ping().await?;
    Ok(Json(json!({
        "ok": true,
        "service": "relay-api-server",
        "data_dir": state.config().data_dir,
    })))
}

async fn web_login(
    State(state): State<AppState>,
    Json(input): Json<admin_auth::WebLoginRequest>,
) -> AppResult<Response> {
    let cookie = admin_auth::login(&state, input)?;
    Ok((
        StatusCode::OK,
        [(header::SET_COOKIE, cookie)],
        Json(json!({ "ok": true })),
    )
        .into_response())
}

async fn web_logout() -> Response {
    (
        StatusCode::OK,
        [(
            header::SET_COOKIE,
            "relay_web_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0",
        )],
        Json(json!({ "ok": true })),
    )
        .into_response()
}

async fn web_session(State(state): State<AppState>, headers: HeaderMap) -> Json<Value> {
    Json(json!({ "authenticated": admin_auth::require_admin(&state, &headers).is_ok() }))
}

async fn admin_overview(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> AppResult<Json<Value>> {
    admin_auth::require_admin(&state, &headers)?;
    let counts = services::overview::counts(state.db()).await?;
    Ok(Json(json!({ "counts": counts })))
}

async fn admin_placeholder(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(section): Path<String>,
) -> AppResult<Json<Value>> {
    admin_auth::require_admin(&state, &headers)?;
    Ok(Json(
        json!({ "section": section, "items": [], "status": "not_implemented" }),
    ))
}

async fn list_api_keys(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> AppResult<Json<Value>> {
    admin_auth::require_admin(&state, &headers)?;
    Ok(Json(json!(services::api_keys::list(state.db()).await?)))
}

async fn create_api_key(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<services::api_keys::CreateApiKeyRequest>,
) -> AppResult<Json<Value>> {
    admin_auth::require_admin(&state, &headers)?;
    Ok(Json(json!(
        services::api_keys::create(state.db(), input).await?
    )))
}

async fn delete_api_key(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> AppResult<Json<Value>> {
    admin_auth::require_admin(&state, &headers)?;
    services::api_keys::delete(state.db(), &id).await?;
    Ok(Json(json!({ "ok": true })))
}

async fn patch_api_key(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(input): Json<services::api_keys::PatchApiKeyRequest>,
) -> AppResult<Json<Value>> {
    admin_auth::require_admin(&state, &headers)?;
    Ok(Json(json!(
        services::api_keys::patch(state.db(), &id, input).await?
    )))
}

async fn list_credentials(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> AppResult<Json<Value>> {
    admin_auth::require_admin(&state, &headers)?;
    Ok(Json(json!(
        services::codex_credentials::list(state.db()).await?
    )))
}

async fn import_credential(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<services::codex_credentials::ImportCredentialRequest>,
) -> AppResult<Json<Value>> {
    admin_auth::require_admin(&state, &headers)?;
    Ok(Json(json!(
        services::codex_credentials::import_tokens(&state, input).await?
    )))
}

async fn delete_credential(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> AppResult<Json<Value>> {
    admin_auth::require_admin(&state, &headers)?;
    services::codex_credentials::delete(state.db(), &id).await?;
    Ok(Json(json!({ "ok": true })))
}

async fn patch_credential(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(input): Json<services::codex_credentials::PatchCredentialRequest>,
) -> AppResult<Json<Value>> {
    admin_auth::require_admin(&state, &headers)?;
    Ok(Json(json!(
        services::codex_credentials::patch(&state, &id, input).await?
    )))
}

async fn refresh_credential(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> AppResult<Json<Value>> {
    admin_auth::require_admin(&state, &headers)?;
    Ok(Json(json!(
        services::codex_credentials::refresh(&state, &id).await?
    )))
}

async fn export_credential(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> AppResult<Json<Value>> {
    admin_auth::require_admin(&state, &headers)?;
    Ok(Json(
        services::codex_credentials::export(&state, Some(&id)).await?,
    ))
}

async fn export_credentials(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> AppResult<Json<Value>> {
    admin_auth::require_admin(&state, &headers)?;
    Ok(Json(
        services::codex_credentials::export(&state, None).await?,
    ))
}

async fn get_credential_quota(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> AppResult<Json<Value>> {
    admin_auth::require_admin(&state, &headers)?;
    Ok(Json(services::codex_quota::get(&state, &id, true).await?))
}

async fn list_channels(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> AppResult<Json<Value>> {
    admin_auth::require_admin(&state, &headers)?;
    Ok(Json(json!(services::channels::list(state.db()).await?)))
}

async fn create_channel(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<services::channels::CreateChannelRequest>,
) -> AppResult<Json<Value>> {
    admin_auth::require_admin(&state, &headers)?;
    Ok(Json(json!(
        services::channels::create(&state, input).await?
    )))
}

async fn delete_channel(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> AppResult<Json<Value>> {
    admin_auth::require_admin(&state, &headers)?;
    services::channels::delete(state.db(), &id).await?;
    Ok(Json(json!({ "ok": true })))
}

async fn patch_channel(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(input): Json<services::channels::PatchChannelRequest>,
) -> AppResult<Json<Value>> {
    admin_auth::require_admin(&state, &headers)?;
    Ok(Json(json!(
        services::channels::patch(&state, &id, input).await?
    )))
}

async fn list_proxy_pool(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> AppResult<Json<Value>> {
    admin_auth::require_admin(&state, &headers)?;
    Ok(Json(json!(services::proxy_pool::list(state.db()).await?)))
}

async fn create_proxy_pool(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<services::proxy_pool::SaveProxyPoolRequest>,
) -> AppResult<Json<Value>> {
    admin_auth::require_admin(&state, &headers)?;
    Ok(Json(json!(
        services::proxy_pool::create(&state, input).await?
    )))
}

async fn patch_proxy_pool(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(input): Json<services::proxy_pool::SaveProxyPoolRequest>,
) -> AppResult<Json<Value>> {
    admin_auth::require_admin(&state, &headers)?;
    Ok(Json(json!(
        services::proxy_pool::patch(&state, &id, input).await?
    )))
}

async fn delete_proxy_pool(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> AppResult<Json<Value>> {
    admin_auth::require_admin(&state, &headers)?;
    services::proxy_pool::delete(state.db(), &id).await?;
    Ok(Json(json!({ "ok": true })))
}

async fn list_tenants(State(state): State<AppState>, headers: HeaderMap) -> AppResult<Json<Value>> {
    admin_auth::require_admin(&state, &headers)?;
    Ok(Json(json!(services::tenants::list(state.db()).await?)))
}

async fn create_tenant(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<services::tenants::TenantPayload>,
) -> AppResult<Json<Value>> {
    admin_auth::require_admin(&state, &headers)?;
    Ok(Json(json!(
        services::tenants::create(state.db(), input).await?
    )))
}

async fn patch_tenant(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(input): Json<services::tenants::TenantPayload>,
) -> AppResult<Json<Value>> {
    admin_auth::require_admin(&state, &headers)?;
    Ok(Json(json!(
        services::tenants::patch(state.db(), &id, input).await?
    )))
}

async fn delete_tenant(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> AppResult<Json<Value>> {
    admin_auth::require_admin(&state, &headers)?;
    services::tenants::delete(state.db(), &id).await?;
    Ok(Json(json!({ "ok": true })))
}

async fn create_tenant_invite(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(input): Json<services::tenants::InviteRequest>,
) -> AppResult<Json<Value>> {
    admin_auth::require_admin(&state, &headers)?;
    Ok(Json(json!(
        services::tenants::invite(&state, &id, input).await?
    )))
}

async fn tenant_activate(
    State(state): State<AppState>,
    Json(input): Json<services::tenants::ActivateRequest>,
) -> AppResult<Response> {
    let cookie = services::tenants::activate(&state, input).await?;
    Ok((
        StatusCode::OK,
        [(header::SET_COOKIE, cookie)],
        Json(json!({ "ok": true })),
    )
        .into_response())
}

async fn tenant_login(
    State(state): State<AppState>,
    Json(input): Json<services::tenants::LoginRequest>,
) -> AppResult<Response> {
    let cookie = services::tenants::login(&state, input).await?;
    Ok((
        StatusCode::OK,
        [(header::SET_COOKIE, cookie)],
        Json(json!({ "ok": true })),
    )
        .into_response())
}

async fn tenant_logout() -> Response {
    (
        StatusCode::OK,
        [(header::SET_COOKIE, services::tenants::expired_cookie())],
        Json(json!({ "ok": true })),
    )
        .into_response()
}

async fn tenant_profile(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> AppResult<Json<Value>> {
    let session = services::tenants::require(&state, &headers)?;
    Ok(Json(
        json!({ "tenant_id": session.tenant_id, "user_id": session.user_id, "email": session.email }),
    ))
}

async fn tenant_resources(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> AppResult<Json<Value>> {
    let session = services::tenants::require(&state, &headers)?;
    Ok(Json(services::tenants::resources(&state, &session).await?))
}

async fn tenant_settings(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> AppResult<Json<Value>> {
    tenant_resources(State(state), headers).await
}

async fn tenant_patch_settings(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(_input): Json<Value>,
) -> AppResult<Json<Value>> {
    let session = services::tenants::require(&state, &headers)?;
    Ok(Json(services::tenants::resources(&state, &session).await?))
}

async fn tenant_api_keys(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> AppResult<Json<Value>> {
    let session = services::tenants::require(&state, &headers)?;
    Ok(Json(json!(
        services::api_keys::list_for_tenant(state.db(), &session.tenant_id).await?
    )))
}

async fn tenant_create_api_key(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<services::api_keys::CreateApiKeyRequest>,
) -> AppResult<Json<Value>> {
    let session = services::tenants::require(&state, &headers)?;
    Ok(Json(json!(
        services::api_keys::create_for_tenant(state.db(), &session.tenant_id, input).await?
    )))
}

async fn tenant_patch_api_key(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(input): Json<services::api_keys::PatchApiKeyRequest>,
) -> AppResult<Json<Value>> {
    let session = services::tenants::require(&state, &headers)?;
    Ok(Json(json!(
        services::api_keys::patch_for_tenant(state.db(), &session.tenant_id, &id, input).await?
    )))
}

async fn tenant_delete_api_key(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> AppResult<Json<Value>> {
    let session = services::tenants::require(&state, &headers)?;
    services::api_keys::delete_for_tenant(state.db(), &session.tenant_id, &id).await?;
    Ok(Json(json!({ "ok": true })))
}

async fn tenant_overview(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> AppResult<Json<Value>> {
    let _session = services::tenants::require(&state, &headers)?;
    let counts = services::overview::counts(state.db()).await?;
    Ok(Json(json!({ "counts": counts })))
}

async fn tenant_logs(State(state): State<AppState>, headers: HeaderMap) -> AppResult<Json<Value>> {
    let _session = services::tenants::require(&state, &headers)?;
    Ok(Json(json!(services::logs::recent(state.db(), 200).await?)))
}

async fn tenant_quota(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> AppResult<Json<Value>> {
    let _session = services::tenants::require(&state, &headers)?;
    Ok(Json(services::codex_quota::get(&state, &id, true).await?))
}

async fn list_logs(State(state): State<AppState>, headers: HeaderMap) -> AppResult<Json<Value>> {
    admin_auth::require_admin(&state, &headers)?;
    Ok(Json(json!(services::logs::recent(state.db(), 200).await?)))
}

async fn get_settings(State(state): State<AppState>, headers: HeaderMap) -> AppResult<Json<Value>> {
    admin_auth::require_admin(&state, &headers)?;
    Ok(Json(json!(
        services::settings::admin_settings(&state).await?
    )))
}

async fn patch_settings(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<services::settings::PatchSettingsRequest>,
) -> AppResult<Json<Value>> {
    admin_auth::require_admin(&state, &headers)?;
    Ok(Json(json!(services::settings::patch(&state, input).await?)))
}

#[derive(Deserialize)]
struct StartOAuthRequest {
    redirect_uri: Option<String>,
}

async fn start_oauth(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<StartOAuthRequest>,
) -> AppResult<Json<Value>> {
    admin_auth::require_admin(&state, &headers)?;
    let session = codex::oauth::start(&state, input.redirect_uri).await?;
    Ok(Json(json!(session)))
}

#[derive(Deserialize)]
struct FinishOAuthRequest {
    callback_url: String,
}

async fn finish_oauth(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<FinishOAuthRequest>,
) -> AppResult<Json<Value>> {
    admin_auth::require_admin(&state, &headers)?;
    let params = codex::oauth::parse_callback_input(&input.callback_url)?;
    let tokens = codex::oauth::finish(&state, params).await?;
    Ok(Json(json!({ "ok": true, "credential": tokens })))
}

async fn oauth_callback_page(headers: HeaderMap) -> AppResult<Response> {
    let location = headers
        .get("referer")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    Ok((StatusCode::OK, [("content-type", "text/plain; charset=utf-8")], format!("Codex OAuth callback received. Return to RelayAPI and paste this callback URL if needed.\n{location}")).into_response())
}

async fn activity_svg(State(state): State<AppState>) -> AppResult<Response> {
    let counts = services::overview::counts(state.db()).await?;
    let svg = format!(
        r##"<svg xmlns="http://www.w3.org/2000/svg" width="520" height="120" viewBox="0 0 520 120"><rect width="520" height="120" rx="18" fill="#08111f"/><text x="24" y="42" fill="#e5edf5" font-family="Arial" font-size="22" font-weight="700">RelayAPI Activity</text><text x="24" y="78" fill="#60d5ff" font-family="Arial" font-size="16">requests: {} · keys: {} · channels: {} · credentials: {}</text></svg>"##,
        counts.request_logs, counts.api_keys, counts.channels, counts.codex_credentials
    );
    Ok((
        StatusCode::OK,
        [("content-type", "image/svg+xml; charset=utf-8")],
        svg,
    )
        .into_response())
}

async fn models(State(state): State<AppState>) -> Json<Value> {
    Json(codex::models::models_response(
        &state.config().codex_default_model,
    ))
}

async fn responses(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> AppResult<Response> {
    codex::relay::forward_responses(&state, headers, body, "/responses").await
}

async fn responses_compact(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> AppResult<Response> {
    codex::relay::forward_responses(&state, headers, body, "/responses/compact").await
}

async fn raw_codex_responses(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> AppResult<Response> {
    codex::relay::forward_responses(&state, headers, body, "/responses").await
}

async fn raw_codex_responses_compact(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> AppResult<Response> {
    codex::relay::forward_responses(&state, headers, body, "/responses/compact").await
}

async fn chat_completions(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> AppResult<Response> {
    let payload = codex::chat::chat_to_responses(body, &state.config().codex_default_model)?;
    codex::relay::forward_chat_completion(&state, headers, payload).await
}

async fn image_generations(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> AppResult<Response> {
    let response_format = codex::images::response_format(&body);
    let payload = codex::images::generation_to_responses(body)?;
    codex::relay::forward_images(
        &state,
        headers,
        payload,
        response_format,
        "image_generation",
        "images.generations",
    )
    .await
}

async fn image_edits(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> AppResult<Response> {
    let response_format = codex::images::response_format(&body);
    let payload = codex::images::edit_to_responses(body)?;
    codex::relay::forward_images(
        &state,
        headers,
        payload,
        response_format,
        "image_edit",
        "images.edits",
    )
    .await
}
