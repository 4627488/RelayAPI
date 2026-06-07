use std::{collections::BTreeMap, io};

use async_stream::stream;
use axum::body::Bytes;
use chrono::Utc;
use futures_util::{Stream, StreamExt};
use serde_json::{json, Map, Value};

use crate::{
    error::{AppError, AppResult},
    upstream::codex::sse,
};

#[derive(Clone, Copy)]
pub enum ResponseFormat {
    B64Json,
    Url,
}

pub fn response_format(input: &Value) -> ResponseFormat {
    if input
        .get("response_format")
        .and_then(Value::as_str)
        .is_some_and(|value| value.eq_ignore_ascii_case("url"))
    {
        ResponseFormat::Url
    } else {
        ResponseFormat::B64Json
    }
}

pub fn generation_to_responses(input: Value) -> AppResult<Value> {
    let object = input.as_object().ok_or_else(|| {
        AppError::bad_request("invalid_json", "Request body must be a JSON object")
    })?;
    let prompt = object
        .get("prompt")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| AppError::bad_request("missing_image_prompt", "prompt is required"))?;
    Ok(build_payload("generate", prompt, Vec::new(), object))
}

pub fn edit_to_responses(input: Value) -> AppResult<Value> {
    let object = input.as_object().ok_or_else(|| {
        AppError::bad_request("invalid_json", "Request body must be a JSON object")
    })?;
    let prompt = object
        .get("prompt")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| AppError::bad_request("missing_image_prompt", "prompt is required"))?;
    let mut images = Vec::new();
    if let Some(values) = object.get("images").and_then(Value::as_array) {
        for value in values {
            if let Some(url) = image_url(value) {
                images.push(url.to_string());
            }
        }
    }
    if images.is_empty() {
        return Err(AppError::bad_request(
            "missing_image_input",
            "images[].image_url is required",
        ));
    }
    Ok(build_payload("edit", prompt, images, object))
}

pub fn response_text_to_images(text: &str, response_format: ResponseFormat) -> AppResult<Value> {
    let raw = sse::parse_codex_response_text(text).ok_or_else(|| {
        AppError::bad_gateway(
            "image_generation_incomplete",
            "Upstream stream ended before image generation completed",
        )
    })?;
    response_to_images(&raw, response_format)
}

pub fn response_to_images(raw: &Value, response_format: ResponseFormat) -> AppResult<Value> {
    let root = raw
        .get("response")
        .and_then(Value::as_object)
        .or_else(|| raw.as_object())
        .ok_or_else(|| {
            AppError::bad_gateway("invalid_image_response", "Invalid Codex image response")
        })?;
    let results = image_results(root)?;
    let first = results.first();
    let mut output = json!({
        "created": number_field(root, "created_at").unwrap_or_else(|| Utc::now().timestamp()),
        "data": results
            .iter()
            .map(|result| image_data_item(result, response_format))
            .collect::<Vec<_>>()
    });
    if let Some(value) = first
        .map(|value| value.background.as_str())
        .filter(|value| !value.is_empty())
    {
        output["background"] = Value::String(value.to_string());
    }
    if let Some(value) = first
        .map(|value| value.output_format.as_str())
        .filter(|value| !value.is_empty())
    {
        output["output_format"] = Value::String(value.to_string());
    }
    if let Some(value) = first
        .map(|value| value.quality.as_str())
        .filter(|value| !value.is_empty())
    {
        output["quality"] = Value::String(value.to_string());
    }
    if let Some(value) = first
        .map(|value| value.size.as_str())
        .filter(|value| !value.is_empty())
    {
        output["size"] = Value::String(value.to_string());
    }
    if let Some(usage) = root
        .get("tool_usage")
        .and_then(|value| value.get("image_gen"))
        .cloned()
    {
        output["usage"] = usage;
    }
    Ok(output)
}

pub fn images_sse_stream<S>(
    upstream: S,
    response_format: ResponseFormat,
    stream_prefix: &'static str,
) -> impl Stream<Item = Result<Bytes, io::Error>>
where
    S: Stream<Item = Result<Bytes, io::Error>> + Send + 'static,
{
    stream! {
        let mut upstream = Box::pin(upstream);
        let mut buffer = String::new();
        let mut state = ImagesSseState::new(response_format, stream_prefix);
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
                for frame in state.handle_event(event) {
                    yield Ok(Bytes::from(frame));
                }
            }
        }
        for event in sse::flush_json_events(&mut buffer) {
            for frame in state.handle_event(event) {
                yield Ok(Bytes::from(frame));
            }
        }
        if !state.done {
            yield Ok(Bytes::from(image_error_frame("Upstream stream ended before image generation completed")));
        }
    }
}

