use std::io;

use async_stream::stream;
use axum::body::Bytes;
use chrono::Utc;
use futures_util::{Stream, StreamExt};
use serde_json::{json, Map, Value};
use uuid::Uuid;

use crate::{
    error::{AppError, AppResult},
    upstream::codex::sse,
};

pub fn chat_to_responses(input: Value, default_model: &str) -> AppResult<Value> {
    let object = input.as_object().ok_or_else(|| {
        AppError::bad_request("invalid_json", "Request body must be a JSON object")
    })?;
    let messages = object
        .get("messages")
        .and_then(Value::as_array)
        .ok_or_else(|| AppError::bad_request("missing_messages", "messages is required"))?;
    let mut input_items = Vec::with_capacity(messages.len());
    for message in messages {
        let role = message
            .get("role")
            .and_then(Value::as_str)
            .unwrap_or("user");
        if role == "tool" {
            input_items.push(json!({
                "type": "function_call_output",
                "call_id": message.get("tool_call_id").and_then(Value::as_str).unwrap_or_default(),
                "output": message.get("content").cloned().unwrap_or(Value::String(String::new())),
            }));
            continue;
        }
        let mapped_role = if role == "system" { "developer" } else { role };
        let content = message
            .get("content")
            .cloned()
            .unwrap_or(Value::String(String::new()));
        input_items.push(json!({
            "type": "message",
            "role": mapped_role,
            "content": normalize_content(content, mapped_role == "assistant")
        }));

        if mapped_role == "assistant" {
            if let Some(tool_calls) = message.get("tool_calls").and_then(Value::as_array) {
                for tool_call in tool_calls {
                    let function = tool_call.get("function").and_then(Value::as_object);
                    if tool_call.get("type").and_then(Value::as_str) != Some("function") {
                        continue;
                    }
                    input_items.push(json!({
                        "type": "function_call",
                        "call_id": tool_call.get("id").and_then(Value::as_str).unwrap_or_default(),
                        "name": function.and_then(|v| v.get("name")).and_then(Value::as_str).unwrap_or_default(),
                        "arguments": function.and_then(|v| v.get("arguments")).and_then(Value::as_str).unwrap_or("{}"),
                    }));
                }
            }
        }
    }

    let mut payload = json!({
        "model": object.get("model").and_then(Value::as_str).unwrap_or(default_model),
        "instructions": "",
        "input": input_items,
        "stream": object.get("stream").and_then(Value::as_bool).unwrap_or(false),
        "store": false,
        "parallel_tool_calls": true,
        "include": ["reasoning.encrypted_content"],
        "reasoning": { "effort": object.get("reasoning_effort").and_then(Value::as_str).unwrap_or("medium"), "summary": "auto" }
    });

    if let Some(tools) = object.get("tools") {
        payload["tools"] = normalize_tools(tools.clone());
    }
    if let Some(tool_choice) = object.get("tool_choice") {
        payload["tool_choice"] = normalize_tool_choice(tool_choice.clone());
    }
    if let Some(response_format) = object.get("response_format") {
        payload["text"] = response_format_to_text(response_format);
    }
    Ok(payload)
}

pub fn response_text_to_chat_completion(text: &str, fallback_model: &str) -> AppResult<Value> {
    let raw = sse::parse_codex_response_text(text).ok_or_else(|| {
        AppError::bad_gateway(
            "chat_response_incomplete",
            "Upstream did not return a completed Codex response",
        )
    })?;
    response_to_chat_completion(&raw, fallback_model)
}

pub fn response_to_chat_completion(raw: &Value, fallback_model: &str) -> AppResult<Value> {
    let root = raw
        .get("response")
        .and_then(Value::as_object)
        .or_else(|| raw.as_object())
        .ok_or_else(|| AppError::bad_gateway("invalid_chat_response", "Invalid Codex response"))?;
    let root_value = Value::Object(root.clone());
    let tool_calls = extract_tool_calls(root);
    let has_tool_calls = !tool_calls.is_empty();
    let mut message = json!({
        "role": "assistant",
        "content": if has_tool_calls { Value::Null } else { Value::String(extract_text(&root_value)) },
    });
    if has_tool_calls {
        message["tool_calls"] = Value::Array(tool_calls);
    }
    let finish_reason = if has_tool_calls {
        "tool_calls".to_string()
    } else if string_field(root, "status")
        .as_deref()
        .unwrap_or("completed")
        == "completed"
    {
        "stop".to_string()
    } else {
        string_field(root, "status").unwrap_or_else(|| "stop".to_string())
    };
    Ok(json!({
        "id": string_field(root, "id").unwrap_or_else(|| format!("chatcmpl-{}", Uuid::new_v4())),
        "object": "chat.completion",
        "created": number_field(root, "created_at").unwrap_or_else(|| Utc::now().timestamp()),
        "model": string_field(root, "model").unwrap_or_else(|| fallback_model.to_string()),
        "choices": [{
            "index": 0,
            "message": message,
            "finish_reason": finish_reason
        }],
        "usage": usage_payload(raw),
    }))
}

