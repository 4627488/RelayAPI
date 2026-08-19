package upstream

import "testing"

func TestNewCodexCatalogItemFillsModelInfoRequiredByClient(t *testing.T) {
	item := NewCodexCatalogItem("grok-4.5")
	if item["slug"] != "grok-4.5" || item["display_name"] != "Grok 4.5" {
		t.Fatalf("identity = %#v", item)
	}
	if item["visibility"] != "list" || item["supported_in_api"] != true {
		t.Fatalf("picker fields = %#v", item)
	}
	if item["shell_type"] != "shell_command" || item["default_reasoning_level"] != "medium" {
		t.Fatalf("agent fields = %#v", item)
	}
	levels, _ := item["supported_reasoning_levels"].([]any)
	if len(levels) != 4 {
		t.Fatalf("supported_reasoning_levels = %#v", levels)
	}
	if item["max_context_window"] != item["context_window"] || item["context_window"] != 262144 {
		t.Fatalf("context windows = %#v %#v", item["context_window"], item["max_context_window"])
	}
	if item["base_instructions"] != codexBaseInstructions {
		t.Fatal("missing base_instructions")
	}
	if item["apply_patch_tool_type"] != "freeform" || item["prefer_websockets"] != true {
		t.Fatalf("agent surface = %#v", item)
	}
	policy, _ := item["truncation_policy"].(map[string]any)
	if policy["mode"] != "tokens" || policy["limit"] != 10000 {
		t.Fatalf("truncation_policy = %#v", policy)
	}
}

func TestCompleteCodexCatalogItemHidesImageOnlySlugsAndPreservesContext(t *testing.T) {
	item := map[string]any{"slug": "gpt-image-1.5", "visibility": "list", "context_window": 4096}
	CompleteCodexCatalogItem(item, 30)
	if item["visibility"] != "hide" {
		t.Fatalf("image model visibility = %#v", item["visibility"])
	}
	if item["context_window"] != 4096 || item["max_context_window"] != 4096 {
		t.Fatalf("context was overwritten: %#v", item)
	}
	if item["priority"] != 30 {
		t.Fatalf("priority = %#v", item["priority"])
	}
}

func TestCodexDisplayNameTitleCasesKnownFamilies(t *testing.T) {
	tests := map[string]string{
		"gpt-5.4":     "GPT 5.4",
		"kimi-k2.5":   "Kimi K2.5",
		"qwen-max":    "Qwen Max",
		"grok-4.5":    "Grok 4.5",
		"custom-chat": "Custom Chat",
	}
	for slug, want := range tests {
		if got := codexDisplayName(slug); got != want {
			t.Fatalf("%s: got %q want %q", slug, got, want)
		}
	}
}