#[derive(Default)]
struct ImageResult {
    result: String,
    revised_prompt: String,
    output_format: String,
    size: String,
    background: String,
    quality: String,
}

struct ImagesSseState {
    response_format: ResponseFormat,
    stream_prefix: &'static str,
    output_by_index: BTreeMap<i64, Value>,
    output_fallback: Vec<Value>,
    done: bool,
}

impl ImagesSseState {
    fn new(response_format: ResponseFormat, stream_prefix: &'static str) -> Self {
        Self {
            response_format,
            stream_prefix,
            output_by_index: BTreeMap::new(),
            output_fallback: Vec::new(),
            done: false,
        }
    }

    fn handle_event(&mut self, event: Value) -> Vec<String> {
        match event
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default()
        {
            "response.output_item.done" => {
                if let Some(item) = event.get("item").cloned() {
                    if let Some(index) = event.get("output_index").and_then(Value::as_i64) {
                        self.output_by_index.insert(index, item);
                    } else {
                        self.output_fallback.push(item);
                    }
                }
                Vec::new()
            }
            "response.image_generation_call.partial_image" => self.partial_image_frame(&event),
            "response.completed" => self.completed_frames(event),
            _ => Vec::new(),
        }
    }

    fn partial_image_frame(&self, event: &Value) -> Vec<String> {
        let Some(b64) = event.get("partial_image_b64").and_then(Value::as_str) else {
            return Vec::new();
        };
        let mut payload = json!({
            "type": format!("{}.partial_image", self.stream_prefix),
            "partial_image_index": event.get("partial_image_index").and_then(Value::as_i64).unwrap_or(0),
        });
        set_image_data(
            &mut payload,
            b64,
            event
                .get("output_format")
                .and_then(Value::as_str)
                .unwrap_or("png"),
            self.response_format,
        );
        vec![event_frame(
            &format!("{}.partial_image", self.stream_prefix),
            payload,
        )]
    }

    fn completed_frames(&mut self, event: Value) -> Vec<String> {
        let mut response = event.get("response").cloned().unwrap_or(event);
        let output_missing = response
            .get("output")
            .and_then(Value::as_array)
            .map(Vec::is_empty)
            .unwrap_or(true);
        if output_missing {
            let output = self
                .output_by_index
                .values()
                .cloned()
                .chain(self.output_fallback.iter().cloned())
                .collect::<Vec<_>>();
            if !output.is_empty() {
                if let Some(object) = response.as_object_mut() {
                    object.insert("output".to_string(), Value::Array(output));
                }
            }
        }
        let response = match response_to_images(&response, self.response_format) {
            Ok(response) => response,
            Err(error) => return vec![image_error_frame(&error.to_string())],
        };
        self.done = true;
        response
            .get("data")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .map(|item| {
                let mut payload = item.clone();
                if let Some(object) = payload.as_object_mut() {
                    object.insert(
                        "type".to_string(),
                        Value::String(format!("{}.completed", self.stream_prefix)),
                    );
                    if let Some(usage) = response.get("usage") {
                        object.insert("usage".to_string(), usage.clone());
                    }
                }
                event_frame(&format!("{}.completed", self.stream_prefix), payload)
            })
            .collect()
    }
}

fn build_payload(
    action: &str,
    prompt: &str,
    images: Vec<String>,
    object: &Map<String, Value>,
) -> Value {
    let stream = object
        .get("stream")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let image_model = object
        .get("model")
        .and_then(Value::as_str)
        .unwrap_or("gpt-image-2");
    let mut content = vec![json!({ "type": "input_text", "text": prompt })];
    for image in images {
        content.push(json!({ "type": "input_image", "image_url": image }));
    }
    let mut tool = json!({ "type": "image_generation", "action": action, "model": image_model, "output_format": "png" });
    for key in [
        "size",
        "quality",
        "background",
        "moderation",
        "output_compression",
        "partial_images",
        "input_fidelity",
    ] {
        if let Some(value) = object.get(key) {
            tool[key] = value.clone();
        }
    }
    if let Some(mask) = object.get("mask").and_then(image_url) {
        tool["input_image_mask"] = json!({ "image_url": mask });
    }
    json!({
        "model": "gpt-5.4-mini",
        "stream": stream,
        "instructions": "",
        "store": false,
        "parallel_tool_calls": true,
        "reasoning": { "effort": "medium", "summary": "auto" },
        "input": [{ "type": "message", "role": "user", "content": content }],
        "tools": [tool],
        "tool_choice": { "type": "image_generation" },
        "include": ["reasoning.encrypted_content"]
    })
}

