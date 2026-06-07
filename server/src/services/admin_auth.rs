use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use serde::Deserialize;

use crate::{
    error::{AppError, AppResult},
    http::AppState,
    services::crypto,
};

#[derive(Deserialize)]
pub struct WebLoginRequest {
    pub access_key: String,
}

pub fn login(state: &AppState, input: WebLoginRequest) -> AppResult<HeaderValue> {
    if crypto::hash_secret(input.access_key.trim()) != state.config().web_access_key_hash {
        return Err(AppError::Http {
            status: StatusCode::UNAUTHORIZED,
            code: "invalid_web_access_key",
            message: "Invalid web access key".to_string(),
        });
    }
    HeaderValue::from_str(&format!(
        "relay_web_session={}; Path=/; HttpOnly; SameSite=Lax",
        state.config().web_session_token
    ))
    .map_err(anyhow::Error::from)
    .map_err(AppError::from)
}

pub fn require_admin(state: &AppState, headers: &HeaderMap) -> AppResult<()> {
    if let Some(value) = headers.get("x-relay-web-key").and_then(|v| v.to_str().ok()) {
        if crypto::hash_secret(value.trim()) == state.config().web_access_key_hash {
            return Ok(());
        }
    }
    if let Some(value) = bearer(headers) {
        if crypto::hash_secret(value) == state.config().web_access_key_hash {
            return Ok(());
        }
    }
    if cookie(headers, "relay_web_session") == Some(state.config().web_session_token.as_str()) {
        return Ok(());
    }
    Err(AppError::Http {
        status: StatusCode::UNAUTHORIZED,
        code: "admin_auth_required",
        message: "Web access key is required".to_string(),
    })
}

fn bearer(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(str::trim)
}

fn cookie<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers
        .get(header::COOKIE)
        .and_then(|v| v.to_str().ok())?
        .split(';')
        .filter_map(|part| part.trim().split_once('='))
        .find_map(|(key, value)| (key == name).then_some(value))
}
