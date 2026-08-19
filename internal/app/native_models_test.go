package app

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/4627488/RelayAPI/internal/store"
	"github.com/4627488/RelayAPI/internal/upstream"
)

func TestFilterModelCatalogPreservesEnvelopeFormats(t *testing.T) {
	tests := []struct {
		name    string
		payload string
		key     string
		wantID  string
	}{
		{"openai", `{"object":"list","data":[{"id":"public-model"},{"id":"private-model"}]}`, "data", "public-model"},
		{"codex", `{"models":[{"slug":"public-model"},{"slug":"private-model"}]}`, "models", "public-model"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			payload, err := filterModelCatalog([]byte(test.payload), []string{"public-model"})
			if err != nil {
				t.Fatal(err)
			}
			var document map[string]any
			if err := json.Unmarshal(payload, &document); err != nil {
				t.Fatal(err)
			}
			items, _ := document[test.key].([]any)
			if len(items) != 1 {
				t.Fatalf("items = %#v", items)
			}
			item, _ := items[0].(map[string]any)
			if got := catalogModelID(item); got != test.wantID {
				t.Fatalf("id = %q, want %q", got, test.wantID)
			}
		})
	}
}

func TestAddCodexModelAliases(t *testing.T) {
	payload := []byte(`{"models":[
		{"slug":"grok-4.5","display_name":"Grok 4.5","context_window":131072,"visibility":"list"},
		{"slug":"qwen-max","display_name":"Qwen Max","visibility":"list"}
	]}`)
	filtered, err := filterModelCatalog(payload, []string{"grok-4.5"})
	if err != nil {
		t.Fatal(err)
	}
	expanded, err := addCodexModelAliases(filtered, []store.APIKeyModelAlias{
		{Alias: "gpt-5.6-sol", Model: "grok-4.5"},
		{Alias: "missing", Model: "qwen-max"},
	})
	if err != nil {
		t.Fatal(err)
	}
	var document map[string]any
	if err := json.Unmarshal(expanded, &document); err != nil {
		t.Fatal(err)
	}
	items, _ := document["models"].([]any)
	if len(items) != 2 {
		t.Fatalf("items = %#v", items)
	}
	alias, _ := items[1].(map[string]any)
	if got := catalogModelID(alias); got != "gpt-5.6-sol" {
		t.Fatalf("alias slug = %q", got)
	}
	if got := alias["context_window"]; got != float64(131072) {
		t.Fatalf("alias context_window = %#v", got)
	}
	if got := alias["description"]; got != "RelayAPI 模型别名，映射到 grok-4.5" {
		t.Fatalf("alias description = %#v", got)
	}
}

func TestFilterCodexCatalogHidesDeniedModelsInsteadOfDroppingThem(t *testing.T) {
	payload := []byte(`{"models":[
		{"slug":"public-model","visibility":"list","context_window":1000},
		{"slug":"private-model","visibility":"list","context_window":2000}
	]}`)
	filtered, err := filterModelCatalogForClient(payload, []string{"public-model"}, true)
	if err != nil {
		t.Fatal(err)
	}
	var document map[string]any
	if err := json.Unmarshal(filtered, &document); err != nil {
		t.Fatal(err)
	}
	items, _ := document["models"].([]any)
	if len(items) != 2 {
		t.Fatalf("items = %#v", items)
	}
	private, _ := items[1].(map[string]any)
	if private["visibility"] != "hide" {
		t.Fatalf("private model visibility = %#v, want hide", private["visibility"])
	}
	if private["context_window"] != float64(2000) {
		t.Fatal("hidden override discarded capability metadata")
	}
}

func TestPromoteCodexCatalogCapabilitiesAdvertisesFullAgentSurface(t *testing.T) {
	payload := []byte(`{"models":[{"slug":"qwen-max","visibility":"list"},{"slug":"private","visibility":"hide"}]}`)
	promoted, err := promoteCodexCatalogCapabilities(payload)
	if err != nil {
		t.Fatal(err)
	}
	var document map[string]any
	if err := json.Unmarshal(promoted, &document); err != nil {
		t.Fatal(err)
	}
	items := document["models"].([]any)
	model := items[0].(map[string]any)
	if model["apply_patch_tool_type"] != "freeform" || model["web_search_tool_type"] != "text_and_image" || model["multi_agent_version"] != "v2" {
		t.Fatalf("full Codex capabilities were not advertised: %#v", model)
	}
	for _, key := range []string{"supports_parallel_tool_calls", "supports_image_detail_original", "supports_search_tool", "support_verbosity", "supports_reasoning_summary_parameter", "prefer_websockets"} {
		if model[key] != true {
			t.Fatalf("%s = %#v, want true", key, model[key])
		}
	}
	hidden := items[1].(map[string]any)
	if _, exists := hidden["apply_patch_tool_type"]; exists {
		t.Fatalf("hidden tombstone was promoted: %#v", hidden)
	}
}