fn image_results(root: &Map<String, Value>) -> AppResult<Vec<ImageResult>> {
    let mut results = Vec::new();
    for item in root
        .get("output")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let Some(object) = item.as_object() else {
            continue;
        };
        if object.get("type").and_then(Value::as_str) != Some("image_generation_call") {
            continue;
        }
        let Some(result) = object.get("result").and_then(Value::as_str) else {
            continue;
        };
        results.push(ImageResult {
            result: result.to_string(),
            revised_prompt: string_field(object, "revised_prompt").unwrap_or_default(),
            output_format: string_field(object, "output_format")
                .unwrap_or_else(|| "png".to_string()),
            size: string_field(object, "size").unwrap_or_default(),
            background: string_field(object, "background").unwrap_or_default(),
            quality: string_field(object, "quality").unwrap_or_default(),
        });
    }
    if results.is_empty() {
        return Err(AppError::bad_gateway(
            "missing_image_output",
            "Upstream did not return image output",
        ));
    }
    Ok(results)
}

fn image_data_item(result: &ImageResult, response_format: ResponseFormat) -> Value {
    let mut item = json!({});
    set_image_data(
        &mut item,
        &result.result,
        &result.output_format,
        response_format,
    );
    if !result.revised_prompt.is_empty() {
        item["revised_prompt"] = Value::String(result.revised_prompt.clone());
    }
    item
}

fn set_image_data(
    item: &mut Value,
    b64: &str,
    output_format: &str,
    response_format: ResponseFormat,
) {
    match response_format {
        ResponseFormat::B64Json => item["b64_json"] = Value::String(b64.to_string()),
        ResponseFormat::Url => {
            item["url"] = Value::String(format!(
                "data:{};base64,{}",
                mime_type_from_output_format(output_format),
                b64
            ));
        }
    }
}

fn image_url(value: &Value) -> Option<&str> {
    if let Some(value) = value.as_str() {
        return Some(value.trim()).filter(|value| !value.is_empty());
    }
    value
        .get("image_url")
        .and_then(|value| value.get("url").or(Some(value)))
        .or_else(|| value.get("url"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn event_frame(event: &str, data: Value) -> String {
    format!("event: {event}\ndata: {data}\n\n")
}

fn image_error_frame(message: &str) -> String {
    event_frame(
        "error",
        json!({ "error": { "message": message, "type": "stream_error", "code": "upstream_image_stream_error" } }),
    )
}

fn mime_type_from_output_format(output_format: &str) -> &'static str {
    match output_format.trim().to_ascii_lowercase().as_str() {
        "jpg" | "jpeg" | "image/jpeg" => "image/jpeg",
        "webp" | "image/webp" => "image/webp",
        _ => "image/png",
    }
}

fn string_field(object: &Map<String, Value>, key: &str) -> Option<String> {
    object
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
        .filter(|value| !value.trim().is_empty())
}

fn number_field(object: &Map<String, Value>, key: &str) -> Option<i64> {
    object.get(key).and_then(|value| match value {
        Value::Number(value) => value
            .as_i64()
            .or_else(|| value.as_u64().map(|value| value as i64)),
        Value::String(value) => value.parse::<i64>().ok(),
        _ => None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_codex_image_response_to_openai_images_shape() {
        let raw = json!({
            "id": "resp_img",
            "object": "response",
            "created_at": 123,
            "status": "completed",
            "output": [{
                "type": "image_generation_call",
                "result": "ZmFrZQ==",
                "revised_prompt": "cat",
                "output_format": "png",
                "size": "1024x1024",
                "quality": "auto"
            }],
            "tool_usage": { "image_gen": { "images": 1 } }
        });

        let out = response_to_images(&raw, ResponseFormat::B64Json).unwrap();

        assert_eq!(out["data"][0]["b64_json"], "ZmFrZQ==");
        assert_eq!(out["data"][0]["revised_prompt"], "cat");
        assert_eq!(out["size"], "1024x1024");
        assert_eq!(out["usage"]["images"], 1);
    }
}
