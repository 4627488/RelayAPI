use serde_json::{json, Value};

pub fn models_response(default_model: &str) -> Value {
    let mut ids = vec!["gpt-5.3-codex", "gpt-5.3-codex-spark", "codex-auto-review"];
    if !ids.contains(&default_model) {
        ids.insert(0, default_model);
    }
    json!({
        "object": "list",
        "data": ids.into_iter().map(|id| json!({
            "id": id,
            "object": "model",
            "created": 1770307200,
            "owned_by": "codex"
        })).collect::<Vec<_>>()
    })
}