pub fn chat_sse_stream<S>(
    upstream: S,
    fallback_model: String,
) -> impl Stream<Item = Result<Bytes, io::Error>>
where
    S: Stream<Item = Result<Bytes, io::Error>> + Send + 'static,
{
    stream! {
        let mut upstream = Box::pin(upstream);
        let mut buffer = String::new();
        let mut state = ChatSseState::new(fallback_model);
        while let Some(chunk) = upstream.next().await {
            let chunk = match chunk {
                Ok(chunk) => chunk,
                Err(error) => {
                    yield Err(error);
                    return;
                }
            };
            let text = String::from_utf8_lossy(&chunk);
            for event in sse::push_json_events(&mut buffer, &text) {
                for frame in state.handle_event(&event) {
                    yield Ok(Bytes::from(frame));
                }
            }
        }
        for event in sse::flush_json_events(&mut buffer) {
            for frame in state.handle_event(&event) {
                yield Ok(Bytes::from(frame));
            }
        }
        if !state.done {
            yield Ok(Bytes::from(chat_stream_error_frame("Upstream stream ended before completion")));
            yield Ok(Bytes::from("data: [DONE]\n\n"));
        }
    }
}

struct ChatSseState {
    id: String,
    created: i64,
    model: String,
    emitted_content: bool,
    emitted_tool_call: bool,
    next_tool_call_index: i64,
    done: bool,
}

impl ChatSseState {
    fn new(fallback_model: String) -> Self {
        Self {
            id: format!("chatcmpl-{}", Uuid::new_v4()),
            created: Utc::now().timestamp(),
            model: fallback_model,
            emitted_content: false,
            emitted_tool_call: false,
            next_tool_call_index: 0,
            done: false,
        }
    }

    fn handle_event(&mut self, event: &Value) -> Vec<String> {
        match event
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default()
        {
            "response.created" => {
                if let Some(response) = event.get("response").and_then(Value::as_object) {
                    self.update_from_response(response);
                }
                Vec::new()
            }
            "response.output_text.delta" => {
                let Some(delta) = event.get("delta").and_then(Value::as_str) else {
                    return Vec::new();
                };
                self.emitted_content = true;
                vec![self.chunk(
                    json!({ "role": "assistant", "content": delta }),
                    Value::Null,
                    None,
                )]
            }
            "response.reasoning_summary_text.delta" => {
                let Some(delta) = event.get("delta").and_then(Value::as_str) else {
                    return Vec::new();
                };
                self.emitted_content = true;
                vec![self.chunk(
                    json!({ "role": "assistant", "reasoning_content": delta }),
                    Value::Null,
                    None,
                )]
            }
            "response.output_item.done" => self.tool_call_chunk(event),
            "response.completed" => self.completed_chunk(event),
            _ => Vec::new(),
        }
    }

    fn update_from_response(&mut self, response: &Map<String, Value>) {
        if let Some(id) = string_field(response, "id") {
            self.id = id;
        }
        if let Some(created) = number_field(response, "created_at") {
            self.created = created;
        }
        if let Some(model) = string_field(response, "model") {
            self.model = model;
        }
    }

    fn tool_call_chunk(&mut self, event: &Value) -> Vec<String> {
        let Some(item) = event.get("item").and_then(Value::as_object) else {
            return Vec::new();
        };
        if item.get("type").and_then(Value::as_str) != Some("function_call") {
            return Vec::new();
        }
        self.emitted_tool_call = true;
        let index = self.next_tool_call_index;
        self.next_tool_call_index += 1;
        vec![self.chunk(
            json!({
                "role": "assistant",
                "tool_calls": [{
                    "index": index,
                    "id": string_field(item, "call_id").or_else(|| string_field(item, "id")).unwrap_or_else(|| format!("call_{}", Uuid::new_v4())),
                    "type": "function",
                    "function": {
                        "name": string_field(item, "name").unwrap_or_default(),
                        "arguments": string_field(item, "arguments").unwrap_or_else(|| "{}".to_string())
                    }
                }]
            }),
            Value::Null,
            None,
        )]
    }

