use axum::http::StatusCode;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use chrono::{Duration, Utc};
use rand::{rngs::OsRng, RngCore};
use sea_orm::{ColumnTrait, EntityTrait, QueryFilter, Set};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use url::{form_urlencoded, Url};

use crate::{
    db::entities::oauth_pending_states,
    error::{AppError, AppResult},
    http::AppState,
    services::codex_credentials,
};

const AUTH_URL: &str = "https://auth.openai.com/oauth/authorize";
const TOKEN_URL: &str = "https://auth.openai.com/oauth/token";
const CLIENT_ID: &str = "codex-cli";
const OAUTH_SCOPE: &str = "openid profile email offline_access";

#[derive(Serialize)]
pub struct OAuthStartResponse {
    pub state: String,
    pub redirect_uri: String,
    pub auth_url: String,
}

pub async fn start(
    state: &AppState,
    redirect_uri: Option<String>,
) -> AppResult<OAuthStartResponse> {
    let redirect_uri = redirect_uri.unwrap_or_else(|| state.config().codex_redirect_uri.clone());
    let code_verifier = random_urlsafe(64);
    let code_challenge = pkce_challenge(&code_verifier);
    let oauth_state = random_urlsafe(32);
    let now = Utc::now();
    let expires = now + Duration::minutes(10);
    let active = oauth_pending_states::ActiveModel {
        state: Set(oauth_state.clone()),
        provider: Set("codex".to_string()),
        code_verifier: Set(code_verifier),
        code_challenge: Set(code_challenge.clone()),
        redirect_uri: Set(redirect_uri.clone()),
        created_at: Set(now.to_rfc3339()),
        expires_at: Set(expires.to_rfc3339()),
    };
    oauth_pending_states::Entity::insert(active)
        .exec(&state.db().conn)
        .await?;
    Ok(OAuthStartResponse {
        auth_url: auth_url(&oauth_state, &code_challenge, &redirect_uri),
        state: oauth_state,
        redirect_uri,
    })
}

pub async fn finish(state: &AppState, params: Vec<(String, String)>) -> AppResult<Value> {
    let code = param(&params, "code").ok_or_else(|| {
        AppError::bad_request("callback_missing_code", "Callback URL missing code")
    })?;
    let oauth_state = param(&params, "state").ok_or_else(|| {
        AppError::bad_request("callback_missing_state", "Callback URL missing state")
    })?;
    let row = oauth_pending_states::Entity::find()
        .filter(oauth_pending_states::Column::State.eq(oauth_state))
        .filter(oauth_pending_states::Column::Provider.eq("codex"))
        .one(&state.db().conn)
        .await?
        .ok_or_else(|| AppError::Http {
            status: StatusCode::BAD_REQUEST,
            code: "expired_oauth_state",
            message: "Unknown or expired OAuth state".to_string(),
        })?;
    oauth_pending_states::Entity::delete_by_id(row.state.clone())
        .exec(&state.db().conn)
        .await?;

    let response = state
        .http()
        .post(TOKEN_URL)
        .form(&[
            ("grant_type", "authorization_code"),
            ("client_id", CLIENT_ID),
            ("code", code),
            ("code_verifier", row.code_verifier.as_str()),
            ("redirect_uri", row.redirect_uri.as_str()),
        ])
        .send()
        .await?;
    let status = response.status();
    let body: Value = response
        .json()
        .await
        .unwrap_or_else(|_| serde_json::json!({}));
    if !status.is_success() {
        return Err(AppError::Http {
            status,
            code: "codex_token_request_failed",
            message: body.to_string(),
        });
    }
    let credential = codex_credentials::upsert_from_tokens(state, body, None).await?;
    Ok(serde_json::json!({
        "id": credential.id,
        "email": credential.email,
        "account_id": credential.account_id,
        "plan_type": credential.plan_type,
    }))
}

pub fn parse_callback_input(raw: &str) -> AppResult<Vec<(String, String)>> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err(AppError::bad_request(
            "missing_callback_url",
            "Callback URL is required",
        ));
    }
    let candidate = if raw.contains("://") {
        raw.to_string()
    } else if raw.starts_with('?') {
        format!("http://localhost{raw}")
    } else if raw.contains('=') {
        format!("http://localhost/?{}", raw.trim_start_matches('&'))
    } else {
        format!("http://{raw}")
    };
    let url = Url::parse(&candidate)
        .map_err(|_| AppError::bad_request("invalid_callback_url", "Invalid callback URL"))?;
    Ok(url
        .query_pairs()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect())
}

fn auth_url(state: &str, code_challenge: &str, redirect_uri: &str) -> String {
    // Mirrors OpenAI Codex CLI OAuth semantics and the older CLIProxyAPI
    // GenerateAuthURL parameter set used by the TypeScript implementation.
    let params = form_urlencoded::Serializer::new(String::new())
        .append_pair("client_id", CLIENT_ID)
        .append_pair("response_type", "code")
        .append_pair("redirect_uri", redirect_uri)
        .append_pair("scope", OAUTH_SCOPE)
        .append_pair("state", state)
        .append_pair("code_challenge", code_challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("prompt", "login")
        .append_pair("id_token_add_organizations", "true")
        .append_pair("codex_cli_simplified_flow", "true")
        .finish();
    format!("{AUTH_URL}?{params}")
}

fn pkce_challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

fn random_urlsafe(bytes: usize) -> String {
    let mut buf = vec![0_u8; bytes];
    OsRng.fill_bytes(&mut buf);
    URL_SAFE_NO_PAD.encode(buf)
}

fn param<'a>(params: &'a [(String, String)], name: &str) -> Option<&'a str> {
    params
        .iter()
        .find(|(k, _)| k == name)
        .map(|(_, v)| v.as_str())
        .filter(|v| !v.is_empty())
}
