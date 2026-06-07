use std::time::Instant;

use axum::{
    body::Body,
    http::{header, HeaderMap, HeaderName, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
};
use chrono::Utc;
use futures_util::StreamExt;
use serde_json::Value;

use super::{chat, images, stream_audit};

use crate::{
    error::{AppError, AppResult},
    http::AppState,
    services::{api_keys, channels, logs, usage},
};

#[derive(Clone, Copy)]
enum ResponseTransform {
    Raw,
    ChatCompletion,
    Images {
        response_format: images::ResponseFormat,
        stream_prefix: &'static str,
    },
}

pub async fn forward_responses(
    state: &AppState,
    source_headers: HeaderMap,
    body: Value,
    path: &str,
) -> AppResult<Response> {
    let request_type = request_type(path);
    forward_responses_with(
        state,
        source_headers,
        body,
        path,
        &request_type,
        ResponseTransform::Raw,
    )
    .await
}

pub async fn forward_chat_completion(
    state: &AppState,
    source_headers: HeaderMap,
    body: Value,
) -> AppResult<Response> {
    forward_responses_with(
        state,
        source_headers,
        body,
        "/responses",
        "chat.completions",
        ResponseTransform::ChatCompletion,
    )
    .await
}

pub async fn forward_images(
    state: &AppState,
    source_headers: HeaderMap,
    body: Value,
    response_format: images::ResponseFormat,
    stream_prefix: &'static str,
    request_type: &'static str,
) -> AppResult<Response> {
    forward_responses_with(
        state,
        source_headers,
        body,
        "/responses",
        request_type,
        ResponseTransform::Images {
            response_format,
            stream_prefix,
        },
    )
    .await
}

async fn forward_responses_with(
    state: &AppState,
    source_headers: HeaderMap,
    mut body: Value,
    path: &str,
    request_type: &str,
    transform: ResponseTransform,
) -> AppResult<Response> {
    let started_at = Utc::now().to_rfc3339();
    let start = Instant::now();
    let model = ensure_model(state, &mut body);
    let stream = body.get("stream").and_then(Value::as_bool).unwrap_or(false);
    let api_key = api_keys::authenticate(state.db(), relay_api_key(&source_headers)?).await?;
    usage::enforce_preflight(state.db(), &api_key).await?;
    let selected = channels::select(state, &api_key, &model).await?;
    let url = format!(
        "{}{}",
        selected.channel.base_url.trim_end_matches('/'),
        path
    );
    let configured_user_agent = crate::services::settings::codex_user_agent(state).await?;
    let user_agent = selected
        .credential
        .user_agent
        .as_deref()
        .unwrap_or(&configured_user_agent);

    let proxied_client;
    let client = if let Some(proxy) = selected
        .credential
        .proxy
        .as_ref()
        .and_then(crate::services::proxy_pool::proxy_url)
    {
        proxied_client = reqwest::Client::builder()
            .proxy(reqwest::Proxy::all(proxy)?)
            .build()?;
        &proxied_client
    } else {
        state.http()
    };

    let mut request = client
        .post(url)
        .timeout(if stream {
            state.config().stream_timeout
        } else {
            state.config().request_timeout
        })
        .header(header::USER_AGENT, user_agent)
        .header("originator", &state.config().codex_originator)
        .header(
            header::AUTHORIZATION,
            format!("Bearer {}", selected.credential.access_token),
        )
        .header(header::CONTENT_TYPE, "application/json");

    if !selected.credential.account_id.is_empty() {
        request = request.header("chatgpt-account-id", &selected.credential.account_id);
    }
    for name in [
        "openai-beta",
        "x-codex-turn-metadata",
        "x-codex-turn-state",
        "x-codex-window-id",
    ] {
        if let Some(value) = source_headers.get(name) {
            request = request.header(name, value);
        }
    }

    let request_body_text = serde_json::to_string(&body).ok();
    let upstream = match request.json(&body).send().await {
        Ok(response) => response,
        Err(error) => {
            let _ =
                channels::record_failure(state.db(), &selected.channel, error.to_string()).await;
            let _ = logs::append(
                state.db(),
                logs::RequestLogInput {
                    started_at,
                    method: "POST".to_string(),
                    path: path.to_string(),
                    request_type: request_type.to_string(),
                    stream,
                    model,
                    status_code: 0,
                    latency_ms: start.elapsed().as_millis() as i64,
                    api_key_id: Some(api_key.id),
                    api_key_prefix: Some(api_key.prefix),
                    channel_id: Some(selected.channel.id),
                    credential_id: Some(selected.credential.id),
                    prompt_tokens: 0,
                    completion_tokens: 0,
                    total_tokens: 0,
                    error_code: Some("upstream_fetch_failed".to_string()),
                    error_message: Some(error.to_string()),
                    request_body_text,
                    upstream_body_text: None,
                },
            )
            .await;
            return Err(AppError::Reqwest(error));
        }
    };

    let status =
        StatusCode::from_u16(upstream.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    let content_type = upstream.headers().get(header::CONTENT_TYPE).cloned();
    if status.is_success() {
        let _ = channels::record_success(state.db(), &selected.channel).await;
    } else {
        let _ =
            channels::record_failure(state.db(), &selected.channel, format!("HTTP {status}")).await;
    }

    if stream {
        let log_id = logs::append(
            state.db(),
            logs::RequestLogInput {
                started_at: started_at.clone(),
                method: "POST".to_string(),
                path: path.to_string(),
                request_type: request_type.to_string(),
                stream,
                model: model.clone(),
                status_code: status.as_u16() as i32,
                latency_ms: start.elapsed().as_millis() as i64,
                api_key_id: Some(api_key.id.clone()),
                api_key_prefix: Some(api_key.prefix.clone()),
                channel_id: Some(selected.channel.id.clone()),
                credential_id: Some(selected.credential.id.clone()),
                prompt_tokens: 0,
                completion_tokens: 0,
                total_tokens: 0,
                error_code: (!status.is_success()).then_some("upstream_error".to_string()),
                error_message: None,
                request_body_text,
                upstream_body_text: None,
            },
        )
        .await?;
        let audit = stream_audit::StreamAuditContext {
            db: state.db().clone(),
            log_id,
            api_key: api_key.clone(),
            channel_id: selected.channel.id.clone(),
            credential_id: selected.credential.id.clone(),
            model: model.clone(),
            request_type: request_type.to_string(),
            started: start,
        };
        let body = match transform {
            ResponseTransform::Raw => {
                let stream = upstream
                    .bytes_stream()
                    .map(|chunk| chunk.map_err(std::io::Error::other));
                Body::from_stream(stream_audit::observe(stream, audit))
            }
            ResponseTransform::ChatCompletion => {
                let stream = upstream
                    .bytes_stream()
                    .map(|chunk| chunk.map_err(std::io::Error::other));
                Body::from_stream(chat::chat_sse_stream(
                    stream_audit::observe(stream, audit),
                    model.clone(),
                ))
            }
            ResponseTransform::Images {
                response_format,
                stream_prefix,
            } => {
                let stream = upstream
                    .bytes_stream()
                    .map(|chunk| chunk.map_err(std::io::Error::other));
                Body::from_stream(images::images_sse_stream(
                    stream_audit::observe(stream, audit),
                    response_format,
                    stream_prefix,
                ))
            }
        };
        let mut response = Response::new(body);
        *response.status_mut() = status;
        match transform {
            ResponseTransform::Raw => {
                if let Some(value) = content_type {
                    response.headers_mut().insert(header::CONTENT_TYPE, value);
                } else {
                    response.headers_mut().insert(
                        header::CONTENT_TYPE,
                        HeaderValue::from_static("text/event-stream; charset=utf-8"),
                    );
                }
            }
            ResponseTransform::ChatCompletion | ResponseTransform::Images { .. } => {
                response.headers_mut().insert(
                    header::CONTENT_TYPE,
                    HeaderValue::from_static("text/event-stream; charset=utf-8"),
                );
            }
        }
        response.headers_mut().insert(
            header::CACHE_CONTROL,
            HeaderValue::from_static("no-cache, no-transform"),
        );
        return Ok(response);
    }

    let headers = upstream.headers().clone();
    let text = upstream.text().await?;
    let token_usage = if status.is_success() {
        usage::extract_token_usage(&text)
    } else {
        usage::TokenUsage::default()
    };
    let mut response_status = status;
    let mut response_text = text.clone();
    let mut content_type_override = None;
    let mut transform_error_code = None;
    let mut transform_error_message = None;
    if status.is_success() {
        match transform_success_body(transform, &text, &model) {
            Ok(Some(transformed)) => {
                response_text = transformed;
                content_type_override =
                    Some(HeaderValue::from_static("application/json; charset=utf-8"));
            }
            Ok(None) => {}
            Err(error) => {
                let (error_status, code, message) = public_transform_error(error);
                let _ =
                    channels::record_failure(state.db(), &selected.channel, message.clone()).await;
                response_status = error_status;
                transform_error_code = Some(code.to_string());
                transform_error_message = Some(message.clone());
                response_text =
                    serde_json::json!({ "error": { "code": code, "message": message } })
                        .to_string();
                content_type_override =
                    Some(HeaderValue::from_static("application/json; charset=utf-8"));
            }
        }
    }
    let log_id = logs::append(
        state.db(),
        logs::RequestLogInput {
            started_at,
            method: "POST".to_string(),
            path: path.to_string(),
            request_type: request_type.to_string(),
            stream,
            model: model.clone(),
            status_code: response_status.as_u16() as i32,
            latency_ms: start.elapsed().as_millis() as i64,
            api_key_id: Some(api_key.id.clone()),
            api_key_prefix: Some(api_key.prefix.clone()),
            channel_id: Some(selected.channel.id.clone()),
            credential_id: Some(selected.credential.id.clone()),
            prompt_tokens: token_usage.prompt_tokens,
            completion_tokens: token_usage.completion_tokens,
            total_tokens: token_usage.total_tokens,
            error_code: transform_error_code
                .or_else(|| (!status.is_success()).then_some("upstream_error".to_string())),
            error_message: transform_error_message,
            request_body_text,
            upstream_body_text: Some(limit_text(&text, 512 * 1024)),
        },
    )
    .await
    .ok();
    let _ = usage::record(
        state.db(),
        usage::RecordUsageInput {
            log_id: log_id.as_deref(),
            api_key: &api_key,
            channel_id: Some(&selected.channel.id),
            credential_id: Some(&selected.credential.id),
            model: &model,
            request_type,
            usage: token_usage,
        },
    )
    .await;
    let mut response = (response_status, response_text).into_response();
    if let Some(value) = content_type_override {
        response.headers_mut().insert(header::CONTENT_TYPE, value);
    } else {
        copy_header(&headers, response.headers_mut(), header::CONTENT_TYPE);
    }
    Ok(response)
}

fn ensure_model(state: &AppState, body: &mut Value) -> String {
    let model = body
        .get("model")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(&state.config().codex_default_model)
        .to_string();
    if body.get("model").is_none() {
        if let Some(object) = body.as_object_mut() {
            object.insert("model".to_string(), Value::String(model.clone()));
        }
    }
    model
}

fn relay_api_key(headers: &HeaderMap) -> AppResult<&str> {
    headers
        .get("x-api-key")
        .and_then(|v| v.to_str().ok())
        .or_else(|| {
            headers
                .get(header::AUTHORIZATION)
                .and_then(|v| v.to_str().ok())
                .and_then(|value| value.strip_prefix("Bearer "))
        })
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| AppError::unauthorized("Relay API key is required"))
}

fn copy_header(from: &HeaderMap, to: &mut HeaderMap, name: HeaderName) {
    if let Some(value) = from.get(&name) {
        to.insert(name, value.clone());
    }
}

fn request_type(path: &str) -> String {
    match path {
        "/responses" => "responses",
        "/responses/compact" => "responses.compact",
        _ => "codex",
    }
    .to_string()
}

fn limit_text(value: &str, limit: usize) -> String {
    if value.len() <= limit {
        value.to_string()
    } else {
        value[..limit].to_string()
    }
}

fn transform_success_body(
    transform: ResponseTransform,
    text: &str,
    model: &str,
) -> AppResult<Option<String>> {
    match transform {
        ResponseTransform::Raw => Ok(None),
        ResponseTransform::ChatCompletion => Ok(Some(
            serde_json::to_string(&chat::response_text_to_chat_completion(text, model)?)
                .map_err(anyhow::Error::from)?,
        )),
        ResponseTransform::Images {
            response_format, ..
        } => Ok(Some(
            serde_json::to_string(&images::response_text_to_images(text, response_format)?)
                .map_err(anyhow::Error::from)?,
        )),
    }
}

fn public_transform_error(error: AppError) -> (StatusCode, &'static str, String) {
    match error {
        AppError::Http {
            status,
            code,
            message,
        } => (status, code, message),
        AppError::Reqwest(error) => (StatusCode::BAD_GATEWAY, "upstream_error", error.to_string()),
        AppError::Db(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            "database_error",
            error.to_string(),
        ),
        AppError::Anyhow(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal_error",
            error.to_string(),
        ),
    }
}
