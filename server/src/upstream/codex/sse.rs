use std::collections::BTreeMap;

use serde_json::{json, Value};

#[allow(dead_code)]
pub fn data_payload(frame: &str) -> String {
    frame
        .replace("\r\n", "\n")
        .replace('\r', "\n")
        .lines()
        .filter_map(|line| line.trim().strip_prefix("data:"))
        .map(|line| line.trim_start().trim_end())
        .collect::<Vec<_>>()
        .join("\n")
}

#[allow(dead_code)]
pub fn parse_json_frame(frame: &str) -> Option<Value> {
    let data = data_payload(frame);
    if data.is_empty() || data == "[DONE]" {
        return None;
    }
    serde_json::from_str(&data).ok()
}

pub fn json_events(text: &str) -> Vec<Value> {
    text.replace("\r\n", "\n")
        .replace('\r', "\n")
        .split("\n\n")
        .filter_map(json_event_from_block)
        .collect()
}

pub fn push_json_events(buffer: &mut String, text: &str) -> Vec<Value> {
    buffer.push_str(text);
    let normalized = buffer.replace("\r\n", "\n").replace('\r', "\n");
    let mut blocks = normalized.split("\n\n").collect::<Vec<_>>();
    let rest = blocks.pop().unwrap_or_default().to_string();
    *buffer = rest;
    blocks
        .into_iter()
        .filter_map(json_event_from_block)
        .collect()
}

pub fn flush_json_events(buffer: &mut String) -> Vec<Value> {
    if buffer.trim().is_empty() {
        buffer.clear();
        return Vec::new();
    }
    let text = std::mem::take(buffer);
    json_events(&format!("{text}\n\n"))
}

pub fn parse_codex_response_text(text: &str) -> Option<Value> {
    if let Ok(value) = serde_json::from_str::<Value>(text) {
        return Some(value);
    }

    let mut completed = None;
    let mut output_by_index = BTreeMap::<i64, Value>::new();
    let mut output_fallback = Vec::<Value>::new();

    for event in json_events(text) {
        if event.get("type").and_then(Value::as_str) == Some("response.output_item.done") {
            if let Some(item) = event.get("item").cloned() {
                if let Some(index) = event.get("output_index").and_then(Value::as_i64) {
                    output_by_index.insert(index, item);
                } else {
                    output_fallback.push(item);
                }
            }
            continue;
        }
        if event.get("type").and_then(Value::as_str) == Some("response.completed") {
            completed = event.get("response").cloned().or(Some(event));
        }
    }

    let output = ordered_output(output_by_index, output_fallback);
    if let Some(mut value) = completed {
        let output_missing = value
            .get("output")
            .and_then(Value::as_array)
            .map(Vec::is_empty)
            .unwrap_or(true);
        if output_missing && !output.is_empty() {
            if let Some(object) = value.as_object_mut() {
                object.insert("output".to_string(), Value::Array(output));
            }
        }
        return Some(value);
    }

    (!output.is_empty()).then(|| json!({ "object": "response", "output": output }))
}

fn json_event_from_block(block: &str) -> Option<Value> {
    let data = data_payload(block);
    if data.is_empty() || data == "[DONE]" {
        let bare = block
            .lines()
            .map(str::trim)
            .filter(|line| line.starts_with('{') || line.starts_with('['))
            .collect::<Vec<_>>()
            .join("\n");
        if bare.is_empty() || bare == "[DONE]" {
            return None;
        }
        return serde_json::from_str(&bare).ok();
    }
    serde_json::from_str(&data).ok()
}

fn ordered_output(by_index: BTreeMap<i64, Value>, fallback: Vec<Value>) -> Vec<Value> {
    by_index.into_values().chain(fallback).collect()
}