    fn completed_chunk(&mut self, event: &Value) -> Vec<String> {
        let response = event
            .get("response")
            .and_then(Value::as_object)
            .or_else(|| event.as_object());
        if let Some(response) = response {
            self.update_from_response(response);
        }
        let response_value = response
            .map(|value| Value::Object(value.clone()))
            .unwrap_or_else(|| event.clone());
        let mut frames = Vec::new();
        if !self.emitted_content && !self.emitted_tool_call {
            let text = extract_text(&response_value);
            if !text.is_empty() {
                frames.push(self.chunk(
                    json!({ "role": "assistant", "content": text }),
                    Value::Null,
                    None,
                ));
            }
        }
        let finish_reason = if self.emitted_tool_call {
            "tool_calls"
        } else {
            "stop"
        };
        frames.push(self.chunk(
            json!({}),
            Value::String(finish_reason.to_string()),
            Some(usage_payload(&response_value)),
        ));
        frames.push("data: [DONE]\n\n".to_string());
        self.done = true;
        frames
    }

    fn chunk(&self, delta: Value, finish_reason: Value, usage: Option<Value>) -> String {
        let mut payload = json!({
            "id": self.id,
            "object": "chat.completion.chunk",
            "created": self.created,
            "model": self.model,
            "choices": [{ "index": 0, "delta": delta, "finish_reason": finish_reason }],
        });
        if let Some(usage) = usage {
            payload["usage"] = usage;
        }
        format!("data: {payload}\n\n")
    }
}

fn normalize_content(content: Value, assistant: bool) -> Value {
    let text_type = if assistant {
        "output_text"
    } else {
        "input_text"
    };
    match content {
        Value::String(text) => {
            if text.is_empty() {
                Value::Array(Vec::new())
            } else {
                json!([{ "type": text_type, "text": text }])
            }
        }
        Value::Array(items) => Value::Array(
            items
                .into_iter()
                .filter_map(|item| normalize_content_part(item, text_type, assistant))
                .collect(),
        ),
        other => json!([{ "type": text_type, "text": other.to_string() }]),
    }
}

fn normalize_content_part(item: Value, text_type: &str, assistant: bool) -> Option<Value> {
    let object = item.as_object()?;
    match object
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default()
    {
        "text" => Some(
            json!({ "type": text_type, "text": object.get("text").and_then(Value::as_str).unwrap_or_default() }),
        ),
        "image_url" if !assistant => {
            let image_url = object
                .get("image_url")
                .and_then(|value| value.get("url").or(Some(value)))
                .and_then(Value::as_str)
                .unwrap_or_default();
            Some(json!({ "type": "input_image", "image_url": image_url }))
        }
        "file" if !assistant => Some(item),
        _ => Some(item),
    }
}

fn normalize_tools(tools: Value) -> Value {
    let Some(items) = tools.as_array() else {
        return tools;
    };
    Value::Array(
        items
            .iter()
            .map(|item| {
                let Some(object) = item.as_object() else {
                    return item.clone();
                };
                let Some(function) = object.get("function").and_then(Value::as_object) else {
                    return item.clone();
                };
                if object.get("type").and_then(Value::as_str) != Some("function") {
                    return item.clone();
                }
                json!({
                    "type": "function",
                    "name": function.get("name").and_then(Value::as_str).unwrap_or_default(),
                    "description": function.get("description").cloned().unwrap_or(Value::Null),
                    "parameters": function.get("parameters").cloned().unwrap_or_else(|| json!({ "type": "object", "properties": {} })),
                    "strict": function.get("strict").cloned().unwrap_or(Value::Null),
                })
            })
            .collect(),
    )
}

fn normalize_tool_choice(tool_choice: Value) -> Value {
    if tool_choice
        .get("type")
        .and_then(Value::as_str)
        .is_some_and(|value| value == "function")
    {
        if let Some(name) = tool_choice
            .get("function")
            .and_then(|value| value.get("name"))
            .and_then(Value::as_str)
        {
            return json!({ "type": "function", "name": name });
        }
    }
    tool_choice
}

fn response_format_to_text(response_format: &Value) -> Value {
    if response_format.get("type").and_then(Value::as_str) == Some("json_schema") {
        if let Some(schema) = response_format.get("json_schema") {
            return json!({ "format": {
                "type": "json_schema",
                "name": schema.get("name").cloned().unwrap_or(Value::Null),
                "strict": schema.get("strict").cloned().unwrap_or(Value::Null),
                "schema": schema.get("schema").cloned().unwrap_or(Value::Null),
            }});
        }
    }
    json!({ "format": { "type": "text" } })
}

fn extract_text(value: &Value) -> String {
    let mut texts = Vec::new();
    if let Some(output_text) = value.get("output_text").and_then(Value::as_str) {
        texts.push(output_text.to_string());
    }
    collect_texts(value.get("output").unwrap_or(value), &mut texts);
    texts.join("")
}

