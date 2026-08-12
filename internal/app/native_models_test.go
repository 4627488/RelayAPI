package app

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/4627488/RelayAPI/internal/store"
	"github.com/router-for-me/CLIProxyAPI/v7/relaybridge"
)

func TestFilterModelCatalogPreservesEnvelopeFormats(t *testing.T) {
	claudeCloaked := "claude-fable-5-dd-" + reverseString("public-model")
	tests := []struct {
		name    string
		payload string
		key     string
		wantID  string
	}{
		{"openai", `{"object":"list","data":[{"id":"public-model"},{"id":"private-model"}]}`, "data", "public-model"},
		{"anthropic", `{"data":[{"id":"` + claudeCloaked + `"},{"id":"claude-private"}],"has_more":true}`, "data", claudeCloaked},
		{"codex", `{"models":[{"slug":"public-model"},{"slug":"private-model"}]}`, "models", "public-model"},
		{"gemini", `{"models":[{"name":"models/public-model"},{"name":"models/private-model"}]}`, "models", "models/public-model"},
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
		{"slug":"claude-sonnet","display_name":"Claude Sonnet","visibility":"list"}
	]}`)
	filtered, err := filterModelCatalog(payload, []string{"grok-4.5"})
	if err != nil {
		t.Fatal(err)
	}
	expanded, err := addCodexModelAliases(filtered, []store.APIKeyModelAlias{
		{Alias: "gpt-5.6-sol", Model: "grok-4.5"},
		{Alias: "missing", Model: "claude-sonnet"},
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
	app := newEmbeddedCPATestApp(t, relaybridge.Credential{
		ID: "codex-catalog", Provider: "codex", Enabled: true,
		Models:   []string{"grok-4.5", "subscription-model", "private-model"},
		Document: []byte(`{"type":"codex","access_token":"test-token"}`),
	})
	request := httptest.NewRequest(http.MethodGet, "/v1/models?client_version=0.147.0", nil)
	request.Header.Set("User-Agent", "codex-tui/0.147.0")
	recorder := httptest.NewRecorder()
	key := store.KeyContext{TenantModels: []string{"grok-4.5"}}
	key.ModelAllowlist = []string{"grok-4.5", "subscription-model"}
	key.SubscriptionModelGrants = []store.SubscriptionModelGrant{{CPAModels: []string{"subscription-model"}}}
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
	if len(items) != 3 {
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
	if got["private-model"] != nil {
		t.Fatal("catalog exposed a model outside the key and tenant allowlists")
	}
	if got["gpt-5.6-sol"]["context_window"] != got["grok-4.5"]["context_window"] {
		t.Fatal("alias did not inherit target model metadata")
	}
}

func TestResolveClaudeCatalogModel(t *testing.T) {
	cloaked := "claude-fable-5-dd-" + reverseString("public-model")
	if got := resolveClaudeCatalogModel(cloaked); got != "public-model" {
		t.Fatalf("resolved = %q", got)
	}
	if got := resolveClaudeCatalogModel(cloaked + "(high)"); got != "public-model(high)" {
		t.Fatalf("resolved thinking model = %q", got)
	}
}
