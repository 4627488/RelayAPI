package upstream

import (
	"bytes"
	"encoding/json"
	"strings"
)

// sanitizeKimiToolSchemas rewrites tool and structured-output schemas so they
// pass Moonshot Flavored JSON Schema (MFJS). Walle rejects a node that carries
// both `type` and `$ref` (or `type` and `anyOf`); Codex/Zod-generated
// `$defs.__schemaN` wrappers hit that rule and 400 the whole turn.
func sanitizeKimiToolSchemas(payload []byte) []byte {
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.UseNumber()
	var root map[string]any
	if decoder.Decode(&root) != nil {
		return payload
	}
	changed := false
	for _, raw := range asAnySlice(root["tools"]) {
		tool, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		if function, ok := tool["function"].(map[string]any); ok {
			if sanitizeMFJSSchema(function["parameters"]) {
				changed = true
			}
		}
		if sanitizeMFJSSchema(tool["parameters"]) {
			changed = true
		}
	}
	if format, ok := root["response_format"].(map[string]any); ok {
		if schema, ok := format["json_schema"].(map[string]any); ok && sanitizeMFJSSchema(schema["schema"]) {
			changed = true
		}
		if sanitizeMFJSSchema(format["schema"]) {
			changed = true
		}
	}
	if !changed {
		return payload
	}
	encoded, err := json.Marshal(root)
	if err != nil {
		return payload
	}
	return encoded
}

func sanitizeMFJSSchema(value any) bool {
	root, ok := value.(map[string]any)
	if !ok {
		return false
	}
	return walkMFJSSchema(root, root)
}

func walkMFJSSchema(node any, root map[string]any) bool {
	switch typed := node.(type) {
	case map[string]any:
		changed := applyMFJSTypePlacement(typed, root)
		for _, key := range mfjsSchemaMapKeys {
			if child, ok := typed[key].(map[string]any); ok {
				for _, nested := range child {
					if walkMFJSSchema(nested, root) {
						changed = true
					}
				}
			}
		}
		for _, key := range mfjsSchemaArrayKeys {
			if walkMFJSSchema(typed[key], root) {
				changed = true
			}
		}
		for _, key := range mfjsSchemaSingleKeys {
			if walkMFJSSchema(typed[key], root) {
				changed = true
			}
		}
		return changed
	case []any:
		changed := false
		for _, nested := range typed {
			if walkMFJSSchema(nested, root) {
				changed = true
			}
		}
		return changed
	default:
		return false
	}
}

func applyMFJSTypePlacement(node, root map[string]any) bool {
	rawType, hasType := node["type"]
	if !hasType {
		return false
	}
	if ref, _ := node["$ref"].(string); strings.TrimSpace(ref) != "" {
		if target := resolveJSONSchemaRef(root, ref); target != nil {
			if _, exists := target["type"]; !exists && target != node {
				target["type"] = rawType
			}
		}
		delete(node, "type")
		return true
	}
	branches, ok := node["anyOf"].([]any)
	if !ok {
		return false
	}
	for _, raw := range branches {
		branch, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		if _, exists := branch["type"]; !exists {
			branch["type"] = rawType
		}
	}
	delete(node, "type")
	return true
}

func resolveJSONSchemaRef(root map[string]any, ref string) map[string]any {
	ref = strings.TrimSpace(ref)
	if ref == "#" {
		return root
	}
	if !strings.HasPrefix(ref, "#/") {
		return nil
	}
	current := any(root)
	for _, part := range strings.Split(ref[2:], "/") {
		part = strings.ReplaceAll(strings.ReplaceAll(part, "~1", "/"), "~0", "~")
		object, ok := current.(map[string]any)
		if !ok {
			return nil
		}
		current = object[part]
	}
	object, _ := current.(map[string]any)
	return object
}

var (
	mfjsSchemaMapKeys    = []string{"properties", "patternProperties", "$defs", "definitions", "dependentSchemas"}
	mfjsSchemaArrayKeys  = []string{"anyOf", "oneOf", "allOf", "prefixItems"}
	mfjsSchemaSingleKeys = []string{"additionalProperties", "propertyNames", "items", "contains", "not", "if", "then", "else", "unevaluatedProperties", "unevaluatedItems", "contentSchema"}
)