fn collect_texts(value: &Value, texts: &mut Vec<String>) {
    match value {
        Value::Array(items) => {
            for item in items {
                collect_texts(item, texts);
            }
        }
        Value::Object(object) => {
            if object.get("type").and_then(Value::as_str) == Some("output_text") {
                if let Some(text) = object.get("text").and_then(Value::as_str) {
                    texts.push(text.to_string());
                }
            }
            if let Some(content) = object.get("content") {
                collect_texts(content, texts);
            }
            if let Some(summary) = object.get("summary") {
                collect_texts(summary, texts);
            }
        }
        _ => {}
    }
}

fn extract_tool_calls(root: &Map<String, Value>) -> Vec<Value> {
    root.get("output")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|item| {
            let object = item.as_object()?;
            if object.get("type").and_then(Value::as_str) != Some("function_call") {
                return None;
            }
            Some(json!({
                "id": string_field(object, "call_id").or_else(|| string_field(object, "id")).unwrap_or_else(|| format!("call_{}", Uuid::new_v4())),
                "type": "function",
                "function": {
                    "name": string_field(object, "name").unwrap_or_default(),
                    "arguments": string_field(object, "arguments").unwrap_or_else(|| "{}".to_string()),
                }
            }))
        })
        .collect()
}

fn usage_payload(raw: &Value) -> Value {
    let usage = raw
        .get("response")
        .and_then(|value| value.get("usage"))
        .or_else(|| raw.get("usage"))
        .and_then(Value::as_object);
    let prompt_tokens = usage
        .and_then(|value| {
            numberish(
                value
                    .get("input_tokens")
                    .or_else(|| value.get("prompt_tokens")),
            )
        })
        .unwrap_or(0);
    let completion_tokens = usage
        .and_then(|value| {
            numberish(
                value
                    .get("output_tokens")
                    .or_else(|| value.get("completion_tokens")),
            )
        })
        .unwrap_or(0);
    let total_tokens = usage
        .and_then(|value| numberish(value.get("total_tokens")))
        .unwrap_or(prompt_tokens + completion_tokens);
    let cached_tokens = usage.and_then(cached_tokens).unwrap_or(0);
    json!({
        "prompt_tokens": prompt_tokens,
        "completion_tokens": completion_tokens,
        "total_tokens": total_tokens,
        "prompt_tokens_details": { "cached_tokens": cached_tokens }
    })
}

fn cached_tokens(usage: &Map<String, Value>) -> Option<i64> {
    for key in [
        "cached_tokens",
        "cached_input_tokens",
        "prompt_cache_hit_tokens",
        "prompt_cache_read_tokens",
    ] {
        if let Some(value) = numberish(usage.get(key)) {
            if value > 0 {
                return Some(value);
            }
        }
    }
    for key in [
        "input_tokens_details",
        "prompt_tokens_details",
        "input_token_details",
        "prompt_token_details",
    ] {
        if let Some(value) = usage
            .get(key)
            .and_then(Value::as_object)
            .and_then(|value| numberish(value.get("cached_tokens")))
        {
            if value > 0 {
                return Some(value);
            }
        }
    }
    None
}

fn string_field(object: &Map<String, Value>, key: &str) -> Option<String> {
    object
        .get(key)
        .and_then(|value| match value {
            Value::String(value) => Some(value.clone()),
            Value::Number(value) => Some(value.to_string()),
            _ => None,
        })
        .filter(|value| !value.trim().is_empty())
}

fn number_field(object: &Map<String, Value>, key: &str) -> Option<i64> {
    numberish(object.get(key))
}

fn numberish(value: Option<&Value>) -> Option<i64> {
    match value? {
        Value::Number(value) => value
            .as_i64()
            .or_else(|| value.as_u64().map(|value| value as i64)),
        Value::String(value) => value.parse::<i64>().ok(),
        _ => None,
    }
}

fn chat_stream_error_frame(message: &str) -> String {
    format!(
        "data: {}\n\n",
        json!({ "error": { "message": message, "type": "stream_error", "code": "upstream_stream_incomplete" } })
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_codex_response_to_chat_completion() {
        let raw = json!({
            "id": "resp_1",
            "object": "response",
            "created_at": 123,
            "status": "completed",
            "model": "gpt-5.4-mini",
            "output": [{
                "type": "message",
                "role": "assistant",
                "content": [{ "type": "output_text", "text": "hello relay" }]
            }],
            "usage": { "input_tokens": 3, "output_tokens": 2, "total_tokens": 5 }
        });

        let out = response_to_chat_completion(&raw, "fallback").unwrap();

        assert_eq!(out["object"], "chat.completion");
        assert_eq!(out["choices"][0]["message"]["content"], "hello relay");
        assert_eq!(out["usage"]["total_tokens"], 5);
    }
}
