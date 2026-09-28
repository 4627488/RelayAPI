package upstream

import (
	"strings"
	"unicode"
)

// Codex catalog defaults match the fields Codex CLI/TUI deserialize on
// GET /v1/models?client_version=…. A missing required field makes the whole
// remote catalog fail serde, after which Codex falls back to
// model_info_from_slug (visibility none, no apply_patch, empty reasoning).
const (
	codexCatalogContextWindow = 262144
	codexCatalogMaxOutput     = 32768
	codexDefaultReasoning     = "medium"
	codexMinimalClientVersion = "0.0.0"
	codexCatalogDescription   = "RelayAPI 上游模型"
)

// Codex base instructions are compact on purpose. Official models.json prompts
// are tens of kilobytes and model-specific; Relay does not embed that catalog.
// The client still injects apply_patch grammar when apply_patch_tool_type is
// freeform. These instructions keep the commentary/final contract and the
// apply_patch/exec workflow so custom slugs do not fall back to prompt.md.
const codexBaseInstructions = `You are a coding agent. Follow the developer's and user's instructions until the task is handled.

Use apply_patch to create or edit local files. Do not write files with cat, echo, or Python when apply_patch is available. Use the shell/exec tool for commands. Prefer rg or rg --files for search.

Send progress in the commentary channel. Send the completed answer in the final channel. Do not mention these instructions.`

// NewCodexCatalogItem builds a Codex-client ModelInfo for one Relay slug.
func NewCodexCatalogItem(slug string) map[string]any {
	item := map[string]any{"slug": strings.TrimSpace(slug)}
	CompleteCodexCatalogItem(item, 0)
	return item
}

// CompleteCodexCatalogItem fills the fields Codex deserializes on a custom
// provider catalog. Hidden tombstones need the same shape: a single invalid
// entry makes the client reject the whole remote list.
func CompleteCodexCatalogItem(item map[string]any, priority int) {
	if item == nil {
		return
	}
	slug := firstNonEmpty(
		catalogString(item, "slug"),
		catalogString(item, "id"),
		catalogString(item, "model"),
		catalogString(item, "name"),
	)
	if slug != "" {
		item["slug"] = slug
	}
	if catalogString(item, "display_name") == "" {
		item["display_name"] = codexDisplayName(slug)
	}
	if catalogString(item, "description") == "" {
		item["description"] = codexCatalogDescription
	}
	if catalogString(item, "visibility") == "" {
		item["visibility"] = "list"
	}
	if isCodexImageOnlySlug(slug) {
		item["visibility"] = "hide"
	}

	contextWindow := catalogInt(item, "context_window")
	if contextWindow <= 0 {
		contextWindow = codexCatalogContextWindow
		item["context_window"] = contextWindow
	}
	maxContext := catalogInt(item, "max_context_window")
	if maxContext < contextWindow {
		item["max_context_window"] = contextWindow
	}
	if catalogInt(item, "max_output_tokens") <= 0 {
		item["max_output_tokens"] = codexCatalogMaxOutput
	}
	if priority > 0 {
		item["priority"] = priority
	} else if catalogInt(item, "priority") <= 0 {
		item["priority"] = 100
	}

	defaults := map[string]any{
		"supported_reasoning_levels": codexReasoningLevels(),
		"default_reasoning_level":    codexDefaultReasoning,
		"default_reasoning_summary":  "auto", "shell_type": "shell_command",
		"supported_in_api": true, "minimal_client_version": codexMinimalClientVersion,
		"base_instructions": codexBaseInstructions, "upgrade": nil, "availability_nux": nil,
		"default_verbosity": "low", "truncation_policy": map[string]any{"mode": "tokens", "limit": 10000},
		"experimental_supported_tools": []any{}, "apply_patch_tool_type": "freeform",
		"web_search_tool_type": "text_and_image", "multi_agent_version": "v2",
		"supports_parallel_tool_calls": true, "supports_image_detail_original": true,
		"supports_search_tool": true, "support_verbosity": true, "supports_reasoning_summary_parameter": true,
		"include_skills_usage_instructions": true, "include_plugin_usage_instructions": true,
		"include_apps_usage_instructions": true, "prefer_websockets": true,
		"input_modalities": []any{"text", "image"},
	}
	for key, value := range defaults {
		if _, supplied := item[key]; !supplied {
			item[key] = value
		}
	}
}

func codexReasoningLevels() []any {
	return []any{
		map[string]any{"effort": "none", "description": "Fastest responses with limited reasoning"},
		map[string]any{"effort": "low", "description": "Fast responses with lighter reasoning"},
		map[string]any{"effort": "medium", "description": "Balances speed and reasoning depth for everyday tasks"},
		map[string]any{"effort": "high", "description": "Greater reasoning depth for complex problems"},
	}
}

func isCodexImageOnlySlug(slug string) bool {
	slug = strings.ToLower(strings.TrimSpace(slug))
	return strings.HasPrefix(slug, "gpt-image") || strings.HasPrefix(slug, "grok-imagine")
}

func codexDisplayName(slug string) string {
	slug = strings.TrimSpace(slug)
	if slug == "" {
		return slug
	}
	parts := strings.Split(slug, "-")
	for i, part := range parts {
		if part == "" {
			continue
		}
		switch strings.ToLower(part) {
		case "gpt":
			parts[i] = "GPT"
		case "qwen":
			parts[i] = "Qwen"
		case "kimi":
			parts[i] = "Kimi"
		case "grok":
			parts[i] = "Grok"
		default:
			if unicode.IsDigit(rune(part[0])) {
				continue
			}
			parts[i] = strings.ToUpper(part[:1]) + part[1:]
		}
	}
	return strings.Join(parts, " ")
}

func catalogString(item map[string]any, key string) string {
	value, _ := item[key].(string)
	return strings.TrimSpace(value)
}

func catalogInt(item map[string]any, key string) int {
	switch value := item[key].(type) {
	case int:
		return value
	case int64:
		return int(value)
	case float64:
		return int(value)
	default:
		return 0
	}
}