func TestModelCatalogRevisionIsStableAndPermissionScoped(t *testing.T) {
	first := store.KeyContext{
		APIKey: store.APIKey{
			ModelAllowlist: []string{"model-b", "model-a"},
			ModelAliases:   []store.APIKeyModelAlias{{Alias: "alias-b", Model: "model-b"}, {Alias: "alias-a", Model: "model-a"}},
		},
	}
	second := first
	second.ModelAliases = []store.APIKeyModelAlias{{Alias: "alias-a", Model: "model-a"}, {Alias: "alias-b", Model: "model-b"}}
	left := modelCatalogRevision(first, []string{"model-b", "private", "model-a"}, "")
	right := modelCatalogRevision(second, []string{"model-a", "model-b", "private"}, "")
	if left != right {
		t.Fatalf("equivalent catalogs produced different revisions: %q != %q", left, right)
	}
	if !etagMatches("W/"+left, left) {
		t.Fatal("weak If-None-Match value did not match the current revision")
	}
	second.ModelAliases = append(second.ModelAliases, store.APIKeyModelAlias{Alias: "new", Model: "model-a"})
	if changed := modelCatalogRevision(second, []string{"model-a", "model-b", "private"}, ""); changed == left {
		t.Fatal("alias change did not invalidate the catalog revision")
	}
}

func TestRetiredProtocolPathsAreRejectedBeforeAuthentication(t *testing.T) {
	for _, path := range []string{"/v1/messages", "/v1/messages/count_tokens", "/v1beta/models/gemini:generateContent"} {
		t.Run(path, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodPost, path, nil)
			recorder := httptest.NewRecorder()
			new(App).proxy(recorder, request)
			if recorder.Code != http.StatusNotFound {
				t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
			}
			var payload map[string]any
			if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
				t.Fatal(err)
			}
			errorObject, _ := payload["error"].(map[string]any)
			if errorObject["code"] != "unsupported_protocol" {
				t.Fatalf("error = %#v", payload)
			}
		})
	}
}

func TestAddCodexModelAliasesReplacesCollidingCatalogEntry(t *testing.T) {
	payload := []byte(`{"models":[
		{"slug":"gpt-5.6-sol","display_name":"GPT-5.6 Sol","context_window":1000},
		{"slug":"grok-4.5","display_name":"Grok 4.5","context_window":2000}
	]}`)
	expanded, err := addCodexModelAliases(payload, []store.APIKeyModelAlias{{Alias: "gpt-5.6-sol", Model: "grok-4.5"}})
	if err != nil {
		t.Fatal(err)
	}
	var document map[string]any
	if err := json.Unmarshal(expanded, &document); err != nil {
		t.Fatal(err)
	}
	items, _ := document["models"].([]any)
	if len(items) != 2 {
		t.Fatalf("items = %#v", items)
	}
	alias, _ := items[0].(map[string]any)
	if got := alias["context_window"]; got != float64(2000) {
		t.Fatalf("colliding alias did not inherit target metadata: %#v", alias)
	}
}

func TestProxyNativeModelsReturnsAuthorizedCodexCatalogAndAliases(t *testing.T) {
	app := newNativeRuntimeTestApp(t, upstream.Credential{
		ID: "codex-catalog", Provider: "codex", Enabled: true,
		Models:   []string{"grok-4.5", "subscription-model", "private-model"},
		Document: []byte(`{"type":"codex","access_token":"test-token"}`),
	})
	request := httptest.NewRequest(http.MethodGet, "/v1/models?client_version=0.147.0", nil)
	request.Header.Set("User-Agent", "codex-tui/0.147.0")
	recorder := httptest.NewRecorder()
	key := store.KeyContext{TenantModels: []string{"grok-4.5"}}
	key.ModelAllowlist = []string{"grok-4.5", "subscription-model"}
	key.SubscriptionModelGrants = []store.SubscriptionModelGrant{{UpstreamModels: []string{"subscription-model"}}}
	key.ModelAliases = []store.APIKeyModelAlias{{Alias: "gpt-5.6-sol", Model: "grok-4.5"}}

	app.proxyNativeModels(recorder, request, key)

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	var document map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &document); err != nil {
		t.Fatal(err)
	}
	items, _ := document["models"].([]any)
	if len(items) != 4 {
		t.Fatalf("items = %#v", items)
	}
	got := make(map[string]map[string]any, len(items))
	for _, raw := range items {
		item, _ := raw.(map[string]any)
		got[catalogModelID(item)] = item
	}
	if got["grok-4.5"] == nil || got["gpt-5.6-sol"] == nil || got["subscription-model"] == nil {
		t.Fatalf("catalog slugs = %#v", got)
	}
	if got["private-model"] == nil || got["private-model"]["visibility"] != "hide" {
		t.Fatal("catalog did not hide the model outside the key and tenant allowlists")
	}
	if got["gpt-5.6-sol"]["context_window"] != got["grok-4.5"]["context_window"] {
		t.Fatal("alias did not inherit target model metadata")
	}
	if recorder.Header().Get("ETag") == "" {
		t.Fatal("Codex model catalog did not include an ETag")
	}
}
