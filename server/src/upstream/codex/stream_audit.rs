use std::{
    io,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Instant,
};

use async_stream::stream;
use axum::body::Bytes;
use futures_util::{Stream, StreamExt};
use serde_json::Value;

use crate::{
    db::Database,
    services::{
        api_keys::RelayApiKeyContext,
        logs,
        usage::{self, TokenUsage},
    },
};

use super::sse;

#[derive(Clone)]
pub struct StreamAuditContext {
    pub db: Database,
    pub log_id: String,
    pub api_key: RelayApiKeyContext,
    pub channel_id: String,
    pub credential_id: String,
    pub model: String,
    pub request_type: String,
    pub started: Instant,
}

pub fn observe<S>(
    upstream: S,
    context: StreamAuditContext,
) -> impl Stream<Item = Result<Bytes, io::Error>>
where
    S: Stream<Item = Result<Bytes, io::Error>> + Send + 'static,
{
    stream! {
        let observer = Arc::new(Mutex::new(SseUsageObserver::default()));
        let guard = FinalizeGuard::new(context, observer.clone());
        let mut upstream = Box::pin(upstream);
        while let Some(chunk) = upstream.next().await {
            match chunk {
                Ok(bytes) => {
                    if let Ok(mut observer) = observer.lock() {
                        observer.push(&bytes);
                    }
                    yield Ok(bytes);
                }
                Err(error) => {
                    guard.finalize(Some("stream_error"), Some(error.to_string())).await;
                    yield Err(error);
                    return;
                }
            }
        }
        if let Ok(mut observer) = observer.lock() {
            observer.flush();
        }
        let incomplete = observer
            .lock()
            .map(|observer| !observer.completed)
            .unwrap_or(true);
        if incomplete {
            guard.finalize(Some("stream_incomplete"), Some("Upstream stream ended before completion".to_string())).await;
        } else {
            guard.finalize(None, None).await;
        }
    }
}

#[derive(Default)]
struct SseUsageObserver {
    buffer: String,
    usage: TokenUsage,
    completed: bool,
}

impl SseUsageObserver {
    fn push(&mut self, bytes: &[u8]) {
        let text = String::from_utf8_lossy(bytes);
        for event in sse::push_json_events(&mut self.buffer, &text) {
            self.observe_event(&event);
        }
    }

    fn flush(&mut self) {
        for event in sse::flush_json_events(&mut self.buffer) {
            self.observe_event(&event);
        }
    }

    fn observe_event(&mut self, event: &Value) {
        let usage = usage::extract_token_usage_value(event);
        if usage.total_tokens > 0 || usage.prompt_tokens > 0 || usage.completion_tokens > 0 {
            self.usage = usage;
        }
        if matches!(
            event.get("type").and_then(Value::as_str),
            Some("response.completed" | "response.done")
        ) {
            self.completed = true;
        }
    }
}

struct FinalizeGuard {
    context: StreamAuditContext,
    observer: Arc<Mutex<SseUsageObserver>>,
    finalized: Arc<AtomicBool>,
}

impl FinalizeGuard {
    fn new(context: StreamAuditContext, observer: Arc<Mutex<SseUsageObserver>>) -> Self {
        Self {
            context,
            observer,
            finalized: Arc::new(AtomicBool::new(false)),
        }
    }

    async fn finalize(&self, error_code: Option<&'static str>, error_message: Option<String>) {
        if self.finalized.swap(true, Ordering::SeqCst) {
            return;
        }
        finalize(
            self.context.clone(),
            self.observer
                .lock()
                .map(|observer| observer.usage)
                .unwrap_or_default(),
            error_code,
            error_message.as_deref(),
        )
        .await;
    }
}

impl Drop for FinalizeGuard {
    fn drop(&mut self) {
        if self.finalized.swap(true, Ordering::SeqCst) {
            return;
        }
        let context = self.context.clone();
        let usage = self
            .observer
            .lock()
            .map(|observer| observer.usage)
            .unwrap_or_default();
        tokio::spawn(async move {
            finalize(
                context,
                usage,
                Some("stream_aborted"),
                Some("Client disconnected before stream completion"),
            )
            .await;
        });
    }
}

async fn finalize(
    context: StreamAuditContext,
    token_usage: TokenUsage,
    error_code: Option<&str>,
    error_message: Option<&str>,
) {
    let latency_ms = context.started.elapsed().as_millis() as i64;
    if let Err(error) = logs::finish_stream(
        &context.db,
        &context.log_id,
        latency_ms,
        token_usage,
        error_code,
        error_message,
    )
    .await
    {
        tracing::warn!(%error, "failed to finish stream request log");
    }
    if let Err(error) = usage::record(
        &context.db,
        usage::RecordUsageInput {
            log_id: Some(&context.log_id),
            api_key: &context.api_key,
            channel_id: Some(&context.channel_id),
            credential_id: Some(&context.credential_id),
            model: &context.model,
            request_type: &context.request_type,
            usage: token_usage,
        },
    )
    .await
    {
        tracing::warn!(%error, "failed to record stream token usage");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn observes_usage_from_completed_sse_event() {
        let mut observer = SseUsageObserver::default();
        observer.push(br#"data: {"type":"response.completed","response":{"usage":{"input_tokens":2,"output_tokens":3}}}

"#);
        assert!(observer.completed);
        assert_eq!(observer.usage.prompt_tokens, 2);
        assert_eq!(observer.usage.completion_tokens, 3);
        assert_eq!(observer.usage.total_tokens, 5);
    }

    #[test]
    fn handles_split_sse_frames() {
        let mut observer = SseUsageObserver::default();
        observer.push(br#"data: {"type":"response.completed","response":{"usage":{"total_tokens""#);
        assert_eq!(observer.usage.total_tokens, 0);
        observer.push(
            br#":9}}}

"#,
        );
        assert!(observer.completed);
        assert_eq!(observer.usage.total_tokens, 9);
    }
}
